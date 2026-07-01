import { execFile } from 'child_process'
import { app } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getBuildInfo } from '../build-info'
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

function runtimeMode(isRepo: boolean): UpdateStatus['runtimeMode'] {
  if (app.isPackaged && process.platform === 'win32') return 'packaged-windows'
  if (app.isPackaged && process.platform === 'darwin') return 'packaged-macos'
  if (app.isPackaged) return 'packaged-other'
  return process.env['ELECTRON_RENDERER_URL'] ? 'dev' : isRepo ? 'source' : 'dev'
}

function expectedWindowsExe(): string | undefined {
  if (process.platform !== 'win32') return undefined
  const local = process.env['LOCALAPPDATA']
  return local ? join(local, 'Programs', 'Akorith', 'Akorith.exe') : undefined
}

async function findSourceCheckout(): Promise<string | undefined> {
  const candidates = [
    process.env['AKORITH_SOURCE_DIR'],
    join(homedir(), 'Desktop', 'akorith'),
    join(homedir(), 'Desktop', 'Akorith'),
    join(homedir(), 'Documents', 'akorith'),
    join(homedir(), 'Documents', 'Akorith')
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    if (await isGitRepo(candidate)) {
      const top = (await runGit(candidate, ['rev-parse', '--show-toplevel'])).stdout || candidate
      const remote = (await runGit(top, ['remote', 'get-url', 'origin'])).stdout
      if (/saitakarcesme\/Akorith/i.test(remote)) return top
    }
  }
  return undefined
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const res = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  return res.ok && res.stdout === 'true'
}

export async function getUpdateStatus(fetch: boolean): Promise<UpdateStatus> {
  const appVersion = app.getVersion()
  const cwd = repoRoot()
  const executablePath = process.execPath
  const appPath = cwd

  if (!(await isGitRepo(cwd))) {
    const sourceCheckoutPath = await findSourceCheckout()
    const build = getBuildInfo()
    let currentBranch: string | undefined
    let currentCommit: string | undefined
    let currentCommitFull: string | undefined
    let remoteMainCommit: string | undefined
    let remoteMainFull = ''
    let remoteUrl: string | undefined
    let behindBy = 0
    let aheadBy = 0
    let isDirty = false
    let dirtyFiles: string[] = []
    const packagedWarnings = [
      app.isPackaged
        ? 'This Akorith is running as a packaged app. Source-only updates are not treated as installed-app updates.'
        : 'This Akorith is not running from the Akorith git checkout.'
    ]
    if (!sourceCheckoutPath) {
      packagedWarnings.push('No Akorith source checkout was found. Set AKORITH_SOURCE_DIR or clone the repo to use the packaged Windows refresh flow.')
    } else {
      if (fetch) {
        const fetched = await runGit(sourceCheckoutPath, ['fetch', 'origin', '--quiet'], 60_000)
        if (!fetched.ok) packagedWarnings.push(`Could not reach origin from source checkout: ${maskRemoteUrl(fetched.stderr) || 'fetch failed'}`)
      }
      currentBranch = (await runGit(sourceCheckoutPath, ['branch', '--show-current'])).stdout || 'HEAD'
      currentCommitFull = (await runGit(sourceCheckoutPath, ['rev-parse', 'HEAD'])).stdout
      currentCommit = (await runGit(sourceCheckoutPath, ['rev-parse', '--short', 'HEAD'])).stdout
      remoteMainFull = (await runGit(sourceCheckoutPath, ['rev-parse', 'origin/main'])).stdout
      remoteMainCommit = (await runGit(sourceCheckoutPath, ['rev-parse', '--short', 'origin/main'])).stdout
      remoteUrl = maskRemoteUrl((await runGit(sourceCheckoutPath, ['remote', 'get-url', 'origin'])).stdout)
      const statusShort = (await runGit(sourceCheckoutPath, ['status', '--porcelain'])).stdout
      dirtyFiles = statusShort ? statusShort.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 50) : []
      isDirty = dirtyFiles.length > 0
      if (remoteMainFull) {
        const counts = await runGit(sourceCheckoutPath, ['rev-list', '--left-right', '--count', 'HEAD...origin/main'])
        if (counts.ok) {
          const [a, b] = counts.stdout.split(/\s+/).map((n) => Number(n))
          aheadBy = Number.isFinite(a) ? a : 0
          behindBy = Number.isFinite(b) ? b : 0
        }
      }
      if (isDirty) packagedWarnings.push('The source checkout has local changes. Packaged refresh will not update source until they are committed or stashed.')
    }
    const installedBuildCurrent = remoteMainFull
      ? build.gitCommitFull === remoteMainFull
      : currentCommitFull
        ? build.gitCommitFull === currentCommitFull
        : true
    const hasUpdate = Boolean(sourceCheckoutPath && (behindBy > 0 || !installedBuildCurrent))
    return {
      mode: 'packaged',
      runtimeMode: runtimeMode(false),
      platform: process.platform,
      executablePath,
      appPath,
      repoPath: sourceCheckoutPath,
      sourceCheckoutPath,
      currentBranch,
      currentCommit,
      currentCommitFull,
      remoteMainCommit,
      remoteUrl,
      appVersion,
      behindBy,
      aheadBy,
      hasUpdate,
      isDirty,
      dirtyFiles,
      safeToUpdate: false,
      canUpdateInstalledApp: Boolean(process.platform === 'win32' && sourceCheckoutPath && !isDirty),
      updateTarget: process.platform === 'win32' ? 'Installed Windows app via refresh-windows-app.ps1' : 'Packaged app (manual installer refresh required)',
      relaunchTarget: expectedWindowsExe(),
      warnings: packagedWarnings,
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
    runtimeMode: runtimeMode(true),
    platform: process.platform,
    executablePath,
    appPath,
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
    canUpdateInstalledApp: false,
    updateTarget: 'Source checkout only',
    relaunchTarget: executablePath,
    warnings,
    lastCheckedAt: Date.now(),
    appVersion
  }
}
