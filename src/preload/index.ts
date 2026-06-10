import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// Every method here is a thin, typed shim over a vetted IPC channel — the
// renderer never sees ipcRenderer itself. Payloads are routed strictly by
// terminal id on both sides.
//
// TODO(phase 4): bridge API — sendPromptToTerminal(terminalId, text); in the main
//                process it funnels into the same PtyManager.write() as pty.input.
// TODO(phase 5): history API — list/load/save sessions (SQLite).

interface PtyDataPayload {
  id: string
  data: string
}

interface PtyExitPayload {
  id: string
  code: number
}

const pty = Object.freeze({
  create: (id: string, options: { cols: number; rows: number; cwd?: string }): Promise<void> =>
    ipcRenderer.invoke('pty:create', { id, ...options }),

  input: (id: string, data: string): void => {
    ipcRenderer.send('pty:input', { id, data })
  },

  resize: (id: string, cols: number, rows: number): void => {
    ipcRenderer.send('pty:resize', { id, cols, rows })
  },

  kill: (id: string): void => {
    ipcRenderer.send('pty:kill', { id })
  },

  onData: (id: string, listener: (data: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: PtyDataPayload): void => {
      if (payload.id === id) listener(payload.data)
    }
    ipcRenderer.on('pty:data', handler)
    return () => ipcRenderer.removeListener('pty:data', handler)
  },

  onExit: (id: string, listener: (code: number) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: PtyExitPayload): void => {
      if (payload.id === id) listener(payload.code)
    }
    ipcRenderer.on('pty:exit', handler)
    return () => ipcRenderer.removeListener('pty:exit', handler)
  }
})

interface ChatTokenPayload {
  requestId: string
  token: string
}

const chat = Object.freeze({
  listProviders: (): Promise<unknown> => ipcRenderer.invoke('chat:providers'),

  send: (args: { requestId: string; providerId: string; model?: string; prompt: string }): Promise<unknown> =>
    ipcRenderer.invoke('chat:send', args),

  cancel: (requestId: string): void => {
    ipcRenderer.send('chat:cancel', { requestId })
  },

  onToken: (requestId: string, listener: (token: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: ChatTokenPayload): void => {
      if (payload.requestId === requestId) listener(payload.token)
    }
    ipcRenderer.on('chat:token', handler)
    return () => ipcRenderer.removeListener('chat:token', handler)
  }
})

const api = Object.freeze({ pty, chat })

contextBridge.exposeInMainWorld('api', api)
