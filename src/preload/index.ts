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
    workspaceContext?: { projectName: string; projectPath: string }
  }): Promise<unknown> => ipcRenderer.invoke('chat:send', args),

  cancel: (requestId: string): void => {
    ipcRenderer.send('chat:cancel', { requestId })
  },

  /** Phase 14.2: read-only memory/context stats for a session (no model call). */
  contextInfo: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('chat:contextInfo', { sessionId }),

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
  remove: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('history:delete', { sessionId }),
  /** Phase 14.2: reset context for ONE session (clears its messages + summary). */
  clearMessages: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('history:clearMessages', { sessionId })
})

const projects = Object.freeze({
  list: (): Promise<unknown> => ipcRenderer.invoke('projects:list'),
  create: (args: unknown): Promise<unknown> => ipcRenderer.invoke('projects:create', args),
  openFolder: (projectId?: string | null): Promise<unknown> =>
    ipcRenderer.invoke('projects:openFolder', { projectId }),
  createFolder: (args: unknown): Promise<unknown> => ipcRenderer.invoke('projects:createFolder', args),
  pickDirectory: (): Promise<unknown> => ipcRenderer.invoke('projects:pickDirectory'),
  update: (projectId: string, patch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('projects:update', { projectId, patch }),
  /** Phase 14.3: remove a project from Akorith (DB only; never deletes disk files). */
  remove: (projectId: string): Promise<unknown> =>
    ipcRenderer.invoke('projects:delete', { projectId }),
  /** Phase 14.4: reveal the project's folder in Finder/Explorer (read-only). */
  reveal: (projectId: string): Promise<unknown> =>
    ipcRenderer.invoke('projects:reveal', { projectId })
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
  setSettings: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('test:setSettings', patch),
  resolveSource: (source: string): Promise<unknown> => ipcRenderer.invoke('test:resolveSource', { source }),
  detect: (sourceRepo: string): Promise<unknown> => ipcRenderer.invoke('test:detect', { sourceRepo }),
  context: (sourceRepo: string): Promise<unknown> => ipcRenderer.invoke('test:context', { sourceRepo }),
  run: (args: unknown): Promise<unknown> => ipcRenderer.invoke('test:run', args),
  persistRun: (args: unknown): Promise<unknown> => ipcRenderer.invoke('test:persistRun', args),
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

const benchmark = Object.freeze({
  list: (limit?: number): Promise<unknown> => ipcRenderer.invoke('benchmark:list', { limit }),
  get: (id: string): Promise<unknown> => ipcRenderer.invoke('benchmark:get', id),
  upsert: (input: unknown): Promise<unknown> => ipcRenderer.invoke('benchmark:upsert', input),
  exportForWeb: (): Promise<unknown> => ipcRenderer.invoke('benchmark:export')
})

const macro = Object.freeze({
  createSession: (args: unknown): Promise<unknown> => ipcRenderer.invoke('macro:createSession', args),
  // Phase 20: scaffold an everyday-dev project + bind an auto-commit loop to it.
  createWorkspaceProject: (args: unknown): Promise<unknown> => ipcRenderer.invoke('workspace:createProject', args),
  propose: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:propose', { sessionId }),
  approve: (args: unknown): Promise<unknown> => ipcRenderer.invoke('macro:approve', args),
  recordResult: (args: unknown): Promise<unknown> => ipcRenderer.invoke('macro:recordResult', args),
  skip: (args: unknown): Promise<unknown> => ipcRenderer.invoke('macro:skip', args),
  stop: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:stop', { sessionId }),
  complete: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:complete', { sessionId }),
  archive: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:archive', { sessionId }),
  remove: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:remove', { sessionId }),
  setMode: (sessionId: string, mode: string): Promise<unknown> => ipcRenderer.invoke('macro:setMode', { sessionId, mode }),
  setPlanner: (args: unknown): Promise<unknown> => ipcRenderer.invoke('macro:setPlanner', args),
  steer: (sessionId: string, choice: string): Promise<unknown> => ipcRenderer.invoke('macro:steer', { sessionId, choice }),
  startAuto: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:startAuto', { sessionId }),
  summarize: (args: unknown): Promise<unknown> => ipcRenderer.invoke('macro:summarize', args),
  detectPermission: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:detectPermission', { sessionId }),
  respondPermission: (args: unknown): Promise<unknown> => ipcRenderer.invoke('macro:respondPermission', args),
  inspectWorkspace: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:inspectWorkspace', { sessionId }),
  syncWorkspace: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:syncWorkspace', { sessionId }),
  listRuns: (sessionId: string, limit?: number): Promise<unknown> => ipcRenderer.invoke('macro:listRuns', { sessionId, limit }),
  listEvents: (sessionId: string, limit?: number): Promise<unknown> => ipcRenderer.invoke('macro:listEvents', { sessionId, limit }),
  get: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('macro:get', { sessionId }),
  list: (limit?: number): Promise<unknown> => ipcRenderer.invoke('macro:list', { limit })
})

const agent = Object.freeze({
  getRuntimeSnapshot: (): Promise<unknown> => ipcRenderer.invoke('agent:getRuntimeSnapshot'),
  summarize: (args: unknown): Promise<unknown> => ipcRenderer.invoke('agent:summarize', args),
  detectPermission: (terminalId: string): Promise<unknown> =>
    ipcRenderer.invoke('agent:detectPermission', { terminalId })
})

const mission = Object.freeze({
  listTemplates: (): Promise<unknown> => ipcRenderer.invoke('mission:listTemplates'),
  createDraft: (args: unknown): Promise<unknown> => ipcRenderer.invoke('mission:createDraft', args),
  createFromTemplate: (templateId: string, input?: unknown): Promise<unknown> =>
    ipcRenderer.invoke('mission:createFromTemplate', { templateId, input }),
  list: (): Promise<unknown> => ipcRenderer.invoke('mission:list'),
  get: (id: string): Promise<unknown> => ipcRenderer.invoke('mission:get', { id }),
  listEvents: (missionId: string): Promise<unknown> => ipcRenderer.invoke('mission:listEvents', { missionId }),
  createSafePreviewPlan: (args: unknown): Promise<unknown> => ipcRenderer.invoke('mission:createSafePreviewPlan', args)
})

// App-level settings mirrored to config (currently the UI theme, so the
// startup splash can match the selected light/dark background).
const settings = Object.freeze({
  getTheme: (): Promise<unknown> => ipcRenderer.invoke('settings:getTheme'),
  setTheme: (theme: 'dark' | 'light'): Promise<unknown> => ipcRenderer.invoke('settings:setTheme', theme)
})

const windowControls = Object.freeze({
  close: (): Promise<unknown> => ipcRenderer.invoke('window:close'),
  minimize: (): Promise<unknown> => ipcRenderer.invoke('window:minimize'),
  toggleFullscreen: (): Promise<unknown> => ipcRenderer.invoke('window:toggleFullscreen')
})

const ollama = Object.freeze({
  getSettings: (): Promise<unknown> => ipcRenderer.invoke('ollama:getSettings'),
  getShareInfo: (): Promise<unknown> => ipcRenderer.invoke('ollama:getShareInfo'),
  setSettings: (args: unknown): Promise<unknown> => ipcRenderer.invoke('ollama:setSettings', args),
  testEndpoint: (baseUrl: string): Promise<unknown> => ipcRenderer.invoke('ollama:testEndpoint', { baseUrl }),
  // Phase 33.14: resolve the first healthy endpoint (configured → last → profiles).
  autoConnect: (): Promise<unknown> => ipcRenderer.invoke('ollama:autoConnect'),
  // Phase 42 (Remote Ollama): runtime-source summary + readiness, and Tailscale status.
  runtimeStatus: (): Promise<unknown> => ipcRenderer.invoke('runtime:status'),
  tailscaleStatus: (): Promise<unknown> => ipcRenderer.invoke('runtime:tailscaleStatus')
})

// Phase 33.17: read-only git surface for the bottom workbench Changes panel.
const git = Object.freeze({
  status: (path: string): Promise<unknown> => ipcRenderer.invoke('git:status', { path })
})

// Phase 34.6: read-only GPU / local-runtime telemetry (no writes, no polling).
const gpu = Object.freeze({
  getStatus: (): Promise<unknown> => ipcRenderer.invoke('gpu:getStatus')
})

// Phase 36: remote GPU/runtime telemetry via a remote Akorith controller (read-only).
const telemetry = Object.freeze({
  getStatus: (): Promise<unknown> => ipcRenderer.invoke('telemetry:getStatus'),
  getProfiles: (): Promise<unknown> => ipcRenderer.invoke('telemetry:getProfiles'),
  saveProfiles: (profiles: unknown): Promise<unknown> => ipcRenderer.invoke('telemetry:saveProfiles', profiles),
  testProfile: (profile: unknown): Promise<unknown> => ipcRenderer.invoke('telemetry:testProfile', profile),
  revealToken: (id: string): Promise<unknown> => ipcRenderer.invoke('telemetry:revealToken', id)
})

// Phase 35: optional local controller API (read-only, loopback-default, token-gated).
const controller = Object.freeze({
  getConfig: (): Promise<unknown> => ipcRenderer.invoke('controller:getConfig'),
  updateConfig: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('controller:updateConfig', patch),
  getStatus: (): Promise<unknown> => ipcRenderer.invoke('controller:getStatus'),
  start: (): Promise<unknown> => ipcRenderer.invoke('controller:start'),
  stop: (): Promise<unknown> => ipcRenderer.invoke('controller:stop'),
  restart: (): Promise<unknown> => ipcRenderer.invoke('controller:restart'),
  regenerateToken: (): Promise<unknown> => ipcRenderer.invoke('controller:regenerateToken'),
  revealToken: (): Promise<unknown> => ipcRenderer.invoke('controller:revealToken'),
  getDocs: (): Promise<unknown> => ipcRenderer.invoke('controller:getDocs')
})

const plugins = Object.freeze({
  list: (): Promise<unknown> => ipcRenderer.invoke('plugins:list'),
  install: (id: string): Promise<unknown> => ipcRenderer.invoke('plugins:install', id),
  update: (id: string): Promise<unknown> => ipcRenderer.invoke('plugins:update', id),
  check: (id: string): Promise<unknown> => ipcRenderer.invoke('plugins:check', id),
  enable: (id: string): Promise<unknown> => ipcRenderer.invoke('plugins:enable', id),
  disable: (id: string): Promise<unknown> => ipcRenderer.invoke('plugins:disable', id),
  uninstall: (id: string): Promise<unknown> => ipcRenderer.invoke('plugins:uninstall', id),
  connect: (id: string): Promise<unknown> => ipcRenderer.invoke('plugins:connect', id),
  configure: (id: string): Promise<unknown> => ipcRenderer.invoke('plugins:configure', id)
})

// Phase 39: in-app source updater (read-only check; ff-only update after confirm).
const update = Object.freeze({
  status: (): Promise<unknown> => ipcRenderer.invoke('update:status'),
  settings: (): Promise<unknown> => ipcRenderer.invoke('update:settings'),
  setSettings: (value: unknown): Promise<unknown> => ipcRenderer.invoke('update:setSettings', value),
  check: (channel?: string): Promise<unknown> => ipcRenderer.invoke('update:check', channel),
  download: (): Promise<unknown> => ipcRenderer.invoke('update:download'),
  authorizeInstall: (): Promise<unknown> => ipcRenderer.invoke('update:authorizeInstall'),
  install: (token: string): Promise<unknown> => ipcRenderer.invoke('update:install', token),
  onChanged: (callback: (snapshot: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown): void => callback(snapshot)
    ipcRenderer.on('update:changed', listener)
    return () => ipcRenderer.removeListener('update:changed', listener)
  }
})

// Phase 39: honest usage-limit visibility (recorded local usage + configured labels).
const usageLimits = Object.freeze({
  get: (): Promise<unknown> => ipcRenderer.invoke('usageLimits:get'),
  setConfig: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('usageLimits:setConfig', patch)
})

const appApi = Object.freeze({
  getStartupSnapshot: (request?: unknown): Promise<unknown> => ipcRenderer.invoke('app:getStartupSnapshot', request),
  getBuildInfo: (): Promise<unknown> => ipcRenderer.invoke('app:getBuildInfo'),
  getCurrency: (fetch?: boolean): Promise<unknown> => ipcRenderer.invoke('app:getCurrency', fetch === true)
})

// Shared local-first runtime used by Loop and internal execution providers.
const localRuntime = Object.freeze({
  listModels: (): Promise<unknown> => ipcRenderer.invoke('localRuntime:listModels'),
  defaultModel: (): Promise<unknown> => ipcRenderer.invoke('localRuntime:defaultModel'),
  status: (): Promise<unknown> => ipcRenderer.invoke('localRuntime:status')
})

// Phase 48: project-focused Loop — autonomous local project builder.
const autonomousLoop = Object.freeze({
  list: (): Promise<unknown> => ipcRenderer.invoke('autonomousLoop:list'),
  detail: (loopId: string): Promise<unknown> => ipcRenderer.invoke('autonomousLoop:detail', loopId),
  catalog: (requestId: string): Promise<unknown> => ipcRenderer.invoke('autonomousLoop:catalog', requestId),
  probe: (requestId: string, catalogModelId: string): Promise<unknown> =>
    ipcRenderer.invoke('autonomousLoop:probe', requestId, catalogModelId),
  create: (requestId: string, input: unknown): Promise<unknown> =>
    ipcRenderer.invoke('autonomousLoop:create', requestId, input),
  cancelRequest: (requestId: string): Promise<boolean> => ipcRenderer.invoke('autonomousLoop:cancelRequest', requestId),
  pause: (loopId: string): Promise<unknown> => ipcRenderer.invoke('autonomousLoop:pause', loopId),
  resume: (loopId: string): Promise<unknown> => ipcRenderer.invoke('autonomousLoop:resume', loopId),
  stop: (loopId: string): Promise<unknown> => ipcRenderer.invoke('autonomousLoop:stop', loopId),
  openRepository: (loopId: string): Promise<unknown> => ipcRenderer.invoke('autonomousLoop:openRepository', loopId),
  openGitHub: (loopId: string): Promise<unknown> => ipcRenderer.invoke('autonomousLoop:openGitHub', loopId),
  onChanged: (callback: (loopId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, loopId: string): void => callback(loopId)
    ipcRenderer.on('autonomousLoop:changed', listener)
    return () => ipcRenderer.removeListener('autonomousLoop:changed', listener)
  }
})

const dashboardTelemetry = Object.freeze({
  loadOverview: (): Promise<unknown> => ipcRenderer.invoke('dashboardTelemetry:overview'),
  loadHeatmap: (mode: 'daily' | 'weekly' | 'cumulative'): Promise<unknown> => ipcRenderer.invoke('dashboardTelemetry:heatmap', mode),
  loadGpuSnapshot: (): Promise<unknown> => ipcRenderer.invoke('dashboardTelemetry:gpu')
})

const remoteNodes = Object.freeze({
  list: (): Promise<unknown> => ipcRenderer.invoke('remoteNodes:list'),
  pair: (input: unknown): Promise<unknown> => ipcRenderer.invoke('remoteNodes:pair', input),
  test: (nodeId: string): Promise<unknown> => ipcRenderer.invoke('remoteNodes:test', nodeId),
  catalog: (nodeId: string, refresh = false): Promise<unknown> => ipcRenderer.invoke('remoteNodes:catalog', nodeId, refresh),
  revoke: (nodeId: string): Promise<boolean> => ipcRenderer.invoke('remoteNodes:revoke', nodeId),
  onChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('remoteNodes:changed', listener)
    return () => ipcRenderer.removeListener('remoteNodes:changed', listener)
  }
})

const benchmarkLab = Object.freeze({
  getCatalog: (): Promise<unknown> => ipcRenderer.invoke('benchmarkLab:catalog'),
  listRuns: (limit = 20): Promise<unknown> => ipcRenderer.invoke('benchmarkLab:list', limit),
  getRun: (runId: string): Promise<unknown> => ipcRenderer.invoke('benchmarkLab:get', runId),
  start: (input: unknown): Promise<unknown> => ipcRenderer.invoke('benchmarkLab:start', input),
  cancel: (runId: string): Promise<unknown> => ipcRenderer.invoke('benchmarkLab:cancel', runId)
})

const api = Object.freeze({ app: appApi, pty, chat, bridge, history, projects, usage, router, digest, test, benchmark, benchmarkLab, evaluate, macro, agent, mission, settings, windowControls, ollama, git, gpu, telemetry, dashboardTelemetry, remoteNodes, controller, plugins, update, usageLimits, localRuntime, autonomousLoop })

contextBridge.exposeInMainWorld('api', api)
