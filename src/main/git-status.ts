import { ipcMain, shell } from 'electron'
import { execFile } from 'child_process'
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
}

export type GitStatusResult =
  | { ok: true; isRepo: true; branch: string; files: GitChangeFile[]; truncated: boolean; stat: string; clean: boolean }
  | { ok: true; isRepo: false }
  | { ok: false; error: string }

const GIT_TIMEOUT_MS = 4_000
const MAX_BUFFER = 512 * 1024
const MAX_FILES = 200
const MAX_DIFF_CHARS = 220_000

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
  const lines = stdout.split('\n').filter((line) => line.length > 0)
  const files: GitChangeFile[] = []
  for (const line of lines) {
    if (files.length >= MAX_FILES) break
    // Porcelain v1: XY<space>path  (path may be "old -> new" for renames)
    const status = line.slice(0, 2).trim() || '?'
    const rawPath = line.slice(3).trim()
    // Porcelain v1 renders renames as "old -> new". Changes actions operate on
    // the destination path, never on the presentation string.
    const path = rawPath.includes(' -> ') ? rawPath.slice(rawPath.lastIndexOf(' -> ') + 4) : rawPath
    if (path) files.push({ status, path, staged: line[0] !== ' ' && line[0] !== '?' })
  }
  return { files, truncated: lines.length > files.length }
}

function safeFile(root: string, filePath: string): string | null {
  if (!filePath || isAbsolute(filePath) || /[\0\r\n]/.test(filePath)) return null
  const target = resolve(root, filePath)
  const base = resolve(root)
  return target.startsWith(`${base}${sep}`) ? target : null
}

async function gitDiff(path: string, filePath: string): Promise<{ ok: true; diff: string } | { ok: false; error: string }> {
  if (!isManagedPath(path) || !safeFile(path, filePath)) return { ok: false, error: 'Invalid project file.' }
  const status = await runGit(path, ['status', '--porcelain', '--', filePath])
  const code = status.stdout.slice(0, 2)
  let result
  if (code === '??') {
    result = await runGit(path, ['diff', '--no-index', '--no-color', '--unified=3', '--', devNull, filePath])
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
  const diff = result.stdout.slice(0, MAX_DIFF_CHARS)
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
  const [branchRes, statusRes, statRes] = await Promise.all([
    runGit(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(path, ['status', '--porcelain']),
    runGit(path, ['diff', '--stat', '--no-color'])
  ])
  const { files, truncated } = parsePorcelain(statusRes.stdout)
  const stat = statRes.stdout.split('\n').slice(0, 60).join('\n').trim()
  return {
    ok: true,
    isRepo: true,
    branch: branchRes.stdout.trim() || 'HEAD',
    files,
    truncated,
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
