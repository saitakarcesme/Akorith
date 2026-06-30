import { ipcMain } from 'electron'
import { listLocalModels, defaultLocalModel } from './models'
import { localRuntimeStatus } from './status'
import type { LocalModelInfo } from './types'
import type { RuntimeStatus } from '../ollama-connection'

// Phase 47: shared local-first runtime used by Loop, Companions, and Agents.

export * from './types'
export { sendLocal } from './send'
export { sendStructured, extractJson, parseJsonLoose } from './structured'
export { listLocalModels, defaultLocalModel } from './models'
export { localRuntimeStatus, isLocalRuntimeReady } from './status'

export function registerLocalRuntimeIpc(): void {
  ipcMain.handle('localRuntime:listModels', async (): Promise<LocalModelInfo[]> => listLocalModels())
  ipcMain.handle('localRuntime:defaultModel', async (): Promise<string | undefined> => defaultLocalModel())
  ipcMain.handle('localRuntime:status', async (): Promise<RuntimeStatus> => localRuntimeStatus())
}
