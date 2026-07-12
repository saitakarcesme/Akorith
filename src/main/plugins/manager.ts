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

export function registerPluginIpc(): void {
  setControllerPluginProvider(() => marketplace().list())

  ipcMain.handle('plugins:list', () => marketplace().list())
  ipcMain.handle('plugins:install', (_event, id: unknown) => marketplace().install(pluginId(id)))
  ipcMain.handle('plugins:update', (_event, id: unknown) => marketplace().update(pluginId(id)))
  ipcMain.handle('plugins:enable', (_event, id: unknown) => marketplace().enable(pluginId(id)))
  ipcMain.handle('plugins:disable', (_event, id: unknown) => marketplace().disable(pluginId(id)))
  ipcMain.handle('plugins:uninstall', (_event, id: unknown) => marketplace().uninstall(pluginId(id)))
  ipcMain.handle('plugins:check', (_event, id: unknown) => marketplace().check(pluginId(id)))
  ipcMain.handle('plugins:connect', (_event, id: unknown) => marketplace().connect(pluginId(id)))
  ipcMain.handle('plugins:configure', (_event, id: unknown) => marketplace().configure(pluginId(id)))
}
