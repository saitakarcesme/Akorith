import { ipcMain } from 'electron'
import { getControllerSettings, getLocalProviderSettings, getPluginSettings, setPluginSettings } from '../config'
import { setControllerPluginProvider } from '../controller'
import { BUILTIN_PLUGINS } from './builtin'
import { checkChrome, checkChroma, checkGitHubCli, checkOllamaCli, checkOpenCode, type RawDiagnostic } from './diagnostics'
import type { PluginDiagnostic, PluginId, PluginInfo, PluginManifest, PluginStatus } from './types'

// Phase 35: the plugin manager. Combines static manifests with config-only
// enable/disable state and live, read-only diagnostics. It NEVER loads or executes
// plugin code.

const diagnosticsCache = new Map<PluginId, PluginDiagnostic>()

function manifestById(id: PluginId): PluginManifest | undefined {
  return BUILTIN_PLUGINS.find((plugin) => plugin.id === id)
}

function fromRaw(id: PluginId, raw: RawDiagnostic): PluginDiagnostic {
  return {
    pluginId: id,
    available: raw.available,
    status: raw.available ? 'available' : 'unavailable',
    message: raw.message,
    ...(raw.details ? { details: raw.details } : {}),
    checkedAt: Date.now()
  }
}

async function buildDiagnostic(id: PluginId): Promise<PluginDiagnostic> {
  const manifest = manifestById(id)
  const now = Date.now()
  if (!manifest) {
    return { pluginId: id, available: false, status: 'error', message: 'Unknown plugin.', checkedAt: now }
  }

  switch (id) {
    case 'opencode-agent':
      return fromRaw(id, await checkOpenCode())
    case 'github-workbench':
      return fromRaw(id, await checkGitHubCli())
    case 'chroma-memory':
      return fromRaw(id, await checkChroma())
    case 'browser-automation':
      return fromRaw(id, await checkChrome())
    case 'remote-ollama-telemetry': {
      const cli = await checkOllamaCli()
      const profiles = getLocalProviderSettings().remoteProfiles?.length ?? 0
      const available = cli.available || profiles > 0
      return {
        pluginId: id,
        available,
        status: available ? 'available' : 'unavailable',
        message: cli.available
          ? `${cli.message}${profiles ? ` · ${profiles} remote profile(s) configured.` : ''}`
          : profiles
            ? `${profiles} remote Ollama profile(s) configured. Remote GPU telemetry still needs a secured companion.`
            : 'No local Ollama CLI and no remote profiles configured yet.',
        checkedAt: now
      }
    }
    case 'controller-api': {
      const controller = getControllerSettings()
      return {
        pluginId: id,
        available: controller.enabled,
        status: controller.enabled ? 'available' : 'unavailable',
        message: controller.enabled
          ? `Controller enabled on ${controller.host}:${controller.port} (read-only).`
          : 'Controller API is disabled. Enable it in Settings, then API.',
        checkedAt: now
      }
    }
    default:
      // Built-ins with no external dependency (Test Lab) and planned-only plugins.
      return {
        pluginId: id,
        available: manifest.status === 'built_in',
        status: manifest.status,
        message:
          manifest.status === 'built_in'
            ? 'Built-in and available.'
            : 'Planned — no live check yet. See the plugin notes for the roadmap.',
        checkedAt: now
      }
  }
}

function effectiveStatus(manifest: PluginManifest, disabled: boolean, diagnostic?: PluginDiagnostic): PluginStatus {
  if (disabled) return 'disabled'
  if (diagnostic) return diagnostic.status
  return manifest.status
}

export function listPlugins(): PluginInfo[] {
  const disabledIds = new Set(getPluginSettings().disabled)
  return BUILTIN_PLUGINS.map((manifest) => {
    const disabled = disabledIds.has(manifest.id)
    const diagnostic = diagnosticsCache.get(manifest.id)
    return {
      ...manifest,
      permissions: [...manifest.permissions],
      safetyNotes: [...manifest.safetyNotes],
      enabled: !disabled,
      effectiveStatus: effectiveStatus(manifest, disabled, diagnostic),
      ...(diagnostic ? { diagnostic } : {})
    }
  })
}

export async function checkPlugin(id: PluginId): Promise<PluginDiagnostic> {
  const diagnostic = await buildDiagnostic(id)
  diagnosticsCache.set(id, diagnostic)
  return diagnostic
}

export async function checkAllPlugins(): Promise<PluginDiagnostic[]> {
  const results = await Promise.all(BUILTIN_PLUGINS.map((plugin) => checkPlugin(plugin.id)))
  return results
}

export function getDiagnostics(): PluginDiagnostic[] {
  return [...diagnosticsCache.values()]
}

function setEnabled(id: PluginId, enabled: boolean): PluginInfo[] {
  if (!manifestById(id)) return listPlugins()
  const disabled = new Set(getPluginSettings().disabled)
  if (enabled) disabled.delete(id)
  else disabled.add(id)
  setPluginSettings({ disabled: [...disabled] })
  return listPlugins()
}

export function registerPluginIpc(): void {
  // Expose the live plugin list to the controller API (read-only).
  setControllerPluginProvider(() => listPlugins())

  ipcMain.handle('plugins:list', () => listPlugins())
  ipcMain.handle('plugins:getDiagnostics', () => getDiagnostics())
  ipcMain.handle('plugins:check', async (_event, id: unknown) =>
    typeof id === 'string' ? checkPlugin(id) : null
  )
  ipcMain.handle('plugins:checkAll', async () => {
    await checkAllPlugins()
    return listPlugins()
  })
  ipcMain.handle('plugins:enable', (_event, id: unknown) => (typeof id === 'string' ? setEnabled(id, true) : listPlugins()))
  ipcMain.handle('plugins:disable', (_event, id: unknown) =>
    typeof id === 'string' ? setEnabled(id, false) : listPlugins()
  )
  ipcMain.handle('plugins:setChromaEndpoint', (_event, endpoint: unknown) => {
    setPluginSettings({ chromaEndpoint: typeof endpoint === 'string' ? endpoint : '' })
    return getPluginSettings()
  })
  ipcMain.handle('plugins:getSettings', () => getPluginSettings())
}
