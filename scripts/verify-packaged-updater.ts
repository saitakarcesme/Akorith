import { readFileSync } from 'fs'
import { join } from 'path'
import {
  assessReleaseReadiness,
  compareSemver,
  credentialSignalsFromEnvironment,
  loadOptionalElectronUpdater,
  PackagedUpdaterService,
  parseUpdateChannel,
  releaseAllowedForChannel,
  sanitizeUpdaterText,
  supportForPackagedUpdater,
  validateDownloadProgress,
  validateReleaseInfo,
  type ElectronUpdaterLike,
  type UpdaterEventListener,
  type UpdaterEventName
} from '../src/main/update/packaged'

let passed = 0
let failed = 0

function check(condition: unknown, label: string): void {
  if (condition) {
    passed += 1
    console.log(`PASS ${label}`)
  } else {
    failed += 1
    console.error(`FAIL ${label}`)
  }
}

class FakeUpdater implements ElectronUpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = false
  channel: string | null = null
  checkCalls = 0
  downloadCalls = 0
  installCalls: Array<[boolean | undefined, boolean | undefined]> = []
  checkResult: unknown = null
  checkError?: unknown
  downloadError?: unknown
  onDownload?: () => void
  private listeners = new Map<UpdaterEventName, Set<UpdaterEventListener>>()

  async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1
    if (this.checkError) throw this.checkError
    return this.checkResult
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1
    if (this.downloadError) throw this.downloadError
    this.onDownload?.()
    return []
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installCalls.push([isSilent, isForceRunAfter])
  }

  on(event: UpdaterEventName, listener: UpdaterEventListener): this {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return this
  }

  removeListener(event: UpdaterEventName, listener: UpdaterEventListener): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit(event: UpdaterEventName, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value)
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0)
  }
}

const packagedRuntime = {
  appVersion: '1.2.3',
  isPackaged: true,
  platform: 'win32' as const,
  feedConfigured: true
}

async function main(): Promise<void> {
  check(parseUpdateChannel('stable') === 'stable' && parseUpdateChannel('nightly') === undefined, 'channels accept only stable and beta')
  check(compareSemver('2.0.0', '1.9.9') === 1, 'semantic versions compare numeric components')
  check(compareSemver('1.0.0-beta.2', '1.0.0-beta.11') === -1, 'semantic prerelease identifiers compare numerically')
  check(compareSemver('1.0.0', '1.0.0-beta.9') === 1, 'stable release sorts after its prerelease')
  check(compareSemver('01.0.0', '1.0.0') === undefined, 'invalid semantic versions are rejected')

  const cleanText = sanitizeUpdaterText('https://me:password@example.test/path?access_token=query-secret token=abc123 Bearer header-secret', 200) ?? ''
  check(
    !cleanText.includes('password@example') && !cleanText.includes('abc123') && !cleanText.includes('query-secret') && !cleanText.includes('header-secret'),
    'updater text masks embedded credentials and token values'
  )
  check(validateReleaseInfo({ version: '1.3.0', releaseNotes: [{ note: 'Fix A' }, { note: 'Fix B' }] })?.releaseNotes === 'Fix A\nFix B', 'release notes arrays are normalized')
  check(validateReleaseInfo({ version: '../bad' }) === undefined, 'malformed release metadata is rejected')
  const progress = validateDownloadProgress({ percent: 140, transferred: 20, total: 10, bytesPerSecond: -4 })
  check(progress?.percent === 100 && progress.transferred === 10 && progress.bytesPerSecond === 0, 'download progress is finite and bounded')
  check(releaseAllowedForChannel({ version: '2.0.0-beta.1', prerelease: true }, 'stable') === false, 'stable channel rejects prereleases')

  const unavailable = supportForPackagedUpdater({ ...packagedRuntime, isPackaged: false }, new FakeUpdater())
  check(unavailable.code === 'DEVELOPMENT_BUILD' && !unavailable.supported, 'development builds report updater unsupported')
  check(supportForPackagedUpdater(packagedRuntime, undefined).code === 'UPDATER_MODULE_MISSING', 'missing updater dependency is reported honestly')
  check(supportForPackagedUpdater({ ...packagedRuntime, feedConfigured: false }, new FakeUpdater()).code === 'UPDATE_FEED_MISSING', 'missing publication feed is reported honestly')
  check(supportForPackagedUpdater({ ...packagedRuntime, platform: 'linux' }, new FakeUpdater()).code === 'UNSUPPORTED_PLATFORM', 'unsupported packaged platforms are explicit')

  const moduleUpdater = new FakeUpdater()
  const namedLoad = await loadOptionalElectronUpdater(async (specifier) => {
    check(specifier === 'electron-updater', 'optional loader requests only electron-updater')
    return { autoUpdater: moduleUpdater }
  })
  check(namedLoad.available && namedLoad.updater === moduleUpdater, 'named autoUpdater export is accepted')
  const defaultLoad = await loadOptionalElectronUpdater(async () => ({ default: { autoUpdater: moduleUpdater } }))
  check(defaultLoad.available, 'default CommonJS module shape is accepted')
  const missingLoad = await loadOptionalElectronUpdater(async () => { throw new Error('MODULE_NOT_FOUND secret=do-not-leak') })
  check(!missingLoad.available && !missingLoad.reason?.includes('do-not-leak'), 'optional dependency failure is bounded and secret-free')

  const developmentAdapter = new FakeUpdater()
  const development = new PackagedUpdaterService({ runtime: { ...packagedRuntime, isPackaged: false }, updater: developmentAdapter })
  check(development.getSnapshot().phase === 'unsupported' && !development.getSnapshot().canCheck, 'development service remains unsupported')
  check(!developmentAdapter.autoDownload && !developmentAdapter.autoInstallOnAppQuit, 'automatic download and install-on-quit are disabled even in unsupported runtimes')
  await development.checkForUpdates('stable')
  check(developmentAdapter.checkCalls === 0, 'unsupported service never contacts an update feed')

  let now = 10_000
  const updater = new FakeUpdater()
  updater.checkResult = { updateInfo: { version: '1.3.0', releaseName: 'Akorith 1.3', releaseNotes: 'Safe update' } }
  const service = new PackagedUpdaterService({
    runtime: packagedRuntime,
    updater,
    now: () => now,
    createInstallToken: () => 'deterministic-install-token',
    installAuthorizationTtlMs: 5_000
  })
  check(service.getSnapshot().phase === 'idle' && service.getSnapshot().canCheck, 'supported packaged updater starts idle')
  check(updater.channel === 'latest' && updater.allowPrerelease === false, 'stable channel maps to latest feed without prereleases')
  const observed: string[] = []
  const unsubscribe = service.subscribe((snapshot) => observed.push(snapshot.phase))
  await service.checkForUpdates('stable')
  check(service.getSnapshot().phase === 'available' && service.getSnapshot().update?.version === '1.3.0', 'check accepts a newer stable release')
  check(updater.downloadCalls === 0, 'checking never downloads automatically')
  updater.onDownload = () => {
    updater.emit('download-progress', { percent: 51.5, transferred: 515, total: 1000, bytesPerSecond: 100 })
    updater.emit('update-downloaded', { version: '1.3.0' })
  }
  await service.downloadUpdate()
  check(service.getSnapshot().phase === 'downloaded' && updater.downloadCalls === 1, 'explicit download reaches downloaded state')
  check(observed.includes('downloading') && observed.includes('downloaded'), 'subscribers receive bounded updater lifecycle states')
  const authorization = service.authorizeInstall()
  check(authorization?.version === '1.3.0' && authorization.expiresAt === 15_000, 'downloaded update issues short-lived version-bound authorization')
  service.installAuthorizedUpdate(authorization?.token)
  check(updater.installCalls.length === 1 && updater.installCalls[0]?.[0] === false && updater.installCalls[0]?.[1] === true, 'explicit authorization is the only path to visible install and relaunch')
  service.installAuthorizedUpdate(authorization?.token)
  check(updater.installCalls.length === 1, 'install authorization is one-use')
  unsubscribe()
  service.dispose()
  check(updater.listenerCount() === 0, 'dispose removes all updater listeners')

  const expiredUpdater = new FakeUpdater()
  expiredUpdater.checkResult = { updateInfo: { version: '1.3.0' } }
  const expiredService = new PackagedUpdaterService({
    runtime: packagedRuntime,
    updater: expiredUpdater,
    now: () => now,
    createInstallToken: () => 'another-secure-token',
    installAuthorizationTtlMs: 5_000
  })
  await expiredService.checkForUpdates()
  await expiredService.downloadUpdate()
  const expiredAuthorization = expiredService.authorizeInstall()!
  now = expiredAuthorization.expiresAt + 1
  expiredService.installAuthorizedUpdate(expiredAuthorization.token)
  check(expiredUpdater.installCalls.length === 0 && expiredService.getSnapshot().error?.code === 'INSTALL_NOT_AUTHORIZED', 'expired authorization cannot install')

  const betaUpdater = new FakeUpdater()
  betaUpdater.checkResult = { updateInfo: { version: '2.0.0-beta.1' } }
  const betaService = new PackagedUpdaterService({ runtime: packagedRuntime, updater: betaUpdater })
  await betaService.checkForUpdates('beta')
  check(betaService.getSnapshot().phase === 'available' && betaUpdater.channel === 'beta' && betaUpdater.allowPrerelease, 'beta channel opts into prerelease feed semantics')

  const stableUpdater = new FakeUpdater()
  stableUpdater.checkResult = { updateInfo: { version: '2.0.0-beta.1' } }
  const stableService = new PackagedUpdaterService({ runtime: packagedRuntime, updater: stableUpdater })
  await stableService.checkForUpdates('stable')
  check(stableService.getSnapshot().error?.code === 'CHANNEL_MISMATCH', 'stable channel blocks prerelease metadata even if feed returns it')

  const failingUpdater = new FakeUpdater()
  failingUpdater.checkError = new Error('network failed token=super-secret')
  const failingService = new PackagedUpdaterService({ runtime: packagedRuntime, updater: failingUpdater })
  await failingService.checkForUpdates()
  check(failingService.getSnapshot().phase === 'error' && !failingService.getSnapshot().error?.message.includes('super-secret'), 'operation errors are safe structured state')

  const readyPackage = {
    name: 'akorith',
    productName: 'Akorith',
    version: '2.0.0',
    dependencies: { 'electron-updater': '^6.0.0' },
    build: {
      appId: 'com.akorith.app',
      productName: 'Akorith',
      publish: [{ provider: 'github', owner: 'akorith', repo: 'akorith' }],
      generateUpdatesFilesForAllChannels: true,
      mac: { target: ['dmg', 'zip'], hardenedRuntime: true },
      win: { target: [{ target: 'nsis', arch: ['x64'] }] }
    }
  }
  const verifiedEvidence = {
    macIconExists: true,
    windowsIconExists: true,
    macSigningCredentialSignal: true,
    macNotarizationCredentialSignal: true,
    windowsSigningCredentialSignal: true,
    macSignatureVerified: true,
    macNotarizationVerified: true,
    windowsSignatureVerified: true
  }
  const ready = assessReleaseReadiness(readyPackage, verifiedEvidence, () => 42)
  check(ready.status === 'ready' && ready.stableChannelReady && ready.betaChannelReady && ready.checkedAt === 42, 'verified macOS and Windows release configuration can become ready')

  const currentPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as unknown
  const current = assessReleaseReadiness(currentPackage, {
    macIconExists: true,
    windowsIconExists: true,
    macSigningCredentialSignal: false,
    macNotarizationCredentialSignal: false,
    windowsSigningCredentialSignal: false
  })
  check(current.electronUpdaterDeclared && current.feedConfigured && current.stableChannelReady, 'current build declares updater dependency and public release feed')
  check(current.checks.some((item) => item.code === 'MAC_SIGNING_CREDENTIALS_MISSING'), 'current macOS signing readiness is not overstated')
  check(current.checks.some((item) => item.code === 'WINDOWS_SIGNING_CREDENTIALS_MISSING'), 'current Windows signing readiness is not overstated')

  const signals = credentialSignalsFromEnvironment({
    CSC_LINK: 'private-cert-value',
    CSC_KEY_PASSWORD: 'private-password',
    APPLE_API_KEY: 'private-key',
    APPLE_API_KEY_ID: 'id',
    APPLE_API_ISSUER: 'issuer'
  })
  check(signals.macSigningCredentialSignal && signals.macNotarizationCredentialSignal && signals.windowsSigningCredentialSignal, 'credential readiness records presence signals only')
  check(!JSON.stringify(signals).includes('private'), 'credential readiness never returns credential material')

  console.log(`verify-packaged-updater: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void main()
