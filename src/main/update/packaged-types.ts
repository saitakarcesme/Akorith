/**
 * Pure contracts for the packaged-app updater.  This module deliberately has no
 * Electron imports so updater policy can be exercised in an ordinary Node test.
 */

export type UpdateChannel = 'stable' | 'beta'

export type PackagedUpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export type UpdaterSupportCode =
  | 'SUPPORTED'
  | 'DEVELOPMENT_BUILD'
  | 'UNSUPPORTED_PLATFORM'
  | 'UPDATER_MODULE_MISSING'
  | 'UPDATE_FEED_MISSING'
  | 'INVALID_APP_VERSION'

export interface PackagedUpdaterRuntime {
  appVersion: string
  isPackaged: boolean
  platform: NodeJS.Platform
  /**
   * True only when electron-builder has a real publish provider/feed embedded
   * in the packaged application.  A GitHub repository URL by itself is not a
   * usable update feed.
   */
  feedConfigured: boolean
}

export interface UpdaterSupport {
  supported: boolean
  code: UpdaterSupportCode
  reason: string
}

export interface PackagedReleaseInfo {
  version: string
  releaseName?: string
  releaseNotes?: string
  releaseDate?: string
  prerelease: boolean
}

export interface PackagedDownloadProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface PackagedUpdateError {
  code: string
  message: string
  retryable: boolean
  at: number
}

export interface PackagedUpdateSnapshot {
  phase: PackagedUpdatePhase
  channel: UpdateChannel
  currentVersion: string
  support: UpdaterSupport
  update?: PackagedReleaseInfo
  progress?: PackagedDownloadProgress
  error?: PackagedUpdateError
  checkedAt?: number
  updatedAt: number
  canCheck: boolean
  canDownload: boolean
  canAuthorizeInstall: boolean
  /** Always true: Akorith never installs or restarts merely because it exits. */
  manualInstallRequired: true
}

export interface InstallAuthorization {
  token: string
  expiresAt: number
  version: string
}

export type UpdaterEventName =
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'error'

export type UpdaterEventListener = (...args: unknown[]) => void

/**
 * The subset of electron-updater's AppUpdater contract Akorith relies on.
 * Keeping this structural allows dependency injection and an honest no-module
 * state without making electron-updater a hard import.
 */
export interface ElectronUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  channel: string | null
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: UpdaterEventName, listener: UpdaterEventListener): unknown
  removeListener(event: UpdaterEventName, listener: UpdaterEventListener): unknown
}

export interface PackagedUpdaterDependencies {
  runtime: PackagedUpdaterRuntime
  updater?: ElectronUpdaterLike
  initialChannel?: UpdateChannel
  now?: () => number
  createInstallToken?: () => string
  installAuthorizationTtlMs?: number
}

export interface ElectronUpdaterLoadResult {
  updater?: ElectronUpdaterLike
  available: boolean
  reason?: string
}

export type UpdateModuleLoader = (specifier: string) => Promise<unknown>

