import { app, BrowserWindow, ipcMain } from 'electron'
import { getUpdateSettings, setUpdateSettings, type UpdateSettings } from '../config'
import { loadOptionalElectronUpdater } from './packaged-adapter'
import { PackagedUpdaterService } from './packaged-service'
import type { PackagedUpdateSnapshot } from './packaged-types'

let servicePromise: Promise<PackagedUpdaterService> | null = null
let unsubscribe: (() => void) | null = null
let automaticTimer: NodeJS.Timeout | null = null

async function service(): Promise<PackagedUpdaterService> {
  if (!servicePromise) {
    servicePromise = (async () => {
      const loaded = await loadOptionalElectronUpdater()
      const settings = getUpdateSettings()
      const instance = new PackagedUpdaterService({
        runtime: {
          appVersion: app.getVersion(),
          isPackaged: app.isPackaged,
          platform: process.platform,
          // electron-builder embeds the public GitHub Releases provider from package.json.
          feedConfigured: true
        },
        updater: loaded.updater,
        initialChannel: settings.channel
      })
      unsubscribe = instance.subscribe((snapshot) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send('update:changed', snapshot)
        }
      })
      return instance
    })()
  }
  return servicePromise
}

function safeSettings(value: unknown): Partial<UpdateSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  return {
    ...(typeof raw.automaticChecks === 'boolean' ? { automaticChecks: raw.automaticChecks } : {}),
    ...(raw.channel === 'stable' || raw.channel === 'beta' ? { channel: raw.channel } : {})
  }
}

export function registerUpdateIpc(): void {
  ipcMain.handle('update:status', async (): Promise<PackagedUpdateSnapshot> => (await service()).getSnapshot())
  ipcMain.handle('update:settings', (): UpdateSettings => getUpdateSettings())
  ipcMain.handle('update:setSettings', (_event, value: unknown): UpdateSettings => setUpdateSettings(safeSettings(value)))
  ipcMain.handle('update:check', async (_event, channel?: unknown): Promise<PackagedUpdateSnapshot> => {
    const settings = getUpdateSettings()
    return (await service()).checkForUpdates(channel ?? settings.channel)
  })
  ipcMain.handle('update:download', async (): Promise<PackagedUpdateSnapshot> => (await service()).downloadUpdate())
  ipcMain.handle('update:authorizeInstall', async () => (await service()).authorizeInstall() ?? null)
  ipcMain.handle('update:install', async (_event, token: unknown): Promise<PackagedUpdateSnapshot> =>
    (await service()).installAuthorizedUpdate(token)
  )

  void service().then((updater) => {
    if (!getUpdateSettings().automaticChecks || !updater.getSnapshot().support.supported) return
    automaticTimer = setTimeout(() => {
      automaticTimer = null
      void updater.checkForUpdates(getUpdateSettings().channel)
    }, 12_000)
    automaticTimer.unref?.()
  }).catch(() => undefined)
}

export function disposeUpdateIpc(): void {
  if (automaticTimer) clearTimeout(automaticTimer)
  automaticTimer = null
  unsubscribe?.()
  unsubscribe = null
  void servicePromise?.then((value) => value.dispose()).catch(() => undefined)
  servicePromise = null
}
