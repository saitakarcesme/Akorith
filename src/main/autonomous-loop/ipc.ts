import { BrowserWindow, ipcMain, shell } from 'electron'
import { ensureDbReady } from '../db'
import { getAutonomousLoopRuntime } from './runtime'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:%-]{0,699}$/
const activeRequests = new Map<string, AbortController>()
let registered = false
let unsubscribe: (() => void) | null = null

function id(value: unknown, label: string, max = 700): string {
  if (typeof value !== 'string' || value.length > max || !SAFE_ID.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\0/g, '').replace(/\b(token|secret|password)=\S+/gi, '$1=[redacted]').slice(0, 2_000)
}

async function runtime() {
  await ensureDbReady()
  return getAutonomousLoopRuntime()
}

async function request<T>(requestId: string, operation: (signal: AbortSignal) => Promise<T>) {
  if (activeRequests.has(requestId)) return { ok: false as const, error: 'A request with this id is already active.' }
  const controller = new AbortController()
  activeRequests.set(requestId, controller)
  try {
    return { ok: true as const, value: await operation(controller.signal) }
  } catch (error) {
    return { ok: false as const, error: safeError(error) }
  } finally {
    activeRequests.delete(requestId)
  }
}

export function registerAutonomousLoopIpc(): void {
  if (registered) return
  registered = true
  ipcMain.handle('autonomousLoop:list', async () => (await runtime()).list())
  ipcMain.handle('autonomousLoop:detail', async (_event, loopId: unknown) => (await runtime()).detail(id(loopId, 'Loop id', 160)))
  ipcMain.handle('autonomousLoop:catalog', (_event, requestId: unknown) => request(
    id(requestId, 'Request id', 160),
    async (signal) => (await runtime()).catalog(signal)
  ))
  ipcMain.handle('autonomousLoop:probe', (_event, requestId: unknown, catalogModelId: unknown) => request(
    id(requestId, 'Request id', 160),
    async (signal) => (await runtime()).probe(id(catalogModelId, 'Catalog model id'), signal)
  ))
  ipcMain.handle('autonomousLoop:create', (_event, requestId: unknown, input: unknown) => request(
    id(requestId, 'Request id', 160),
    async (signal) => (await runtime()).create(input, signal)
  ))
  ipcMain.handle('autonomousLoop:cancelRequest', (_event, requestId: unknown) => {
    const controller = activeRequests.get(id(requestId, 'Request id', 160))
    if (!controller) return false
    controller.abort(new Error('Request cancelled.'))
    return true
  })
  ipcMain.handle('autonomousLoop:pause', async (_event, loopId: unknown) => {
    try { return { ok: true, value: await (await runtime()).pause(id(loopId, 'Loop id', 160)) } }
    catch (error) { return { ok: false, error: safeError(error) } }
  })
  ipcMain.handle('autonomousLoop:resume', async (_event, loopId: unknown) => {
    try { return { ok: true, value: await (await runtime()).resume(id(loopId, 'Loop id', 160)) } }
    catch (error) { return { ok: false, error: safeError(error) } }
  })
  ipcMain.handle('autonomousLoop:stop', async (_event, loopId: unknown) => {
    try { return { ok: true, value: await (await runtime()).stop(id(loopId, 'Loop id', 160)) } }
    catch (error) { return { ok: false, error: safeError(error) } }
  })
  ipcMain.handle('autonomousLoop:openRepository', async (_event, loopId: unknown) => {
    const detail = (await runtime()).detail(id(loopId, 'Loop id', 160))
    if (!detail) return { ok: false, error: 'Loop not found.' }
    const error = await shell.openPath(detail.loop.workspacePath)
    return error ? { ok: false, error: safeError(error) } : { ok: true }
  })
  ipcMain.handle('autonomousLoop:openGitHub', async (_event, loopId: unknown) => {
    const detail = (await runtime()).detail(id(loopId, 'Loop id', 160))
    if (!detail || !detail.loop.remoteUrl.startsWith('https://github.com/')) {
      return { ok: false, error: 'Loop GitHub remote is unavailable.' }
    }
    await shell.openExternal(detail.loop.remoteUrl)
    return { ok: true }
  })
  void runtime().then((service) => {
    unsubscribe = service.subscribe((loopId) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('autonomousLoop:changed', loopId)
      }
    })
  }).catch(() => undefined)
}

export function unregisterAutonomousLoopIpc(): void {
  unsubscribe?.()
  unsubscribe = null
  for (const controller of activeRequests.values()) controller.abort(new Error('Application shutting down.'))
  activeRequests.clear()
}
