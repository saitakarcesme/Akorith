import { ipcMain, shell } from 'electron'
import { execFile } from 'child_process'
import { readFile, stat } from 'fs/promises'
import { devNull } from 'os'
import { isAbsolute, resolve, sep } from 'path'
import { listProjects } from './db'

// Project-scoped git surface for the Changes panel. It can inspect a bounded
// diff and explicitly stage/unstage one selected file; it never edits content,
// commits, pushes, or touches paths outside a project Akorith manages.

export interface GitChangeFile {
  status: string
  path: string
  staged: boolean
  additions: number
  deletions: number
}

export interface GitChangeSummaryFile extends GitChangeFile {}

export interface GitChangeSummary {
  files: GitChangeSummaryFile[]
  additions: number
  deletions: number
  truncated: boolean
}

export type GitStatusResult =
  | { ok: true; isRepo: true; branch: string; files: GitChangeFile[]; truncated: boolean; stat: string; clean: boolean }
  | { ok: true; isRepo: false }
  | { ok: false; error: string }

const GIT_TIMEOUT_MS = 4_000
const MAX_BUFFER = 512 * 1024
const MAX_FILES = 200
const MAX_DIFF_CHARS = 220_000
// Git for Windows understands the DOS device name, while Node's `os.devNull`
// resolves to `\\.\nul`, which `git diff --no-index` rejects as a path.
const GIT_EMPTY_FILE = process.platform === 'win32' ? 'NUL' : devNull

function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

/** Only allow paths that exactly match a known Akorith project folder. */
function isManagedPath(path: string): boolean {
  if (typeof path !== 'string' || !path) return false
  return listProjects().some((project) => project.path && project.path === path)
}

function parsePorcelain(stdout: string): { files: GitChangeFile[]; truncated: boolean } {
  const records = stdout.split('\0')
  const files: GitChangeFile[] = []
  let recordCount = 0
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    recordCount += 1
    if (files.length >= MAX_FILES) break
    // `--porcelain=v1 -z` keeps filenames literal. Rename/copy records put
    // the destination first and the origin in the following NUL field.
    const xy = record.slice(0, 2)
    const status = xy.trim() || '?'
    const path = record.slice(3)
    if (/[RC]/.test(xy)) index += 1
    if (path) {
      files.push({
        status,
        path,
        staged: xy[0] !== ' ' && xy[0] !== '?',
        additions: 0,
        deletions: 0
      })
    }
  }
  return { files, truncated: recordCount > files.length }
}

function parseNumstat(stdout: string): Map<string, { additions: number; deletions: number }> {
  const counts = new Map<string, { additions: number; deletions: number }>()
  for (const record of stdout.split('\0')) {
    if (!record) continue
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]+)$/.exec(record)
    if (!match) continue
    const [, rawAdditions, rawDeletions, filePath] = match
    const previous = counts.get(filePath) ?? { additions: 0, deletions: 0 }
    counts.set(filePath, {
      additions: previous.additions + (Number.isFinite(Number(rawAdditions)) ? Number(rawAdditions) : 0),
      deletions: previous.deletions + (Number.isFinite(Number(rawDeletions)) ? Number(rawDeletions) : 0)
    })
  }
  return counts
}

function boundedDiff(stdout: string): string {
  if (stdout.length <= MAX_DIFF_CHARS) return stdout
  const slice = stdout.slice(0, MAX_DIFF_CHARS)
  const boundary = slice.lastIndexOf('\n')
  const completeLines = boundary > 0 ? slice.slice(0, boundary) : slice
  return `${completeLines}\n[Akorith] Diff truncated to ${MAX_DIFF_CHARS.toLocaleString('en-US')} characters.\n`
}

function safeFile(root: string, filePath: string): string | null {
  if (!filePath || isAbsolute(filePath) || /[\0\r\n]/.test(filePath)) return null
  const target = resolve(root, filePath)
  const base = resolve(root)
  return target.startsWith(`${base}${sep}`) ? target : null
}

async function untrackedLineCount(root: string, filePath: string): Promise<number> {
  const target = safeFile(root, filePath)
  if (!target) return 0
  try {
    const info = await stat(target)
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return 0
    const content = await readFile(target, 'utf8')
    return content ? content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0) : 0
  } catch {
    return 0
  }
}

/** A bounded, read-only snapshot used to build the completed Workspace card. */
export async function summarizeGitChanges(path: string): Promise<GitChangeSummary | null> {
  if (!isManagedPath(path)) return null
  const inside = await runGit(path, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') return null

  const [statusResult, headNumstat] = await Promise.all([
    runGit(path, ['status', '--porcelain=v1', '-z']),
    runGit(path, ['diff', 'HEAD', '--numstat', '-z', '--no-renames'])
  ])
  let numstatOutput = headNumstat.stdout
  if (!headNumstat.ok) {
    const [cached, working] = await Promise.all([
      runGit(path, ['diff', '--cached', '--numstat', '-z', '--no-renames']),
      runGit(path, ['diff', '--numstat', '-z', '--no-renames'])
    ])
    numstatOutput = `${cached.stdout}${working.stdout}`
  }
  const parsed = parsePorcelain(statusResult.stdout)
  const counts = parseNumstat(numstatOutput)

  const files = await Promise.all(parsed.files.map(async (file): Promise<GitChangeSummaryFile> => {
    const tracked = counts.get(file.path)
    const additions = tracked?.additions ?? (file.status.includes('?') ? await untrackedLineCount(path, file.path) : 0)
    return { ...file, additions, deletions: tracked?.deletions ?? 0 }
  }))
  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    truncated: parsed.truncated
  }
}

export function changedSince(
  before: GitChangeSummary | null,
  after: GitChangeSummary | null
): GitChangeSummary | undefined {
  if (!after) return undefined
  const baseline = new Map((before?.files ?? []).map((file) => [file.path, `${file.status}:${file.additions}:${file.deletions}`]))
  const files = after.files.filter((file) => baseline.get(file.path) !== `${file.status}:${file.additions}:${file.deletions}`)
  if (!files.length) return undefined
  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    truncated: after.truncated
  }
}

async function gitDiff(path: string, filePath: string): Promise<{ ok: true; diff: string } | { ok: false; error: string }> {
  if (!isManagedPath(path) || !safeFile(path, filePath)) return { ok: false, error: 'Invalid project file.' }
  const status = await runGit(path, ['status', '--porcelain=v1', '-z', '--', filePath])
  const code = status.stdout.slice(0, 2)
  let result
  if (code === '??') {
    result = await runGit(path, ['diff', '--no-index', '--no-color', '--unified=3', '--', GIT_EMPTY_FILE, filePath])
  } else {
    result = await runGit(path, ['diff', 'HEAD', '--no-ext-diff', '--no-color', '--unified=3', '--', filePath])
    if (!result.stdout && !result.ok) {
      const [cached, working] = await Promise.all([
        runGit(path, ['diff', '--cached', '--no-color', '--unified=3', '--', filePath]),
        runGit(path, ['diff', '--no-color', '--unified=3', '--', filePath])
      ])
      result = { ok: cached.ok || working.ok, stdout: `${cached.stdout}${working.stdout}`, stderr: `${cached.stderr}${working.stderr}` }
    }
  }
  const diff = boundedDiff(result.stdout)
  return diff || result.ok ? { ok: true, diff } : { ok: false, error: result.stderr.trim().slice(-500) || 'Could not read diff.' }
}

async function setStaged(path: string, filePath: string, staged: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!isManagedPath(path) || !safeFile(path, filePath)) return { ok: false, error: 'Invalid project file.' }
  const result = staged
    ? await runGit(path, ['add', '--', filePath])
    : await runGit(path, ['restore', '--staged', '--', filePath])
  if (!result.ok && !staged) {
    const fallback = await runGit(path, ['reset', 'HEAD', '--', filePath])
    return fallback.ok ? { ok: true } : { ok: false, error: fallback.stderr.trim().slice(-500) || 'Could not unstage file.' }
  }
  return result.ok ? { ok: true } : { ok: false, error: result.stderr.trim().slice(-500) || 'Git operation failed.' }
}

async function gitStatus(path: string): Promise<GitStatusResult> {
  if (!isManagedPath(path)) {
    return { ok: false, error: 'This folder is not a tracked Akorith project.' }
  }
  const inside = await runGit(path, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ok: true, isRepo: false }
  }
  const [branchRes, statusRes, statRes, headNumstat] = await Promise.all([
    runGit(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(path, ['status', '--porcelain=v1', '-z']),
    runGit(path, ['diff', '--stat', '--no-color']),
    runGit(path, ['diff', 'HEAD', '--numstat', '-z', '--no-renames'])
  ])
  const parsed = parsePorcelain(statusRes.stdout)
  let numstatOutput = headNumstat.stdout
  if (!headNumstat.ok) {
    const [cached, working] = await Promise.all([
      runGit(path, ['diff', '--cached', '--numstat', '-z', '--no-renames']),
      runGit(path, ['diff', '--numstat', '-z', '--no-renames'])
    ])
    numstatOutput = `${cached.stdout}${working.stdout}`
  }
  const counts = parseNumstat(numstatOutput)
  const files = await Promise.all(parsed.files.map(async (file): Promise<GitChangeFile> => {
    const tracked = counts.get(file.path)
    return {
      ...file,
      additions: tracked?.additions ?? (file.status.includes('?') ? await untrackedLineCount(path, file.path) : 0),
      deletions: tracked?.deletions ?? 0
    }
  }))
  const stat = statRes.stdout.split('\n').slice(0, 60).join('\n').trim()
  return {
    ok: true,
    isRepo: true,
    branch: branchRes.stdout.trim() || 'HEAD',
    files,
    truncated: parsed.truncated,
    stat,
    clean: files.length === 0
  }
}

export function registerGitStatusIpc(): void {
  ipcMain.handle('git:status', async (_event, args: unknown): Promise<GitStatusResult> => {
    const path = args && typeof args === 'object' ? (args as { path?: unknown }).path : undefined
    if (typeof path !== 'string') return { ok: false, error: 'No project path.' }
    try {
      return await gitStatus(path)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('git:diff', async (_event, args: unknown) => {
    const input = args && typeof args === 'object' ? args as { path?: unknown; filePath?: unknown } : {}
    if (typeof input.path !== 'string' || typeof input.filePath !== 'string') return { ok: false, error: 'Invalid diff request.' }
    return gitDiff(input.path, input.filePath)
  })
  ipcMain.handle('git:setStaged', async (_event, args: unknown) => {
    const input = args && typeof args === 'object' ? args as { path?: unknown; filePath?: unknown; staged?: unknown } : {}
    if (typeof input.path !== 'string' || typeof input.filePath !== 'string' || typeof input.staged !== 'boolean') return { ok: false, error: 'Invalid git request.' }
    return setStaged(input.path, input.filePath, input.staged)
  })
  ipcMain.handle('git:revealFile', async (_event, args: unknown) => {
    const input = args && typeof args === 'object' ? args as { path?: unknown; filePath?: unknown } : {}
    if (typeof input.path !== 'string' || typeof input.filePath !== 'string') return false
    const target = isManagedPath(input.path) ? safeFile(input.path, input.filePath) : null
    if (!target) return false
    shell.showItemInFolder(target)
    return true
  })
}
