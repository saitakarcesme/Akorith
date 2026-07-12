import type {
  ElectronUpdaterLike,
  PackagedDownloadProgress,
  PackagedReleaseInfo,
  PackagedUpdateError,
  PackagedUpdaterRuntime,
  UpdateChannel,
  UpdaterSupport
} from './packaged-types'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const MAX_RELEASE_NAME = 160
const MAX_RELEASE_NOTES = 8_000
const MAX_ERROR_MESSAGE = 600

interface SemverParts {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function sanitizeUpdaterText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, '//***@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
    .replace(/\b(token|bearer|password|secret|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=***')
    .replace(/([?&](?:access_token|token|api_key|key)=)[^&#\s]+/gi, '$1***')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
  if (!clean) return undefined
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

export function parseUpdateChannel(value: unknown): UpdateChannel | undefined {
  return value === 'stable' || value === 'beta' ? value : undefined
}

export function parseSemver(value: unknown): SemverParts | undefined {
  if (typeof value !== 'string') return undefined
  const match = SEMVER.exec(value.trim())
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  }
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumber = /^\d+$/.test(a) ? Number(a) : undefined
    const bNumber = /^\d+$/.test(b) ? Number(b) : undefined
    if (aNumber !== undefined && bNumber !== undefined) return aNumber > bNumber ? 1 : -1
    if (aNumber !== undefined) return -1
    if (bNumber !== undefined) return 1
    return a > b ? 1 : -1
  }
  return 0
}

export function compareSemver(left: string, right: string): number | undefined {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) return undefined
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

export function supportForPackagedUpdater(
  runtime: PackagedUpdaterRuntime,
  updater: ElectronUpdaterLike | undefined
): UpdaterSupport {
  if (!runtime.isPackaged) {
    return { supported: false, code: 'DEVELOPMENT_BUILD', reason: 'Packaged updates are disabled in development and source-checkout runs.' }
  }
  if (runtime.platform !== 'win32' && runtime.platform !== 'darwin') {
    return { supported: false, code: 'UNSUPPORTED_PLATFORM', reason: `Packaged updates are not supported on ${runtime.platform}.` }
  }
  if (!parseSemver(runtime.appVersion)) {
    return { supported: false, code: 'INVALID_APP_VERSION', reason: 'The packaged application version is not valid semantic version metadata.' }
  }
  if (!updater) {
    return { supported: false, code: 'UPDATER_MODULE_MISSING', reason: 'This build does not include the electron-updater runtime.' }
  }
  if (!runtime.feedConfigured) {
    return { supported: false, code: 'UPDATE_FEED_MISSING', reason: 'This build has no configured update publication feed.' }
  }
  return { supported: true, code: 'SUPPORTED', reason: 'Packaged update checks are available.' }
}

function notesText(value: unknown): string | undefined {
  if (typeof value === 'string') return sanitizeUpdaterText(value, MAX_RELEASE_NOTES)
  if (!Array.isArray(value)) return undefined
  const notes = value
    .map((item) => {
      if (typeof item === 'string') return item
      const candidate = record(item)
      return typeof candidate?.['note'] === 'string' ? candidate['note'] : ''
    })
    .filter(Boolean)
    .join('\n')
  return sanitizeUpdaterText(notes, MAX_RELEASE_NOTES)
}

export function validateReleaseInfo(value: unknown): PackagedReleaseInfo | undefined {
  const candidate = record(value)
  const version = typeof candidate?.['version'] === 'string' ? candidate['version'].trim() : ''
  const parsed = parseSemver(version)
  if (!parsed) return undefined
  const releaseName = sanitizeUpdaterText(candidate?.['releaseName'], MAX_RELEASE_NAME)
  const releaseNotes = notesText(candidate?.['releaseNotes'])
  const releaseDate = typeof candidate?.['releaseDate'] === 'string' && !Number.isNaN(Date.parse(candidate['releaseDate']))
    ? new Date(candidate['releaseDate']).toISOString()
    : undefined
  return {
    version,
    prerelease: parsed.prerelease.length > 0,
    ...(releaseName ? { releaseName } : {}),
    ...(releaseNotes ? { releaseNotes } : {}),
    ...(releaseDate ? { releaseDate } : {})
  }
}

export function validateDownloadProgress(value: unknown): PackagedDownloadProgress | undefined {
  const candidate = record(value)
  if (!candidate) return undefined
  const total = Math.max(0, Math.floor(finiteNumber(candidate['total'])))
  const transferred = Math.max(0, Math.floor(finiteNumber(candidate['transferred'])))
  const percentFromBytes = total > 0 ? (Math.min(transferred, total) / total) * 100 : 0
  const rawPercent = finiteNumber(candidate['percent'], percentFromBytes)
  return {
    percent: Math.min(100, Math.max(0, rawPercent)),
    transferred: total > 0 ? Math.min(transferred, total) : transferred,
    total,
    bytesPerSecond: Math.max(0, Math.floor(finiteNumber(candidate['bytesPerSecond'])))
  }
}

export function normalizeUpdaterError(value: unknown, now: number, fallbackCode = 'UPDATE_FAILED'): PackagedUpdateError {
  const candidate = record(value)
  const rawMessage = value instanceof Error ? value.message : candidate?.['message']
  const rawCode = candidate?.['code']
  const code = typeof rawCode === 'string' && /^[A-Z0-9_-]{1,64}$/i.test(rawCode) ? rawCode.toUpperCase() : fallbackCode
  const message = sanitizeUpdaterText(rawMessage, MAX_ERROR_MESSAGE) ?? 'The update operation failed.'
  return {
    code,
    message,
    retryable: !/(signature|checksum|notar|certificate|channel|version)/i.test(`${code} ${message}`),
    at: now
  }
}

export function releaseAllowedForChannel(info: PackagedReleaseInfo, channel: UpdateChannel): boolean {
  return channel === 'beta' || !info.prerelease
}
