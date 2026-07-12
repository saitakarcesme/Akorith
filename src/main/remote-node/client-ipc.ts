import { BrowserWindow, ipcMain } from 'electron'
import type { PairRemoteNodeInput } from './client-manager-types'
import { getRemoteNodeClientManager } from './client-runtime'

function pairInput(value: unknown): PairRemoteNodeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Remote node pairing input is required.')
  const input = value as Record<string, unknown>
  if (typeof input.baseUrl !== 'string' || typeof input.pairingId !== 'string' || typeof input.code !== 'string' || typeof input.deviceName !== 'string') {
    throw new Error('Remote node address, pairing id, code, and client name are required.')
  }
  return {
    baseUrl: input.baseUrl,
    pairingId: input.pairingId,
    code: input.code,
    deviceName: input.deviceName,
    ...(input.acknowledgePrivateLanHttp === true ? { acknowledgePrivateLanHttp: true } : {})
  }
}

function nodeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error('A valid remote node id is required.')
  return value
}

export function registerRemoteNodeClientIpc(): void {
  const manager = getRemoteNodeClientManager()
  manager.subscribe(() => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('remoteNodes:changed')
  })
  ipcMain.handle('remoteNodes:list', () => manager.list())
  ipcMain.handle('remoteNodes:pair', (_event, input: unknown) => manager.pair(pairInput(input)))
  ipcMain.handle('remoteNodes:test', (_event, id: unknown) => manager.test(nodeId(id)))
  ipcMain.handle('remoteNodes:catalog', (_event, id: unknown, refresh: unknown) => manager.catalog(nodeId(id), refresh === true))
  ipcMain.handle('remoteNodes:revoke', (_event, id: unknown) => manager.revoke(nodeId(id)))
}
