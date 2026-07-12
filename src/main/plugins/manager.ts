import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { setControllerPluginProvider } from '../controller'
import { PluginMarketplaceService } from '../plugin-marketplace'

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

function action(idValue: unknown, operation: (id: string) => unknown): unknown {
  const id = pluginId(idValue)
  return operation(id)
}

export function registerPluginIpc(): void {
  setControllerPluginProvider(() => marketplace().list())

  ipcMain.handle('plugins:list', () => marketplace().list())
  ipcMain.handle('plugins:install', (_event, id: unknown) => action(id, (value) => marketplace().install(value)))
  ipcMain.handle('plugins:update', (_event, id: unknown) => action(id, (value) => marketplace().update(value)))
  ipcMain.handle('plugins:enable', (_event, id: unknown) => action(id, (value) => marketplace().enable(value)))
  ipcMain.handle('plugins:disable', (_event, id: unknown) => action(id, (value) => marketplace().disable(value)))
  ipcMain.handle('plugins:uninstall', (_event, id: unknown) => action(id, (value) => marketplace().uninstall(value)))
  ipcMain.handle('plugins:check', (_event, id: unknown) => action(id, (value) => marketplace().check(value)))
  ipcMain.handle('plugins:connect', (_event, id: unknown) => action(id, (value) => marketplace().connect(value)))
  ipcMain.handle('plugins:configure', (_event, id: unknown) => action(id, (value) => marketplace().configure(value)))
}
