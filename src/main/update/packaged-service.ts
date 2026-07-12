import { randomBytes, timingSafeEqual } from 'crypto'
import type {
  ElectronUpdaterLike,
  InstallAuthorization,
  PackagedReleaseInfo,
  PackagedUpdateSnapshot,
  PackagedUpdaterDependencies,
  UpdateChannel,
  UpdaterEventListener,
  UpdaterEventName
} from './packaged-types'
import {
  compareSemver,
  normalizeUpdaterError,
  parseUpdateChannel,
  releaseAllowedForChannel,
  supportForPackagedUpdater,
  validateDownloadProgress,
  validateReleaseInfo
} from './packaged-validation'

type SnapshotListener = (snapshot: PackagedUpdateSnapshot) => void

const DEFAULT_AUTHORIZATION_TTL_MS = 2 * 60_000
const MIN_AUTHORIZATION_TTL_MS = 5_000
const MAX_AUTHORIZATION_TTL_MS = 10 * 60_000

function copySnapshot(snapshot: PackagedUpdateSnapshot): PackagedUpdateSnapshot {
  return {
    ...snapshot,
    support: { ...snapshot.support },
    ...(snapshot.update ? { update: { ...snapshot.update } } : {}),
    ...(snapshot.progress ? { progress: { ...snapshot.progress } } : {}),
    ...(snapshot.error ? { error: { ...snapshot.error } } : {})
  }
}

function stateCapabilities(snapshot: PackagedUpdateSnapshot): PackagedUpdateSnapshot {
  const supported = snapshot.support.supported
  return {
    ...snapshot,
    canCheck: supported && !['checking', 'downloading', 'installing'].includes(snapshot.phase),
    canDownload: supported && snapshot.phase === 'available',
    canAuthorizeInstall: supported && snapshot.phase === 'downloaded',
    manualInstallRequired: true
  }
}

function boundedTtl(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_AUTHORIZATION_TTL_MS
  return Math.min(MAX_AUTHORIZATION_TTL_MS, Math.max(MIN_AUTHORIZATION_TTL_MS, Math.floor(value)))
}

function tokenEquals(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function resultUpdateInfo(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  return candidate['updateInfo'] ?? value
}

/**
 * Policy-owning wrapper around electron-updater. It never downloads without a
 * call to downloadUpdate(), and never invokes quitAndInstall without a fresh,
 * one-use authorization produced by authorizeInstall().
 */
export class PackagedUpdaterService {
  private readonly updater?: ElectronUpdaterLike
  private readonly now: () => number
  private readonly createInstallToken: () => string
  private readonly authorizationTtlMs: number
  private readonly listeners = new Set<SnapshotListener>()
  private readonly eventListeners = new Map<UpdaterEventName, UpdaterEventListener>()
  private snapshot: PackagedUpdateSnapshot
  private installAuthorization?: InstallAuthorization
  private disposed = false

  constructor(dependencies: PackagedUpdaterDependencies) {
    this.updater = dependencies.updater
    this.now = dependencies.now ?? Date.now
    this.createInstallToken = dependencies.createInstallToken ?? (() => randomBytes(24).toString('base64url'))
    this.authorizationTtlMs = boundedTtl(dependencies.installAuthorizationTtlMs)

    const channel = dependencies.initialChannel ?? 'stable'
    const support = supportForPackagedUpdater(dependencies.runtime, this.updater)
    const now = this.now()
    this.snapshot = stateCapabilities({
      phase: support.supported ? 'idle' : 'unsupported',
      channel,
      currentVersion: dependencies.runtime.appVersion,
      support,
      updatedAt: now,
      canCheck: false,
      canDownload: false,
      canAuthorizeInstall: false,
      manualInstallRequired: true
    })

    // These settings are safety policy, not preferences. Set them whenever a
    // compatible adapter exists, even if this particular runtime is unsupported.
    if (this.updater) {
      this.updater.autoDownload = false
      this.updater.autoInstallOnAppQuit = false
      this.configureChannel(channel)
    }
    if (support.supported) this.attachEvents()
  }

  getSnapshot(): PackagedUpdateSnapshot {
    return copySnapshot(this.snapshot)
  }

  subscribe(listener: SnapshotListener): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  async checkForUpdates(channelInput: unknown = this.snapshot.channel): Promise<PackagedUpdateSnapshot> {
    if (!this.ensureUsable('CHECK_UNAVAILABLE')) return this.getSnapshot()
    const channel = parseUpdateChannel(channelInput)
    if (!channel) {
      this.fail('INVALID_CHANNEL', 'Update channel must be stable or beta.', false)
      return this.getSnapshot()
    }
    if (['checking', 'downloading', 'installing'].includes(this.snapshot.phase)) return this.getSnapshot()

    this.clearInstallAuthorization()
    this.configureChannel(channel)
    this.transition({ phase: 'checking', channel, update: undefined, progress: undefined, error: undefined })
    try {
      const result = await this.updater!.checkForUpdates()
      if (this.snapshot.phase === 'checking') {
        const info = validateReleaseInfo(resultUpdateInfo(result))
        if (!info || !this.isNewer(info)) {
          this.transition({ phase: 'not-available', checkedAt: this.now(), update: undefined })
        } else {
          this.acceptAvailable(info)
        }
      }
    } catch (error) {
      this.failFromUnknown(error, 'CHECK_FAILED')
    }
    return this.getSnapshot()
  }

  async downloadUpdate(): Promise<PackagedUpdateSnapshot> {
    if (!this.ensureUsable('DOWNLOAD_UNAVAILABLE')) return this.getSnapshot()
    if (this.snapshot.phase !== 'available' || !this.snapshot.update) {
      this.fail('DOWNLOAD_NOT_ALLOWED', 'An accepted update must be available before it can be downloaded.', false)
      return this.getSnapshot()
    }
    this.transition({ phase: 'downloading', progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }, error: undefined })
    try {
      await this.updater!.downloadUpdate()
      // electron-updater normally emits update-downloaded. A compatible test or
      // alternate adapter may only resolve its promise, so complete safely here.
      if (this.getSnapshot().phase === 'downloading') this.transition({ phase: 'downloaded', progress: undefined })
    } catch (error) {
      this.failFromUnknown(error, 'DOWNLOAD_FAILED')
    }
    return this.getSnapshot()
  }

  authorizeInstall(): InstallAuthorization | undefined {
    if (!this.snapshot.support.supported || this.snapshot.phase !== 'downloaded' || !this.snapshot.update) return undefined
    const token = this.createInstallToken()
    if (typeof token !== 'string' || token.length < 12 || token.length > 256) {
      this.fail('INSTALL_AUTHORIZATION_FAILED', 'A secure install authorization could not be created.', false)
      return undefined
    }
    this.installAuthorization = {
      token,
      expiresAt: this.now() + this.authorizationTtlMs,
      version: this.snapshot.update.version
    }
    return { ...this.installAuthorization }
  }

  installAuthorizedUpdate(token: unknown): PackagedUpdateSnapshot {
    if (!this.ensureUsable('INSTALL_UNAVAILABLE')) return this.getSnapshot()
    const authorization = this.installAuthorization
    const update = this.snapshot.update
    this.clearInstallAuthorization()
    if (
      this.snapshot.phase !== 'downloaded' ||
      !update ||
      !authorization ||
      typeof token !== 'string' ||
      this.now() >= authorization.expiresAt ||
      authorization.version !== update.version ||
      !tokenEquals(token, authorization.token)
    ) {
      this.fail('INSTALL_NOT_AUTHORIZED', 'Install requires a fresh explicit user authorization.', false)
      return this.getSnapshot()
    }

    this.transition({ phase: 'installing', error: undefined })
    try {
      // isSilent=false keeps native installer UX visible; force-run-after=true
      // relaunches only as part of this explicit install action.
      this.updater!.quitAndInstall(false, true)
    } catch (error) {
      this.failFromUnknown(error, 'INSTALL_FAILED')
    }
    return this.getSnapshot()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearInstallAuthorization()
    if (this.updater) {
      for (const [event, listener] of this.eventListeners) this.updater.removeListener(event, listener)
    }
    this.eventListeners.clear()
    this.listeners.clear()
  }

  private configureChannel(channel: UpdateChannel): void {
    if (!this.updater) return
    this.updater.allowPrerelease = channel === 'beta'
    this.updater.channel = channel === 'beta' ? 'beta' : 'latest'
    // electron-updater may enable downgrades when its channel changes. Akorith
    // never treats a lower version as an update, so reset this policy after the
    // channel assignment on every check as a defense in depth.
    this.updater.allowDowngrade = false
  }

  private attachEvents(): void {
    const handlers: Record<UpdaterEventName, UpdaterEventListener> = {
      'checking-for-update': () => {
        if (this.snapshot.phase !== 'downloading' && this.snapshot.phase !== 'installing') {
          this.transition({ phase: 'checking', error: undefined })
        }
      },
      'update-available': (value) => {
        const info = validateReleaseInfo(value)
        if (!info) {
          this.fail('INVALID_RELEASE_METADATA', 'The update feed returned invalid release metadata.', false)
          return
        }
        if (!this.isNewer(info)) {
          this.transition({ phase: 'not-available', checkedAt: this.now(), update: undefined })
          return
        }
        this.acceptAvailable(info)
      },
      'update-not-available': () => {
        this.clearInstallAuthorization()
        this.transition({ phase: 'not-available', checkedAt: this.now(), update: undefined, progress: undefined, error: undefined })
      },
      'download-progress': (value) => {
        if (this.snapshot.phase !== 'downloading') return
        const progress = validateDownloadProgress(value)
        if (progress) this.transition({ progress })
      },
      'update-downloaded': (value) => {
        const eventInfo = validateReleaseInfo(value)
        const update = eventInfo && this.isNewer(eventInfo) ? eventInfo : this.snapshot.update
        if (!update || !releaseAllowedForChannel(update, this.snapshot.channel)) {
          this.fail('INVALID_DOWNLOADED_RELEASE', 'The downloaded release does not match the selected channel.', false)
          return
        }
        this.transition({ phase: 'downloaded', update, progress: undefined, error: undefined })
      },
      error: (value) => this.failFromUnknown(value, 'UPDATER_EVENT_ERROR')
    }
    for (const event of Object.keys(handlers) as UpdaterEventName[]) {
      const listener = handlers[event]
      this.eventListeners.set(event, listener)
      this.updater!.on(event, listener)
    }
  }

  private isNewer(info: PackagedReleaseInfo): boolean {
    return compareSemver(info.version, this.snapshot.currentVersion) === 1
  }

  private acceptAvailable(info: PackagedReleaseInfo): void {
    if (!releaseAllowedForChannel(info, this.snapshot.channel)) {
      this.fail('CHANNEL_MISMATCH', 'A prerelease was rejected because the stable channel is selected.', false)
      return
    }
    this.transition({ phase: 'available', update: info, progress: undefined, error: undefined, checkedAt: this.now() })
  }

  private ensureUsable(code: string): boolean {
    if (!this.disposed && this.snapshot.support.supported && this.updater) return true
    if (this.snapshot.phase !== 'unsupported') this.fail(code, 'The packaged updater is unavailable in this runtime.', false)
    return false
  }

  private failFromUnknown(error: unknown, fallbackCode: string): void {
    this.clearInstallAuthorization()
    this.transition({ phase: 'error', error: normalizeUpdaterError(error, this.now(), fallbackCode), progress: undefined })
  }

  private fail(code: string, message: string, retryable: boolean): void {
    this.clearInstallAuthorization()
    this.transition({
      phase: 'error',
      error: { code, message, retryable, at: this.now() },
      progress: undefined
    })
  }

  private transition(patch: Partial<PackagedUpdateSnapshot>): void {
    if (this.disposed) return
    this.snapshot = stateCapabilities({ ...this.snapshot, ...patch, updatedAt: this.now() })
    const next = this.getSnapshot()
    for (const listener of this.listeners) {
      try {
        listener(next)
      } catch {
        // A diagnostic subscriber must never break update policy.
      }
    }
  }

  private clearInstallAuthorization(): void {
    this.installAuthorization = undefined
  }
}
