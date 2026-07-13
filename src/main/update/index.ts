import { ipcMain } from 'electron'
import { getUpdateStatus } from './checker'
import { runUpdate } from './runner'
import type { UpdateRunOptions } from './types'

// Phase 39: update IPC. check is read-only; run only fast-forwards main after the
// renderer confirms (and the runner re-checks safety internally).

export function registerUpdateIpc(): void {
  ipcMain.handle('update:status', async () => getUpdateStatus(false))
  ipcMain.handle('update:check', async () => getUpdateStatus(true))
  ipcMain.handle('update:run', async (_event, options: unknown) => {
    const safe = (options ?? {}) as Partial<UpdateRunOptions>
    return runUpdate({ runInstall: safe.runInstall === true, runBuild: safe.runBuild === true })
  })
}
