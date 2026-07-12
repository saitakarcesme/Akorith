import { parseSemver } from './packaged-validation'

export type ReleaseReadinessLevel = 'pass' | 'warning' | 'action-required' | 'blocked'

export interface ReleaseReadinessCheck {
  code: string
  area: 'identity' | 'updates' | 'macos' | 'windows' | 'signing'
  level: ReleaseReadinessLevel
  message: string
}

export interface ReleaseEvidence {
  macIconExists: boolean
  windowsIconExists: boolean
  macSigningCredentialSignal: boolean
  macNotarizationCredentialSignal: boolean
  windowsSigningCredentialSignal: boolean
  macSignatureVerified?: boolean
  macNotarizationVerified?: boolean
  windowsSignatureVerified?: boolean
}

export interface ReleaseReadinessReport {
  status: 'ready' | 'action-required' | 'blocked'
  checkedAt: number
  checks: ReleaseReadinessCheck[]
  feedConfigured: boolean
  electronUpdaterDeclared: boolean
  stableChannelReady: boolean
  betaChannelReady: boolean
}

interface PackageShape {
  name?: unknown
  productName?: unknown
  version?: unknown
  dependencies?: unknown
  devDependencies?: unknown
  build?: unknown
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function targetNames(value: unknown): Set<string> {
  const names = new Set<string>()
  const add = (candidate: unknown): void => {
    if (typeof candidate === 'string') names.add(candidate.toLowerCase())
    else {
      const entry = object(candidate)
      const target = string(entry?.['target'])
      if (target) names.add(target.toLowerCase())
    }
  }
  if (Array.isArray(value)) value.forEach(add)
  else add(value)
  return names
}

function publishProviders(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value ? [value] : []
  return entries
    .map((entry) => string(object(entry)?.['provider']))
    .filter((provider): provider is string => Boolean(provider))
    .map((provider) => provider.toLowerCase())
}

function dependencyDeclared(packageJson: PackageShape, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(object(packageJson.dependencies) ?? {}, name)
}

function addCheck(
  checks: ReleaseReadinessCheck[],
  code: string,
  area: ReleaseReadinessCheck['area'],
  level: ReleaseReadinessLevel,
  message: string
): void {
  checks.push({ code, area, level, message })
}

function signingChecks(checks: ReleaseReadinessCheck[], evidence: ReleaseEvidence): void {
  if (!evidence.macSigningCredentialSignal) {
    addCheck(checks, 'MAC_SIGNING_CREDENTIALS_MISSING', 'signing', 'action-required', 'No macOS signing credential signal was provided; release artifacts will be unsigned.')
  } else if (evidence.macSignatureVerified !== true) {
    addCheck(checks, 'MAC_SIGNATURE_UNVERIFIED', 'signing', 'action-required', 'macOS signing inputs are present, but no built artifact signature has been verified.')
  } else {
    addCheck(checks, 'MAC_SIGNATURE_VERIFIED', 'signing', 'pass', 'A macOS artifact signature was independently verified.')
  }

  if (!evidence.macNotarizationCredentialSignal) {
    addCheck(checks, 'MAC_NOTARIZATION_CREDENTIALS_MISSING', 'signing', 'action-required', 'No Apple notarization credential signal was provided; notarization is not ready.')
  } else if (evidence.macNotarizationVerified !== true) {
    addCheck(checks, 'MAC_NOTARIZATION_UNVERIFIED', 'signing', 'action-required', 'Notarization inputs are present, but no stapled artifact has been verified.')
  } else {
    addCheck(checks, 'MAC_NOTARIZATION_VERIFIED', 'signing', 'pass', 'A notarized and stapled macOS artifact was independently verified.')
  }

  if (!evidence.windowsSigningCredentialSignal) {
    addCheck(checks, 'WINDOWS_SIGNING_CREDENTIALS_MISSING', 'signing', 'action-required', 'No Windows Authenticode credential signal was provided; release artifacts will be unsigned.')
  } else if (evidence.windowsSignatureVerified !== true) {
    addCheck(checks, 'WINDOWS_SIGNATURE_UNVERIFIED', 'signing', 'action-required', 'Windows signing inputs are present, but no built artifact signature has been verified.')
  } else {
    addCheck(checks, 'WINDOWS_SIGNATURE_VERIFIED', 'signing', 'pass', 'A Windows artifact Authenticode signature was independently verified.')
  }
}

export function credentialSignalsFromEnvironment(environment: NodeJS.ProcessEnv): Pick<
  ReleaseEvidence,
  'macSigningCredentialSignal' | 'macNotarizationCredentialSignal' | 'windowsSigningCredentialSignal'
> {
  const present = (key: string): boolean => typeof environment[key] === 'string' && environment[key]!.trim().length > 0
  const certificate = present('CSC_LINK') && present('CSC_KEY_PASSWORD')
  const appleIdFlow = present('APPLE_ID') && present('APPLE_APP_SPECIFIC_PASSWORD') && present('APPLE_TEAM_ID')
  const appleApiFlow = present('APPLE_API_KEY') && present('APPLE_API_KEY_ID') && present('APPLE_API_ISSUER')
  return {
    macSigningCredentialSignal: certificate,
    macNotarizationCredentialSignal: appleIdFlow || appleApiFlow,
    windowsSigningCredentialSignal: certificate
  }
}

/**
 * Validate release configuration and evidence without ever reading or returning
 * credential values. "Ready" requires verified signed artifacts, not merely
 * environment variables that happen to be present.
 */
export function assessReleaseReadiness(
  packageValue: unknown,
  evidence: ReleaseEvidence,
  now: () => number = Date.now
): ReleaseReadinessReport {
  const packageJson = (object(packageValue) ?? {}) as PackageShape
  const build = object(packageJson.build) ?? {}
  const mac = object(build['mac']) ?? {}
  const win = object(build['win']) ?? {}
  const macTargets = targetNames(mac['target'])
  const winTargets = targetNames(win['target'])
  const providers = publishProviders(build['publish'])
  const acceptedProviders = new Set(['github', 'generic', 's3', 'spaces', 'keygen'])
  const feedConfigured = providers.some((provider) => acceptedProviders.has(provider))
  const electronUpdaterDeclared = dependencyDeclared(packageJson, 'electron-updater')
  const checks: ReleaseReadinessCheck[] = []

  const appId = string(build['appId'])
  const productName = string(build['productName']) ?? string(packageJson.productName)
  const version = string(packageJson.version)
  addCheck(checks, 'APP_ID', 'identity', appId ? 'pass' : 'blocked', appId ? `Application id is ${appId}.` : 'electron-builder appId is missing.')
  addCheck(checks, 'PRODUCT_NAME', 'identity', productName === 'Akorith' ? 'pass' : 'blocked', productName === 'Akorith' ? 'Packaged product name is Akorith.' : 'Packaged productName must be Akorith.')
  addCheck(checks, 'SEMANTIC_VERSION', 'identity', parseSemver(version) ? 'pass' : 'blocked', parseSemver(version) ? `Release version ${version} is valid.` : 'Release version must be valid semantic version metadata.')

  addCheck(
    checks,
    'ELECTRON_UPDATER_DEPENDENCY',
    'updates',
    electronUpdaterDeclared ? 'pass' : 'blocked',
    electronUpdaterDeclared ? 'electron-updater is declared as a production dependency.' : 'electron-updater is not declared as a production dependency.'
  )
  addCheck(
    checks,
    'PUBLISH_FEED',
    'updates',
    feedConfigured ? 'pass' : 'blocked',
    feedConfigured ? `Update publish provider configured: ${providers.join(', ')}.` : 'No supported electron-builder publish provider is configured.'
  )

  addCheck(checks, 'MAC_ZIP_TARGET', 'macos', macTargets.has('zip') ? 'pass' : 'blocked', macTargets.has('zip') ? 'macOS ZIP target can provide updater metadata.' : 'macOS updates require a ZIP target in addition to DMG.')
  addCheck(checks, 'MAC_DMG_TARGET', 'macos', macTargets.has('dmg') ? 'pass' : 'warning', macTargets.has('dmg') ? 'macOS DMG target is configured.' : 'A DMG target is recommended for manual installation.')
  addCheck(checks, 'MAC_ICON', 'macos', evidence.macIconExists ? 'pass' : 'blocked', evidence.macIconExists ? 'macOS .icns asset exists.' : 'Configured macOS .icns asset is missing.')
  addCheck(checks, 'MAC_HARDENED_RUNTIME', 'macos', mac['hardenedRuntime'] === true ? 'pass' : 'action-required', mac['hardenedRuntime'] === true ? 'macOS hardened runtime is explicitly enabled.' : 'Enable hardenedRuntime before signing and notarizing production builds.')

  addCheck(checks, 'WINDOWS_NSIS_TARGET', 'windows', winTargets.has('nsis') ? 'pass' : 'blocked', winTargets.has('nsis') ? 'Windows NSIS target can apply packaged updates.' : 'Windows packaged updates require an NSIS target.')
  addCheck(checks, 'WINDOWS_ICON', 'windows', evidence.windowsIconExists ? 'pass' : 'blocked', evidence.windowsIconExists ? 'Windows .ico asset exists.' : 'Configured Windows .ico asset is missing.')

  const allChannels = build['generateUpdatesFilesForAllChannels'] === true
  addCheck(
    checks,
    'BETA_CHANNEL_METADATA',
    'updates',
    allChannels ? 'pass' : 'action-required',
    allChannels ? 'Update metadata generation is enabled for stable and beta channels.' : 'Enable generateUpdatesFilesForAllChannels before offering the beta channel.'
  )

  signingChecks(checks, evidence)

  const blocked = checks.some((check) => check.level === 'blocked')
  const actionRequired = checks.some((check) => check.level === 'action-required')
  return {
    status: blocked ? 'blocked' : actionRequired ? 'action-required' : 'ready',
    checkedAt: now(),
    checks,
    feedConfigured,
    electronUpdaterDeclared,
    stableChannelReady: electronUpdaterDeclared && feedConfigured && macTargets.has('zip') && winTargets.has('nsis'),
    betaChannelReady: electronUpdaterDeclared && feedConfigured && allChannels && macTargets.has('zip') && winTargets.has('nsis')
  }
}
