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
const RELEASE_API = 'https://api.github.com/repos/saitakarcesme/Akorith/releases/latest'
const RELEASE_TIMEOUT_MS = 12_000
const RELEASE_CACHE_MS = 5 * 60_000

export interface ReleaseAsset {
  name: string
  url: string
  size: number
  digest?: string
}

export interface LatestRelease {
  version: string
  tag: string
  url: string
  publishedAt?: string
  asset?: ReleaseAsset
}

let cachedRelease: { value: LatestRelease | null; checkedAt: number } | null = null

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

function versionParts(value: string): number[] {
  return value.replace(/^v/i, '').split(/[+-]/)[0].split('.').map((part) => Number(part) || 0)
}

export function versionIsNewer(candidate: string, current: string): boolean {
  const left = versionParts(candidate)
  const right = versionParts(current)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

function assetForCurrentMac(assets: Array<Record<string, unknown>>): ReleaseAsset | undefined {
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  const candidates = assets.filter((asset) => {
    const name = typeof asset.name === 'string' ? asset.name.toLowerCase() : ''
    return name.endsWith('.zip') && name.includes('mac') && name.includes(architecture)
  })
  const asset = candidates[0]
  if (!asset || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') return undefined
  return {
    name: asset.name,
    url: asset.browser_download_url,
    size: typeof asset.size === 'number' ? asset.size : 0,
    ...(typeof asset.digest === 'string' ? { digest: asset.digest } : {})
  }
}

export async function fetchLatestRelease(force = false): Promise<LatestRelease | null> {
  if (!force && cachedRelease && Date.now() - cachedRelease.checkedAt < RELEASE_CACHE_MS) return cachedRelease.value
  try {
    const response = await fetch(RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `Akorith/${app.getVersion()}`
      },
      signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS)
    })
    if (!response.ok) {
      cachedRelease = { value: null, checkedAt: Date.now() }
      return null
    }
    const raw = await response.json() as Record<string, unknown>
    const tag = typeof raw.tag_name === 'string' ? raw.tag_name : ''
    const version = tag.replace(/^v/i, '')
    if (!tag || !version) return null
    const release: LatestRelease = {
      version,
      tag,
      url: typeof raw.html_url === 'string' ? raw.html_url : 'https://github.com/saitakarcesme/Akorith/releases',
      ...(typeof raw.published_at === 'string' ? { publishedAt: raw.published_at } : {}),
      ...(Array.isArray(raw.assets) ? { asset: assetForCurrentMac(raw.assets as Array<Record<string, unknown>>) } : {})
    }
    cachedRelease = { value: release, checkedAt: Date.now() }
    return release
  } catch {
    cachedRelease = { value: null, checkedAt: Date.now() }
    return null
  }
}

async function packagedMacStatus(force: boolean): Promise<UpdateStatus> {
  const appVersion = app.getVersion()
  const latest = await fetchLatestRelease(force)
  const hasUpdate = Boolean(latest && versionIsNewer(latest.version, appVersion))
  const asset = latest?.asset
  const warnings: string[] = []
  if (!latest) warnings.push('GitHub Releases could not be reached, or no stable release exists yet.')
  if (hasUpdate && !asset) warnings.push(`Release ${latest?.tag ?? ''} has no macOS ${process.arch} zip asset.`)
  return {
    mode: 'packaged',
    runtimeMode: 'packaged-macos',
    platform: process.platform,
    executablePath: process.execPath,
    appPath: app.getAppPath(),
    appVersion,
    behindBy: 0,
    aheadBy: 0,
    hasUpdate,
    isDirty: false,
    dirtyFiles: [],
    safeToUpdate: Boolean(hasUpdate && asset),
    canUpdateInstalledApp: Boolean(hasUpdate && asset),
    updateTarget: 'Installed macOS app from GitHub Releases',
    relaunchTarget: process.execPath,
    warnings,
    lastCheckedAt: Date.now(),
    ...(latest ? {
      releaseVersion: latest.version,
      releaseTag: latest.tag,
      releaseUrl: latest.url,
      releasePublishedAt: latest.publishedAt,
      releaseAssetName: asset?.name,
      releaseAssetUrl: asset?.url,
      releaseAssetSize: asset?.size,
      releaseAssetDigest: asset?.digest
    } : {})
  }
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
  if (app.isPackaged && process.platform === 'darwin') return packagedMacStatus(fetch)
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
