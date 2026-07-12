import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { setControllerPluginProvider } from '../controller'
import { PluginMarketplaceService } from '../plugin-marketplace'
import { recordTelemetryEvent } from '../telemetry'

let service: PluginMarketplaceService | null = null

function marketplace(): PluginMarketplaceService {
  if (!service) {
    service = new PluginMarketplaceService(join(app.getPath('userData'), 'plugin-marketplace.json'))
  }
  return service
}

function pluginId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error('A valid plugin id is required.')
  }
  return value
}

function action(idValue: unknown, kind: string, operation: (id: string) => unknown): unknown {
  const id = pluginId(idValue)
  const startedAt = Date.now()
  try {
    const result = operation(id)
    recordTelemetryEvent({
      kind: 'plugin_invocation', pluginId: id, outcome: 'completed', occurredAt: Date.now(),
      durationMs: Math.max(0, Date.now() - startedAt), taskType: 'plugin', metadata: { action: kind }
    })
    return result
  } catch (error) {
    recordTelemetryEvent({
      kind: 'plugin_invocation', pluginId: id, outcome: 'failed', occurredAt: Date.now(),
      durationMs: Math.max(0, Date.now() - startedAt), taskType: 'plugin', metadata: { action: kind }
    })
    throw error
  }
}

export function registerPluginIpc(): void {
  setControllerPluginProvider(() => marketplace().list())

  ipcMain.handle('plugins:list', () => marketplace().list())
  ipcMain.handle('plugins:install', (_event, id: unknown) => action(id, 'install', (value) => marketplace().install(value)))
  ipcMain.handle('plugins:update', (_event, id: unknown) => action(id, 'update', (value) => marketplace().update(value)))
  ipcMain.handle('plugins:enable', (_event, id: unknown) => action(id, 'enable', (value) => marketplace().enable(value)))
  ipcMain.handle('plugins:disable', (_event, id: unknown) => action(id, 'disable', (value) => marketplace().disable(value)))
  ipcMain.handle('plugins:uninstall', (_event, id: unknown) => action(id, 'uninstall', (value) => marketplace().uninstall(value)))
  ipcMain.handle('plugins:check', (_event, id: unknown) => action(id, 'check', (value) => marketplace().check(value)))
  ipcMain.handle('plugins:connect', (_event, id: unknown) => action(id, 'connect', (value) => marketplace().connect(value)))
  ipcMain.handle('plugins:configure', (_event, id: unknown) => action(id, 'configure', (value) => marketplace().configure(value)))
}
