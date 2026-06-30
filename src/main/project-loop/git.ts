import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { checkGitCommand } from '../safety'

// Phase 48: minimal git operations for a project loop, all bounded + safe. Push
// is intentionally NOT here — it goes through a separately-gated path.

const GIT_TIMEOUT = 30_000

function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout ?? '').toString().trim(), stderr: (stderr ?? '').toString().trim() })
    })
  })
}

export async function isRepo(cwd: string): Promise<boolean> {
  if (!existsSync(cwd)) return false
  return existsSync(join(cwd, '.git')) || (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).stdout === 'true'
}

/** Initialise a git repo (with an initial branch) if one does not exist. */
export async function ensureRepo(cwd: string): Promise<void> {
  if (await isRepo(cwd)) return
  await git(cwd, ['init', '-b', 'main'])
}

export async function hasChanges(cwd: string): Promise<boolean> {
  const res = await git(cwd, ['status', '--porcelain'])
  return res.ok && res.stdout.length > 0
}

export async function changedFileCount(cwd: string): Promise<number> {
  const res = await git(cwd, ['status', '--porcelain'])
  if (!res.ok || !res.stdout) return 0
  return res.stdout.split('\n').filter((l) => l.trim()).length
}

export async function currentSha(cwd: string): Promise<string | null> {
  const res = await git(cwd, ['rev-parse', 'HEAD'])
  return res.ok ? res.stdout : null
}

export interface LoopCommitResult {
  ok: boolean
  sha?: string
  filesChanged: number
  error?: string
}

/** Stage everything and commit with a message. Never runs forbidden git ops. */
export async function commitAll(cwd: string, message: string): Promise<LoopCommitResult> {
  const guard = checkGitCommand(`commit ${message}`)
  if (!guard.ok) return { ok: false, filesChanged: 0, error: guard.reason }
  if (!(await hasChanges(cwd))) return { ok: false, filesChanged: 0, error: 'no changes to commit' }
  const files = await changedFileCount(cwd)
  const add = await git(cwd, ['add', '-A'])
  if (!add.ok) return { ok: false, filesChanged: 0, error: add.stderr || 'git add failed' }
  const commit = await git(cwd, ['commit', '-m', message.slice(0, 500), '--no-verify'])
  if (!commit.ok) return { ok: false, filesChanged: 0, error: commit.stderr || 'git commit failed' }
  const sha = await currentSha(cwd)
  return { ok: true, sha: sha ?? undefined, filesChanged: files }
}
