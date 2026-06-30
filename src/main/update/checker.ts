import { execFile } from 'child_process'
import { app } from 'electron'
import type { UpdateStatus } from './types'

// Phase 39: read-only update detection. Every git call is bounded and uses no shell.

const GIT_TIMEOUT_MS = 25_000
const MAX_BUFFER = 1024 * 1024

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

export function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ ok: !err, stdout: (stdout ?? '').trim(), stderr: (stderr ?? '').trim(), code })
    })
  })
}

/** Strip any embedded credentials from a remote URL before it reaches the UI/logs. */
export function maskRemoteUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//')
}

/** The directory we run git in — the app path (the repo root in a dev/source run). */
export function repoRoot(): string {
  return app.getAppPath()
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const res = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  return res.ok && res.stdout === 'true'
}

export async function getUpdateStatus(fetch: boolean): Promise<UpdateStatus> {
  const appVersion = app.getVersion()
  const cwd = repoRoot()

  if (!(await isGitRepo(cwd))) {
    return {
      mode: 'packaged',
      appVersion,
      behindBy: 0,
      aheadBy: 0,
      hasUpdate: false,
      isDirty: false,
      dirtyFiles: [],
      safeToUpdate: false,
      warnings: [
        'This Akorith is not running from a git checkout, so the source updater does not apply. Packaged release updates are planned for a later phase.'
      ],
      lastCheckedAt: Date.now()
    }
  }

  const toplevel = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).stdout || cwd
  const warnings: string[] = []

  if (fetch) {
    const fetched = await runGit(toplevel, ['fetch', 'origin', '--quiet'], 60_000)
    if (!fetched.ok) warnings.push(`Could not reach origin: ${maskRemoteUrl(fetched.stderr) || 'fetch failed'}`)
  }

  const branch = (await runGit(toplevel, ['branch', '--show-current'])).stdout || 'HEAD'
  const headFull = (await runGit(toplevel, ['rev-parse', 'HEAD'])).stdout
  const headShort = (await runGit(toplevel, ['rev-parse', '--short', 'HEAD'])).stdout
  const remoteMainFull = (await runGit(toplevel, ['rev-parse', 'origin/main'])).stdout
  const remoteMainShort = (await runGit(toplevel, ['rev-parse', '--short', 'origin/main'])).stdout
  const remoteUrlRaw = (await runGit(toplevel, ['remote', 'get-url', 'origin'])).stdout
  const statusShort = (await runGit(toplevel, ['status', '--porcelain'])).stdout
  const dirtyFiles = statusShort ? statusShort.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 50) : []
  const isDirty = dirtyFiles.length > 0

  // left-right count of HEAD...origin/main → "<ahead>\t<behind>"
  let aheadBy = 0
  let behindBy = 0
  if (remoteMainFull) {
    const counts = await runGit(toplevel, ['rev-list', '--left-right', '--count', 'HEAD...origin/main'])
    if (counts.ok) {
      const [a, b] = counts.stdout.split(/\s+/).map((n) => Number(n))
      aheadBy = Number.isFinite(a) ? a : 0
      behindBy = Number.isFinite(b) ? b : 0
    }
  } else {
    warnings.push('origin/main was not found. Fetch from origin, or check the remote configuration.')
  }

  const hasUpdate = behindBy > 0
  if (isDirty) warnings.push('Your working tree has local changes. The updater will not touch them — commit or stash before updating.')
  if (aheadBy > 0) warnings.push(`Your branch is ${aheadBy} commit(s) ahead of origin/main — those are not pushed.`)

  const safeToUpdate = Boolean(remoteMainFull) && hasUpdate && !isDirty

  return {
    mode: 'git',
    repoPath: toplevel,
    currentBranch: branch,
    currentCommit: headShort,
    currentCommitFull: headFull,
    remoteMainCommit: remoteMainShort,
    remoteUrl: maskRemoteUrl(remoteUrlRaw),
    behindBy,
    aheadBy,
    hasUpdate,
    isDirty,
    dirtyFiles,
    safeToUpdate,
    warnings,
    lastCheckedAt: Date.now(),
    appVersion
  }
}
