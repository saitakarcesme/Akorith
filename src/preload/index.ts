import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// Every method here is a thin, typed shim over a vetted IPC channel — the
// renderer never sees ipcRenderer itself. Payloads are routed strictly by
// terminal id on both sides.
//
interface PtyDataPayload {
  id: string
  data: string
}

interface PtyExitPayload {
  id: string
  code: number
}

const pty = Object.freeze({
  create: (id: string, options: { cols: number; rows: number; cwd?: string; commandKind?: string }): Promise<unknown> =>
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

  /** Phase 13.3: set which project's session logical bridge targets resolve to. */
  setActiveProject: (projectKey: string): void => {
    ipcRenderer.send('pty:setActiveProject', { projectKey })
  },

  /** Read-only bounded snapshot of a terminal's recent output (Phase 11). */
  snapshot: (id: string, maxChars?: number): Promise<unknown> =>
    ipcRenderer.invoke('pty:snapshot', { id, maxChars }),

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

  send: (args: {
    requestId: string
    providerId: string
    model?: string
    prompt: string
    sessionId?: string
    includeDigest?: boolean
  }): Promise<unknown> => ipcRenderer.invoke('chat:send', args),

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

const bridge = Object.freeze({
  send: (args: { text: string; targetTerminalId: string; autoEnter: boolean }): Promise<unknown> =>
    ipcRenderer.invoke('bridge:send', args),

  getSettings: (): Promise<unknown> => ipcRenderer.invoke('bridge:getSettings'),

  setAutoEnter: (autoEnter: boolean): Promise<unknown> =>
    ipcRenderer.invoke('bridge:setAutoEnter', autoEnter)
})

const history = Object.freeze({
  list: (): Promise<unknown> => ipcRenderer.invoke('history:list'),
  messages: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('history:messages', { sessionId }),
  create: (providerId: string, title: string, projectId?: string | null): Promise<unknown> =>
    ipcRenderer.invoke('history:create', { providerId, title, projectId }),
  rename: (sessionId: string, title: string): Promise<unknown> =>
    ipcRenderer.invoke('history:rename', { sessionId, title }),
  remove: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('history:delete', { sessionId })
})

const projects = Object.freeze({
  list: (): Promise<unknown> => ipcRenderer.invoke('projects:list'),
  create: (args: unknown): Promise<unknown> => ipcRenderer.invoke('projects:create', args),
  openFolder: (projectId?: string | null): Promise<unknown> =>
    ipcRenderer.invoke('projects:openFolder', { projectId }),
  createFolder: (args: unknown): Promise<unknown> => ipcRenderer.invoke('projects:createFolder', args),
  pickDirectory: (): Promise<unknown> => ipcRenderer.invoke('projects:pickDirectory'),
  update: (projectId: string, patch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('projects:update', { projectId, patch })
})

const usage = Object.freeze({
  summary: (): Promise<unknown> => ipcRenderer.invoke('usage:summary'),
  daily: (days: number): Promise<unknown> => ipcRenderer.invoke('usage:daily', { days })
})

// Suggest-only router: returns a suggestion; never changes anything itself.
const router = Object.freeze({
  suggest: (prompt: string): Promise<unknown> => ipcRenderer.invoke('router:suggest', { prompt })
})

// Opt-in repo context digest settings (the digest is built in main at send time).
const digest = Object.freeze({
  getSettings: (): Promise<unknown> => ipcRenderer.invoke('digest:getSettings'),
  setEnabled: (enabled: boolean): Promise<unknown> => ipcRenderer.invoke('digest:setEnabled', enabled),
  setWorkingDir: (dir: string): Promise<unknown> => ipcRenderer.invoke('digest:setWorkingDir', dir)
})

interface TestOutputPayload {
  runId: string
  chunk: string
}

// Phase 7 test page: generate-and-run is orchestrated by the renderer; the
// sandboxed execution + metrics live in main behind these channels.
const test = Object.freeze({
  getSettings: (): Promise<unknown> => ipcRenderer.invoke('test:getSettings'),
  setSourceRepo: (dir: string): Promise<unknown> => ipcRenderer.invoke('test:setSourceRepo', dir),
  detect: (sourceRepo: string): Promise<unknown> => ipcRenderer.invoke('test:detect', { sourceRepo }),
  run: (args: unknown): Promise<unknown> => ipcRenderer.invoke('test:run', args),
  stop: (runId: string): void => {
    ipcRenderer.send('test:stop', { runId })
  },
  listRuns: (limit?: number): Promise<unknown> => ipcRenderer.invoke('test:listRuns', { limit }),
  onOutput: (listener: (payload: { runId: string; chunk: string }) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: TestOutputPayload): void => listener(payload)
    ipcRenderer.on('test:output', handler)
    return () => ipcRenderer.removeListener('test:output', handler)
  }
})

const evaluate = Object.freeze({
  getSettings: (): Promise<unknown> => ipcRenderer.invoke('evaluate:getSettings'),
  list: (limit?: number): Promise<unknown> => ipcRenderer.invoke('evaluate:list', { limit }),
  run: (args: unknown): Promise<unknown> => ipcRenderer.invoke('evaluate:run', args),
  exportPdf: (evaluationId: string): Promise<unknown> =>
    ipcRenderer.invoke('evaluate:exportPdf', { evaluationId }),
  revealPdf: (evaluationId: string): Promise<unknown> =>
    ipcRenderer.invoke('evaluate:revealPdf', { evaluationId }),
  openPdf: (evaluationId: string): Promise<unknown> =>
    ipcRenderer.invoke('evaluate:openPdf', { evaluationId })
})

const macro = Object.freeze({
  createSession: (args: unknown): Promise<unknown> => ipcRenderer.invoke('macro:createSession', args),
  propose: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:propose', { sessionId }),
  approve: (args: unknown): Promise<unknown> => ipcRenderer.invoke('macro:approve', args),
  recordResult: (args: unknown): Promise<unknown> => ipcRenderer.invoke('macro:recordResult', args),
  skip: (args: unknown): Promise<unknown> => ipcRenderer.invoke('macro:skip', args),
  stop: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:stop', { sessionId }),
  complete: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:complete', { sessionId }),
  setMode: (sessionId: string, mode: string): Promise<unknown> => ipcRenderer.invoke('macro:setMode', { sessionId, mode }),
  startAuto: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:startAuto', { sessionId }),
  summarize: (args: unknown): Promise<unknown> => ipcRenderer.invoke('macro:summarize', args),
  detectPermission: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:detectPermission', { sessionId }),
  respondPermission: (args: unknown): Promise<unknown> => ipcRenderer.invoke('macro:respondPermission', args),
  get: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:get', { sessionId }),
  list: (limit?: number): Promise<unknown> => ipcRenderer.invoke('macro:list', { limit })
})

const agent = Object.freeze({
  // Phase 13.2: read a terminal snapshot and summarize it into chat (meta call).
  summarize: (args: unknown): Promise<unknown> => ipcRenderer.invoke('agent:summarize', args)
})

const api = Object.freeze({ pty, chat, bridge, history, projects, usage, router, digest, test, evaluate, macro, agent })

contextBridge.exposeInMainWorld('api', api)
