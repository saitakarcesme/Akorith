import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MARKETPLACE_PLUGINS, getMarketplacePlugin } from './catalog'
import { disconnectedHealthReport, resolvePluginConnection } from './connection'
import {
  beginLifecycleTransition,
  completeLifecycleTransition,
  createPluginInstallation,
  failLifecycleTransition,
  recoverLifecycleTransition
} from './lifecycle'
import type {
  PluginHealthReport,
  PluginInstallation,
  PluginLifecycleAction,
  PluginManifest,
  PluginPermissionGrant
} from './types'

interface MarketplaceStateFile {
  schemaVersion: 1
  installations: PluginInstallation[]
  health: PluginHealthReport[]
}

export interface MarketplacePluginSnapshot {
  manifest: PluginManifest
  installation: PluginInstallation
  connection: ReturnType<typeof resolvePluginConnection>
  updateAvailable: boolean
}

function defaultState(): MarketplaceStateFile {
  return { schemaVersion: 1, installations: [], health: [] }
}

function validInstallation(value: unknown): value is PluginInstallation {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PluginInstallation>
  return typeof candidate.pluginId === 'string'
    && typeof candidate.state === 'string'
    && typeof candidate.updatedAt === 'number'
}

function readState(path: string): MarketplaceStateFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MarketplaceStateFile>
    if (parsed.schemaVersion !== 1) return defaultState()
    return {
      schemaVersion: 1,
      installations: Array.isArray(parsed.installations) ? parsed.installations.filter(validInstallation) : [],
      health: Array.isArray(parsed.health) ? parsed.health.filter((value): value is PluginHealthReport => (
        Boolean(value) && typeof value.pluginId === 'string' && typeof value.checkedAt === 'number'
      )) : []
    }
  } catch {
    return defaultState()
  }
}

function semverIsNewer(next: string, current: string | null): boolean {
  if (!current) return false
  const toParts = (value: string): number[] => value.split('-', 1)[0].split('.').map((part) => Number(part) || 0)
  const left = toParts(next)
  const right = toParts(current)
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0)
  }
  return false
}

function permissionGrants(manifest: PluginManifest, now: number): PluginPermissionGrant[] {
  return manifest.permissions.map((permission) => ({
    permissionId: permission.id,
    granted: true,
    grantedAt: now,
    scopes: [...permission.scopes]
  }))
}

/**
 * Persistent marketplace lifecycle for the 30 audited in-tree manifests. This
 * service never downloads or executes arbitrary packages; install means making
 * a bundled, versioned adapter available to Akorith.
 */
export class PluginMarketplaceService {
  private readonly path: string
  private readonly now: () => number
  private state: MarketplaceStateFile

  constructor(path: string, now: () => number = Date.now) {
    this.path = path
    this.now = now
    this.state = readState(path)
    this.recoverInterruptedOperations()
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.path)
  }

  private recoverInterruptedOperations(): void {
    let changed = false
    this.state.installations = this.state.installations.map((installation) => {
      if (!installation.pending) return installation
      changed = true
      return failLifecycleTransition(installation, 'Akorith restarted before the lifecycle operation completed.', this.now())
    })
    if (changed) this.persist()
  }

  private installation(pluginId: string): PluginInstallation {
    return this.state.installations.find((item) => item.pluginId === pluginId)
      ?? createPluginInstallation(pluginId, this.now())
  }

  private saveInstallation(installation: PluginInstallation): void {
    const others = this.state.installations.filter((item) => item.pluginId !== installation.pluginId)
    this.state.installations = [...others, installation]
    this.persist()
  }

  list(): MarketplacePluginSnapshot[] {
    return MARKETPLACE_PLUGINS.map((manifest) => {
      const installation = this.installation(manifest.id)
      const health = this.state.health.find((item) => item.pluginId === manifest.id)
      return {
        manifest,
        installation,
        connection: resolvePluginConnection({
          manifest,
          installation,
          credentialsPresent: false,
          health
        }),
        updateAvailable: semverIsNewer(manifest.version, installation.installedVersion)
      }
    })
  }

  private perform(pluginId: string, action: PluginLifecycleAction): MarketplacePluginSnapshot[] {
    const manifest = getMarketplacePlugin(pluginId)
    if (!manifest) throw new Error('Unknown marketplace plugin.')
    let installation = this.installation(pluginId)
    if (installation.state === 'error') installation = recoverLifecycleTransition(installation, this.now())
    const now = this.now()
    installation = beginLifecycleTransition(installation, manifest, action, {
      now,
      permissionGrants: action === 'enable' ? permissionGrants(manifest, now) : undefined
    })
    this.saveInstallation(installation)
    installation = completeLifecycleTransition(installation, this.now())
    if (action === 'uninstall') {
      this.state.health = this.state.health.filter((item) => item.pluginId !== pluginId)
    }
    this.saveInstallation(installation)
    return this.list()
  }

  install(pluginId: string): MarketplacePluginSnapshot[] { return this.perform(pluginId, 'install') }
  update(pluginId: string): MarketplacePluginSnapshot[] { return this.perform(pluginId, 'update') }
  enable(pluginId: string): MarketplacePluginSnapshot[] { return this.perform(pluginId, 'enable') }
  disable(pluginId: string): MarketplacePluginSnapshot[] { return this.perform(pluginId, 'disable') }
  uninstall(pluginId: string): MarketplacePluginSnapshot[] { return this.perform(pluginId, 'uninstall') }

  check(pluginId: string): MarketplacePluginSnapshot[] {
    const manifest = getMarketplacePlugin(pluginId)
    if (!manifest) throw new Error('Unknown marketplace plugin.')
    const report = disconnectedHealthReport(
      pluginId,
      manifest.auth.required
        ? 'Install, enable, and configure a protected credential before a live adapter check.'
        : 'No verified runtime adapter is connected for this integration.',
      this.now()
    )
    this.state.health = [...this.state.health.filter((item) => item.pluginId !== pluginId), report]
    this.persist()
    return this.list()
  }

  connect(pluginId: string): { ok: false; reason: string; plugins: MarketplacePluginSnapshot[] } {
    const plugins = this.check(pluginId)
    return {
      ok: false,
      reason: 'No authenticated runtime adapter is configured. The plugin remains disconnected.',
      plugins
    }
  }

  configure(pluginId: string): { ok: false; reason: string; plugins: MarketplacePluginSnapshot[] } {
    if (!getMarketplacePlugin(pluginId)) throw new Error('Unknown marketplace plugin.')
    return {
      ok: false,
      reason: 'Configuration requires explicit values in Settings; no credential prompt was submitted.',
      plugins: this.list()
    }
  }
}
