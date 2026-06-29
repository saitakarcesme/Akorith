import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { listProjects } from './db'

// Phase 33.17: a strictly READ-ONLY git surface for the bottom workbench's
// Changes panel. It never stages, commits, pushes, or mutates the repo — only
// `status`, `diff --stat`, and `rev-parse` are run, each bounded by a timeout
// and output cap. The target path must belong to a project Akorith manages.

export interface GitChangeFile {
  status: string
  path: string
}

export type GitStatusResult =
  | { ok: true; isRepo: true; branch: string; files: GitChangeFile[]; truncated: boolean; stat: string; clean: boolean }
  | { ok: true; isRepo: false }
  | { ok: false; error: string }

const GIT_TIMEOUT_MS = 4_000
const MAX_BUFFER = 512 * 1024
const MAX_FILES = 200

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
    const path = line.slice(3).trim()
    if (path) files.push({ status, path })
  }
  return { files, truncated: lines.length > files.length }
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
}
