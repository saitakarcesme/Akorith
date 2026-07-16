import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { checkGitCommand } from '../safety'
import { parseGitHubRepositoryUrl } from './github-url'

// Project Loop git operations are bounded to the selected repository. Push is
// allowed only after the stored GitHub URL matches origin exactly; never force.

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

export interface LoopRemoteResult {
  ok: boolean
  branch?: string
  error?: string
}

async function verifiedOrigin(cwd: string, expectedRepositoryUrl: string): Promise<LoopRemoteResult> {
  let expected
  try {
    expected = parseGitHubRepositoryUrl(expectedRepositoryUrl)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const remote = await git(cwd, ['remote', 'get-url', 'origin'])
  if (!remote.ok || !remote.stdout) return { ok: false, error: remote.stderr || 'The repository has no origin remote.' }
  let actual
  try {
    actual = parseGitHubRepositoryUrl(remote.stdout)
  } catch {
    return { ok: false, error: 'The origin remote is not a supported GitHub repository.' }
  }
  if (actual.owner.toLowerCase() !== expected.owner.toLowerCase() || actual.name.toLowerCase() !== expected.name.toLowerCase()) {
    return { ok: false, error: `Push blocked: origin is ${actual.slug}, but this Loop is linked to ${expected.slug}.` }
  }
  const branch = await git(cwd, ['branch', '--show-current'])
  if (!branch.ok || !branch.stdout) return { ok: false, error: 'Push blocked: the repository is in detached HEAD state.' }
  return { ok: true, branch: branch.stdout }
}

/** Fast-forward/rebase a clean linked clone before a new autonomous cycle. */
export async function syncFromOrigin(cwd: string, expectedRepositoryUrl: string): Promise<LoopRemoteResult> {
  const verified = await verifiedOrigin(cwd, expectedRepositoryUrl)
  if (!verified.ok || !verified.branch) return verified
  if (await hasChanges(cwd)) return { ok: false, error: 'GitHub sync stopped because the Loop workspace has uncommitted changes.' }
  const pull = await git(cwd, ['pull', '--rebase', 'origin', verified.branch])
  return pull.ok ? verified : { ok: false, error: pull.stderr || 'Could not synchronize the GitHub repository.' }
}

/** Push HEAD to the verified current branch. Rebase and retry once on concurrent updates. */
export async function pushToOrigin(cwd: string, expectedRepositoryUrl: string): Promise<LoopRemoteResult> {
  const verified = await verifiedOrigin(cwd, expectedRepositoryUrl)
  if (!verified.ok || !verified.branch) return verified
  const push = await git(cwd, ['push', 'origin', `HEAD:${verified.branch}`])
  if (push.ok) return verified
  const pull = await git(cwd, ['pull', '--rebase', 'origin', verified.branch])
  if (!pull.ok) return { ok: false, error: pull.stderr || push.stderr || 'GitHub rejected the push and Akorith could not rebase.' }
  const retry = await git(cwd, ['push', 'origin', `HEAD:${verified.branch}`])
  return retry.ok ? verified : { ok: false, error: retry.stderr || 'GitHub rejected the push.' }
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
