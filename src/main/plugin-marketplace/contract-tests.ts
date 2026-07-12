import { MARKETPLACE_PLUGINS, REQUIRED_PLUGIN_NAMES } from './catalog'
import { resolvePluginConnection } from './connection'
import {
  beginLifecycleTransition,
  completeLifecycleTransition,
  createPluginInstallation,
  failLifecycleTransition,
  recoverLifecycleTransition
} from './lifecycle'
import type {
  CredentialVault,
  PluginHealthReport,
  PluginInstallation,
  PluginManifest,
  PluginPermissionGrant
} from './types'
import { validatePluginManifest } from './validation'

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function permissionGrantsFor(manifest: PluginManifest, now = 1): PluginPermissionGrant[] {
  return manifest.permissions
    .filter((permission) => permission.required)
    .map((permission) => ({
      permissionId: permission.id,
      granted: true,
      grantedAt: now,
      scopes: [...permission.scopes]
    }))
}

export function verifiedHealthReport(
  manifest: PluginManifest,
  options: Partial<PluginHealthReport> = {}
): PluginHealthReport {
  return {
    pluginId: manifest.id,
    status: 'healthy',
    checkedAt: 3,
    summary: 'Adapter verified the connection.',
    checks: [{ id: 'adapter', status: 'pass', message: 'Verified.' }],
    verified: true,
    authenticated: manifest.auth.required,
    ...options
  }
}

export function installAndEnableForContract(manifest: PluginManifest): PluginInstallation {
  let installation = createPluginInstallation(manifest.id, 0)
  installation = beginLifecycleTransition(installation, manifest, 'install', { now: 1 })
  installation = completeLifecycleTransition(installation, 2)
  installation = beginLifecycleTransition(installation, manifest, 'enable', {
    now: 3,
    permissionGrants: permissionGrantsFor(manifest)
  })
  return completeLifecycleTransition(installation, 4)
}

export function assertMarketplaceCatalogContract(manifests: readonly PluginManifest[] = MARKETPLACE_PLUGINS): void {
  ensure(manifests.length === 30, `Expected exactly 30 marketplace plugins, received ${manifests.length}.`)
  const names = manifests.map((manifest) => manifest.name)
  ensure(
    names.length === REQUIRED_PLUGIN_NAMES.length && names.every((name, index) => name === REQUIRED_PLUGIN_NAMES[index]),
    'Marketplace names/order do not match the required 30-plugin catalog.'
  )
  ensure(new Set(manifests.map((manifest) => manifest.id)).size === manifests.length, 'Plugin ids must be unique.')
  ensure(new Set(names).size === manifests.length, 'Plugin names must be unique.')

  for (const manifest of manifests) {
    const result = validatePluginManifest(manifest)
    ensure(result.ok, `${manifest.id} manifest is invalid: ${result.ok ? '' : JSON.stringify(result.issues)}`)
    ensure(manifest.publisher.name.length > 0, `${manifest.id} must declare a publisher.`)
    ensure(manifest.icon.fallback.length > 0, `${manifest.id} must declare a fallback icon.`)
    ensure(manifest.capabilities.length > 0, `${manifest.id} must declare capabilities.`)
    ensure(manifest.skills.length > 0, `${manifest.id} must declare a skill surface.`)
    ensure(manifest.mcpServers.length > 0, `${manifest.id} must declare an MCP surface.`)
    ensure(manifest.hooks.length > 0, `${manifest.id} must declare hooks.`)
    ensure(manifest.apps.length > 0, `${manifest.id} must declare an app surface.`)
    ensure(manifest.commands.length > 0, `${manifest.id} must declare commands.`)
    ensure(manifest.health.initialState === 'disconnected', `${manifest.id} cannot default to connected.`)

    if (manifest.auth.required) {
      ensure(
        Object.values(manifest.configSchema.fields).some((field) => field.type === 'credential-reference'),
        `${manifest.id} must reference credentials through the vault.`
      )
      const enabled = installAndEnableForContract(manifest)
      const withoutCredentials = resolvePluginConnection({
        manifest,
        installation: enabled,
        credentialsPresent: false,
        health: verifiedHealthReport(manifest),
        now: 3
      })
      ensure(withoutCredentials.state === 'disconnected', `${manifest.id} faked a connected state without credentials.`)
    }
  }
}

export function assertLifecycleContract(manifest: PluginManifest): void {
  let installation = createPluginInstallation(manifest.id, 0)
  installation = beginLifecycleTransition(installation, manifest, 'install', { now: 1 })
  ensure(installation.state === 'installing', 'Install must enter installing.')
  installation = completeLifecycleTransition(installation, 2)
  ensure(installation.state === 'installed' && installation.installedVersion === manifest.version, 'Install must complete as installed.')

  let missingGrantRejected = false
  try {
    beginLifecycleTransition(installation, manifest, 'enable', { now: 3 })
  } catch {
    missingGrantRejected = true
  }
  ensure(missingGrantRejected, 'Enable must reject missing required permission grants.')

  installation = beginLifecycleTransition(installation, manifest, 'enable', {
    now: 3,
    permissionGrants: permissionGrantsFor(manifest)
  })
  ensure(installation.state === 'enabling', 'Enable must enter enabling.')
  installation = completeLifecycleTransition(installation, 4)
  ensure(installation.state === 'enabled', 'Enable must complete as enabled.')

  const updateManifest = { ...manifest, version: '1.1.0' }
  installation = beginLifecycleTransition(installation, updateManifest, 'update', { now: 5 })
  ensure(installation.state === 'updating', 'Update must enter updating.')
  installation = completeLifecycleTransition(installation, 6)
  ensure(installation.state === 'enabled' && installation.installedVersion === '1.1.0', 'Update must preserve enabled state.')

  installation = beginLifecycleTransition(installation, manifest, 'disable', { now: 7 })
  ensure(installation.state === 'disabling', 'Disable must enter disabling.')
  installation = completeLifecycleTransition(installation, 8)
  ensure(installation.state === 'disabled', 'Disable must complete as disabled.')

  installation = beginLifecycleTransition(installation, manifest, 'enable', {
    now: 9,
    permissionGrants: permissionGrantsFor(manifest)
  })
  installation = failLifecycleTransition(installation, 'adapter failed', 10)
  ensure(installation.state === 'error' && installation.recoveryState === 'disabled', 'Failure must retain a recovery state.')
  installation = recoverLifecycleTransition(installation, 11)
  ensure(installation.state === 'disabled', 'Recovery must restore the previous stable state.')

  installation = beginLifecycleTransition(installation, manifest, 'uninstall', { now: 12 })
  ensure(installation.state === 'uninstalling', 'Uninstall must enter uninstalling.')
  installation = completeLifecycleTransition(installation, 13)
  ensure(
    installation.state === 'not-installed' && installation.installedVersion === null && installation.installedAt === null,
    'Uninstall must clear installation metadata.'
  )
}

export async function exerciseCredentialVaultContract(vault: CredentialVault): Promise<void> {
  const credentialId = 'contract.github.primary'
  const inputSecret = 'contract-secret-never-returned'
  const metadata = await vault.put({ id: credentialId, pluginId: 'github', label: 'Contract credential', secret: inputSecret })
  ensure(metadata.id === credentialId && metadata.pluginId === 'github', 'Vault must return only credential metadata.')
  ensure(!('secret' in metadata), 'Credential metadata must not expose plaintext.')
  ensure(await vault.has(credentialId), 'Stored credential must be discoverable by id.')
  const listed = await vault.list('github')
  ensure(listed.length === 1 && !listed.some((item) => 'secret' in item), 'Vault list must expose metadata only.')

  let observed = ''
  await vault.use(credentialId, { pluginId: 'github', purpose: 'contract health probe' }, (secret) => {
    observed = Buffer.from(secret).toString('utf8')
  })
  ensure(observed === inputSecret, 'Scoped credential callback received the wrong secret.')

  let crossPluginRejected = false
  try {
    await vault.use(credentialId, { pluginId: 'gitlab', purpose: 'invalid cross-plugin access' }, () => undefined)
  } catch {
    crossPluginRejected = true
  }
  ensure(crossPluginRejected, 'Vault must reject cross-plugin credential use.')
  ensure(await vault.delete(credentialId), 'Vault delete must report a removed credential.')
  ensure(!(await vault.has(credentialId)), 'Deleted credentials must not remain discoverable.')
}
