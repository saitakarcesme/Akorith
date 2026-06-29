import { app, ipcMain } from 'electron'
import { getControllerSettings, getLocalProviderSettings, setControllerSettings, type ControllerSettings } from '../config'
import { listAgentAdapters } from '../agents/registry'
import { agentSessionManager } from '../agents/session-manager'
import { listProjects, listSessions } from '../db'
import { missionStore } from '../missions/store'
import { getGpuStatus } from '../gpu-status'
import { createControllerServer, ENDPOINTS, type ControllerServer } from './server'
import type { ControllerData } from './routes'

// Phase 35: electron-side controller bootstrap. This file owns the electron/config/db
// imports and feeds read-only, metadata-only data into the pure server factory. A
// renderer-supplied plugin provider is injected later (Phase 35.16) so plugins surface
// over the API too.

let pluginProvider: () => Promise<unknown> | unknown = () => []

/** Phase 35.16: let the plugin module register its read-only list provider. */
export function setControllerPluginProvider(provider: () => Promise<unknown> | unknown): void {
  pluginProvider = provider
}

// Read-only, summary/metadata-only data. No prompts, terminal output, or secrets.
const controllerData: ControllerData = {
  agents: () => listAgentAdapters(),
  runtime: () => agentSessionManager.getRuntimeSnapshot({}),
  projects: () =>
    listProjects().map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    })),
  // Chat SUMMARIES only — titles + metadata, never message bodies.
  chats: () =>
    listSessions().map((session) => ({
      id: session.id,
      title: session.title,
      providerId: session.providerId,
      projectId: session.projectId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    })),
  missions: () =>
    missionStore.listMissions().map((mission) => ({
      id: mission.id,
      title: mission.title,
      status: mission.status,
      origin: mission.origin,
      riskLevel: mission.riskLevel,
      stepCount: mission.steps.length,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt
    })),
  plugins: () => pluginProvider(),
  gpu: () => getGpuStatus(),
  ollama: () => {
    const s = getLocalProviderSettings()
    let endpointKind: 'local' | 'remote' = 'local'
    try {
      const host = new URL(s.baseUrl).hostname.toLowerCase()
      endpointKind = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' ? 'local' : 'remote'
    } catch {
      /* keep local */
    }
    return {
      configuredBaseUrl: s.baseUrl,
      endpointKind,
      lastSuccessfulBaseUrl: s.lastSuccessfulBaseUrl,
      remoteProfiles: (s.remoteProfiles ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        enabled: p.enabled,
        priority: p.priority,
        lastStatus: p.lastStatus,
        lastModelCount: p.lastModelCount
      }))
    }
  }
}

let server: ControllerServer | null = null

function getServer(): ControllerServer {
  if (!server) {
    server = createControllerServer({
      version: app.getVersion(),
      getSettings: getControllerSettings,
      saveSettings: setControllerSettings,
      data: controllerData
    })
  }
  return server
}

/** Apply a config change: persist, then bring the server to the desired state. */
async function applyConfig(patch: Partial<ControllerSettings>): Promise<void> {
  const next = setControllerSettings(patch)
  const srv = getServer()
  if (next.enabled) {
    if (srv.isRunning()) await srv.restart()
    else await srv.start()
  } else if (srv.isRunning()) {
    await srv.stop()
  }
}

export function registerControllerIpc(): void {
  const srv = getServer()

  ipcMain.handle('controller:getConfig', () => srv.configView())
  ipcMain.handle('controller:getStatus', () => srv.status())
  ipcMain.handle('controller:getDocs', () => ({ app: 'Akorith Controller API', readOnly: true, endpoints: ENDPOINTS }))
  // Local-only reveal for the Settings copy button (never logged, never over network).
  ipcMain.handle('controller:revealToken', () => srv.revealToken())

  ipcMain.handle('controller:updateConfig', async (_event, patch: unknown) => {
    const safe = (patch ?? {}) as Partial<ControllerSettings>
    const allowed: Partial<ControllerSettings> = {}
    if (typeof safe.enabled === 'boolean') allowed.enabled = safe.enabled
    if (typeof safe.host === 'string') allowed.host = safe.host
    if (typeof safe.port === 'number') allowed.port = safe.port
    if (typeof safe.allowLan === 'boolean') allowed.allowLan = safe.allowLan
    if (typeof safe.sseEnabled === 'boolean') allowed.sseEnabled = safe.sseEnabled
    if (Array.isArray(safe.allowedOrigins)) allowed.allowedOrigins = safe.allowedOrigins
    await applyConfig(allowed)
    return srv.status()
  })

  ipcMain.handle('controller:start', async () => {
    setControllerSettings({ enabled: true })
    const res = await srv.start()
    return res.status
  })

  ipcMain.handle('controller:stop', async () => {
    setControllerSettings({ enabled: false })
    const res = await srv.stop()
    return res.status
  })

  ipcMain.handle('controller:restart', async () => {
    const res = await srv.restart()
    return res.status
  })

  ipcMain.handle('controller:regenerateToken', () => srv.regenerateToken())
}

/** On app boot, start the controller only if the user previously enabled it. */
export async function startControllerIfEnabled(): Promise<void> {
  if (!getControllerSettings().enabled) return
  try {
    await getServer().start()
  } catch {
    /* never block app startup on the optional controller */
  }
}

export async function stopController(): Promise<void> {
  if (server?.isRunning()) await server.stop()
}
