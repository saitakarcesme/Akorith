import type {
  PluginInstallation,
  PluginLifecycleAction,
  PluginLifecycleState,
  PluginManifest,
  PluginPermissionGrant,
  PluginStableLifecycleState
} from './types'

export interface BeginLifecycleOptions {
  now?: number
  permissionGrants?: readonly PluginPermissionGrant[]
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function assertSemver(version: string): void {
  if (!SEMVER_PATTERN.test(version)) throw new Error(`Invalid semantic version: ${version}`)
}

function compareSemver(left: string, right: string): number {
  const leftMatch = SEMVER_PATTERN.exec(left)
  const rightMatch = SEMVER_PATTERN.exec(right)
  if (!leftMatch || !rightMatch) throw new Error('Cannot compare invalid semantic versions.')
  for (let index = 1; index <= 3; index++) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index])
    if (difference !== 0) return Math.sign(difference)
  }
  const leftPrerelease = leftMatch[4]
  const rightPrerelease = rightMatch[4]
  if (leftPrerelease === rightPrerelease) return 0
  if (!leftPrerelease) return 1
  if (!rightPrerelease) return -1
  return leftPrerelease.localeCompare(rightPrerelease)
}

function isStable(state: PluginLifecycleState): state is PluginStableLifecycleState {
  return state === 'not-installed' || state === 'installed' || state === 'enabled' || state === 'disabled'
}

export function createPluginInstallation(pluginId: string, now = Date.now()): PluginInstallation {
  if (!pluginId.trim()) throw new Error('Plugin id is required.')
  return {
    pluginId,
    state: 'not-installed',
    installedVersion: null,
    installedAt: null,
    updatedAt: now,
    pending: null,
    recoveryState: null,
    lastError: null
  }
}

export function missingRequiredPermissionIds(
  manifest: PluginManifest,
  grants: readonly PluginPermissionGrant[]
): string[] {
  const granted = new Set(
    grants
      .filter((grant) => grant.granted && grant.scopes.length > 0)
      .map((grant) => grant.permissionId)
  )
  return manifest.permissions
    .filter((permission) => permission.required && !granted.has(permission.id))
    .map((permission) => permission.id)
}

function assertTransitionAllowed(state: PluginLifecycleState, action: PluginLifecycleAction): void {
  const allowed: Record<PluginLifecycleAction, PluginLifecycleState[]> = {
    install: ['not-installed'],
    enable: ['installed', 'disabled'],
    disable: ['enabled'],
    update: ['installed', 'enabled', 'disabled'],
    uninstall: ['installed', 'enabled', 'disabled', 'error']
  }
  if (!allowed[action].includes(state)) throw new Error(`Cannot ${action} a plugin in state ${state}.`)
}

function operationState(action: PluginLifecycleAction): PluginLifecycleState {
  switch (action) {
    case 'install': return 'installing'
    case 'enable': return 'enabling'
    case 'disable': return 'disabling'
    case 'update': return 'updating'
    case 'uninstall': return 'uninstalling'
  }
}

export function beginLifecycleTransition(
  installation: PluginInstallation,
  manifest: PluginManifest,
  action: PluginLifecycleAction,
  options: BeginLifecycleOptions = {}
): PluginInstallation {
  if (installation.pluginId !== manifest.id) throw new Error('Installation and manifest plugin ids do not match.')
  if (installation.pending) throw new Error(`Plugin already has a pending ${installation.pending.action} operation.`)
  assertTransitionAllowed(installation.state, action)

  const now = options.now ?? Date.now()
  const targetVersion = manifest.version
  if (action === 'install' || action === 'update') assertSemver(targetVersion)
  if (action === 'update') {
    if (!installation.installedVersion) throw new Error('Cannot update a plugin without an installed version.')
    assertSemver(installation.installedVersion)
    if (compareSemver(targetVersion, installation.installedVersion) <= 0) {
      throw new Error(`Update version ${targetVersion} must be newer than ${installation.installedVersion}.`)
    }
  }
  if (action === 'enable') {
    const missing = missingRequiredPermissionIds(manifest, options.permissionGrants ?? [])
    if (missing.length > 0) throw new Error(`Required permissions are not granted: ${missing.join(', ')}`)
  }

  const returnState: PluginStableLifecycleState = isStable(installation.state)
    ? installation.state
    : installation.recoveryState ?? (installation.installedVersion ? 'disabled' : 'not-installed')

  return {
    ...installation,
    state: operationState(action),
    updatedAt: now,
    pending: {
      action,
      startedAt: now,
      returnState,
      ...((action === 'install' || action === 'update') ? { targetVersion } : {})
    },
    recoveryState: null,
    lastError: null
  }
}

export function completeLifecycleTransition(installation: PluginInstallation, now = Date.now()): PluginInstallation {
  const pending = installation.pending
  if (!pending) throw new Error('No lifecycle operation is pending.')
  if (installation.state !== operationState(pending.action)) {
    throw new Error(`Lifecycle state ${installation.state} does not match pending ${pending.action}.`)
  }

  switch (pending.action) {
    case 'install':
      if (!pending.targetVersion) throw new Error('Install operation is missing a target version.')
      return {
        ...installation,
        state: 'installed',
        installedVersion: pending.targetVersion,
        installedAt: installation.installedAt ?? now,
        updatedAt: now,
        pending: null,
        recoveryState: null,
        lastError: null
      }
    case 'enable':
      return { ...installation, state: 'enabled', updatedAt: now, pending: null, recoveryState: null, lastError: null }
    case 'disable':
      return { ...installation, state: 'disabled', updatedAt: now, pending: null, recoveryState: null, lastError: null }
    case 'update':
      if (!pending.targetVersion) throw new Error('Update operation is missing a target version.')
      return {
        ...installation,
        state: pending.returnState === 'not-installed' ? 'installed' : pending.returnState,
        installedVersion: pending.targetVersion,
        updatedAt: now,
        pending: null,
        recoveryState: null,
        lastError: null
      }
    case 'uninstall':
      return {
        ...installation,
        state: 'not-installed',
        installedVersion: null,
        installedAt: null,
        updatedAt: now,
        pending: null,
        recoveryState: null,
        lastError: null
      }
  }
}

export function failLifecycleTransition(
  installation: PluginInstallation,
  error: string,
  now = Date.now()
): PluginInstallation {
  if (!installation.pending) throw new Error('No lifecycle operation is pending.')
  const message = error.trim()
  if (!message) throw new Error('A lifecycle failure requires an error message.')
  return {
    ...installation,
    state: 'error',
    updatedAt: now,
    pending: null,
    recoveryState: installation.pending.returnState,
    lastError: message
  }
}

export function recoverLifecycleTransition(installation: PluginInstallation, now = Date.now()): PluginInstallation {
  if (installation.state !== 'error' || !installation.recoveryState) {
    throw new Error('Only a recoverable error state can be restored.')
  }
  return {
    ...installation,
    state: installation.recoveryState,
    updatedAt: now,
    recoveryState: null,
    lastError: null
  }
}
