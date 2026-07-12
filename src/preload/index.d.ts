// Shape of the preload bridge as seen from the renderer.
// Extended in lockstep with src/preload/index.ts.

export interface PtyCreateOptions {
  cols: number
  rows: number
  cwd?: string
  commandKind?: PtyCommandKind
}

export type PtyCommandKind =
  | 'shell'
  | 'codex'
  | 'claude'
  | 'claude-auto'
  | 'codex-auto'
  | 'opencode'
  | 'opencode-auto'

export type PtyCreateResponse =
  | { ok: true; started: PtyCommandKind; fallback?: boolean; message?: string; reused?: boolean }
  | { ok: false; error: string }

export interface PtySnapshot {
  id: string
  alive: boolean
  text: string
  chars: number
  truncated: boolean
}

export interface PtyApi {
  /** Spawn the platform shell in a PTY bound to this terminal id. */
  create(id: string, options: PtyCreateOptions): Promise<PtyCreateResponse>
  /** Send keystrokes/text to the shell's stdin. */
  input(id: string, data: string): void
  /** Propagate an xterm fit to the PTY so the shell reflows. */
  resize(id: string, cols: number, rows: number): void
  /** Kill the PTY process. */
  kill(id: string): void
  /** Set which project's session logical bridge targets resolve to (Phase 13.3). */
  setActiveProject(projectKey: string): void
  /** Read-only bounded snapshot of recent terminal output (Phase 11). */
  snapshot(id: string, maxChars?: number): Promise<PtySnapshot>
  /** Subscribe to shell output for this id. Returns an unsubscribe fn. */
  onData(id: string, listener: (data: string) => void): () => void
  /** Subscribe to shell exit for this id. Returns an unsubscribe fn. */
  onExit(id: string, listener: (code: number) => void): () => void
}

// ---- chat / providers (wire shapes mirroring src/main/providers/types.ts) ----

export type ProviderKind = 'chat' | 'executor'

export interface ProviderInfo {
  id: string
  label: string
  kind: ProviderKind[]
  available: { ok: boolean; reason?: string }
  models: string[]
}

export interface ChatUsage {
  promptTokens?: number
  completionTokens?: number
  costUsd?: number
  estimated: boolean
}

export interface ChatSendResult {
  text: string
  usage: ChatUsage
  model: string
  raw?: unknown
}

export type ChatSendResponse = { ok: true; result: ChatSendResult } | { ok: false; error: string }

export interface ChatImageAttachment {
  name: string
  mimeType: string
  dataBase64: string
}

export interface ChatSendRequest {
  requestId: string
  providerId: string
  model?: string
  prompt: string
  /** When set, the exchange + usage event are persisted to this session. */
  sessionId?: string
  /** False for General Chat; project workspace sends keep the existing opt-in repo digest behavior. */
  includeDigest?: boolean
  /** Workspace project scope; only project chats pass this. */
  workspaceContext?: { projectName: string; projectPath: string }
  images?: ChatImageAttachment[]
}

/** Phase 14.2: what conversation context a session would send (memory indicator). */
export interface ContextInfo {
  totalMessages: number
  includedVerbatim: number
  summarizedCount: number
  hasSummary: boolean
  approxChars: number
  approxTokens: number
}

export interface ChatApi {
  /** Providers from the registry (config-driven), with availability + models. */
  listProviders(): Promise<ProviderInfo[]>
  /** Send a prompt; tokens stream via onToken for the same requestId. */
  send(args: ChatSendRequest): Promise<ChatSendResponse>
  /** Abort an in-flight send. */
  cancel(requestId: string): void
  /** Subscribe to streamed tokens for a request. Returns an unsubscribe fn. */
  onToken(requestId: string, listener: (token: string) => void): () => void
  /** Phase 14.2: read-only memory/context stats for a session (no model call). */
  contextInfo(sessionId: string): Promise<ContextInfo>
}

// ---- chat→terminal bridge ----

export interface BridgeSettings {
  autoEnter: boolean
}

export interface BridgeSendRequest {
  text: string
  targetTerminalId: string
  autoEnter: boolean
}

export type BridgeSendResponse = { ok: true } | { ok: false; error: string }

export interface BridgeApi {
  /** Send text into a terminal via the single PtyManager.write() path. */
  send(args: BridgeSendRequest): Promise<BridgeSendResponse>
  getSettings(): Promise<BridgeSettings>
  /** Persist the auto-Enter setting to loopex.config.json. */
  setAutoEnter(autoEnter: boolean): Promise<BridgeSettings>
}

// ---- history (SQLite) ----

export interface SessionRow {
  id: string
  providerId: string
  title: string
  projectId: string | null
  createdAt: number
  updatedAt: number
}

export interface MessageRow {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  providerId: string
  model: string | null
  createdAt: number
}

export interface HistoryApi {
  list(): Promise<SessionRow[]>
  messages(sessionId: string): Promise<{ session: SessionRow; messages: MessageRow[] } | null>
  create(providerId: string, title: string, projectId?: string | null): Promise<SessionRow>
  rename(sessionId: string, title: string): Promise<boolean>
  remove(sessionId: string): Promise<boolean>
  /** Phase 14.2: reset context for ONE session (clears its messages + summary). */
  clearMessages(sessionId: string): Promise<boolean>
}

// ---- sidebar projects (Phase 9.1) ----

export interface ProjectRow {
  id: string
  name: string
  path: string | null
  color: string | null
  icon: string | null
  createdAt: number
  updatedAt: number
}

export interface ProjectCreateRequest {
  name: string
  path?: string | null
  color?: string | null
  icon?: string | null
}

export interface ProjectUpdateRequest {
  name?: string
  path?: string | null
  color?: string | null
  icon?: string | null
}

export interface ProjectsApi {
  list(): Promise<ProjectRow[]>
  create(args: ProjectCreateRequest): Promise<ProjectRow>
  openFolder(projectId?: string | null): Promise<{ ok: true; project: ProjectRow } | { ok: false; cancelled?: boolean; error: string }>
  createFolder(args: {
    name: string
    projectId?: string | null
    /** When set (from the Create Project modal) the native parent picker is skipped. */
    parentPath?: string | null
  }): Promise<{ ok: true; project: ProjectRow } | { ok: false; cancelled?: boolean; error: string }>
  /** Pick a parent directory for the Create Project modal (main-process dialog). */
  pickDirectory(): Promise<{ ok: true; path: string } | { ok: false; cancelled?: boolean; error: string }>
  update(projectId: string, patch: ProjectUpdateRequest): Promise<ProjectRow | null>
  /** Phase 14.3: remove a project from Akorith. DB-only; never deletes disk files. */
  remove(projectId: string): Promise<boolean>
  /** Phase 14.4: reveal the project's folder in Finder/Explorer (read-only). */
  reveal(projectId: string): Promise<{ ok: true } | { ok: false; error: string }>
}

// ---- app startup snapshot / hydration ----

export type StartupView = 'workspace' | 'general' | 'dashboard' | 'test' | 'loops' | 'plugins'

export interface StartupSnapshotRequest {
  lastActiveProjectId?: string | null
  lastActiveSessionId?: string | null
  lastView?: StartupView | string | null
  sidebarWidth?: number | string | null
  displayName?: string | null
}

export interface StartupRestoreTarget {
  view: StartupView
  projectId: string | null
  sessionId: string | null
  reason: string
}

export interface StartupHydrationCounts {
  projects: number
  chats: number
  projectChats: number
  generalChats: number
  orphanChats: number
}

export interface StartupMigrationCandidate {
  name: string
  path: string
  dbExists: boolean
  dbBytes: number
  configExists: boolean
}

export interface StartupMigrationDiagnostics {
  attempted: boolean
  copied: string[]
  skipped: string[]
  warnings: string[]
  candidates: StartupMigrationCandidate[]
}

export interface StartupSnapshot {
  app: {
    name: 'Akorith'
    userDataPath: string
    dbPath: string
    configPath: string
  }
  settings: {
    theme: AppTheme
    bridge: BridgeSettings
    digest: { enabled: boolean; workingDir: string }
    router: { classifierModel: string; tierProviders: Record<string, string | null> }
    providers: string[]
  }
  preferences: {
    displayName: string | null
    sidebarWidth: number | null
    lastView: StartupView
  }
  projects: ProjectRow[]
  sessions: SessionRow[]
  restore: StartupRestoreTarget
  diagnostics: {
    dbReady: boolean
    configReady: boolean
    loadedAt: number
    counts: StartupHydrationCounts
    warnings: string[]
    migration: StartupMigrationDiagnostics
  }
}

export interface BuildInfo {
  version: string
  gitCommit: string
  gitCommitFull: string
  gitBranch: string
  buildDate: string
  buildMode: string
  platform: string
  packaged: boolean
}

export interface AppCurrency {
  mode: 'git' | 'packaged'
  buildCommit: string
  repoHead?: string
  remoteMainHead?: string
  behindBy?: number
  isCurrent?: boolean
  note: string
  checkedAt: number
}

export interface AppApi {
  getStartupSnapshot(request?: StartupSnapshotRequest): Promise<StartupSnapshot>
  getBuildInfo(): Promise<BuildInfo>
  getCurrency(fetch?: boolean): Promise<AppCurrency>
}

// ---- legacy usage API retained for router compatibility ----

export interface ProviderUsageSummary {
  providerId: string
  events: number
  promptTokens: number
  completionTokens: number
  costUsd: number
  estimated: boolean
}

export interface UsageSummary {
  totalTokens: number
  totalCostUsd: number
  sessionCount: number
  byProvider: ProviderUsageSummary[]
}

export interface DailyUsageRow {
  day: string
  providerId: string
  events: number
  tokens: number
  estimated: boolean
}

export interface UsageApi {
  summary(): Promise<UsageSummary>
  daily(days: number): Promise<DailyUsageRow[]>
}

// ---- router (Phase 6: suggest-only) ----

export type RouterTier = 'Asker' | 'Albay' | 'General'

export interface RouterSuggestion {
  tier: RouterTier
  /** English rank shown alongside the tier (Soldier/Colonel/General). */
  rank: string
  classifiedBy: 'model' | 'heuristic'
  classifierModel?: string
  providerId: string
  providerLabel: string
  model?: string
  available: boolean
  degraded: boolean
  reason: string
  /** Usage-based limit warning (never an official plan limit). */
  warning?: string
}

export type RouterSuggestResponse =
  | { ok: true; suggestion: RouterSuggestion }
  | { ok: false; error: string }

export interface RouterApi {
  /** Propose a provider/model for the prompt. Suggestion only — never applies it. */
  suggest(prompt: string): Promise<RouterSuggestResponse>
}

// ---- repo context digest (Phase 6: opt-in) ----

export interface DigestSettings {
  enabled: boolean
  workingDir?: string
  maxDiffBytes: number
  maxTotalBytes: number
  treeDepth: number
}

export interface DigestApi {
  getSettings(): Promise<DigestSettings>
  /** Persist the "Include repo context" toggle. */
  setEnabled(enabled: boolean): Promise<DigestSettings>
  /** Persist the repo to digest (empty = the app's cwd). */
  setWorkingDir(dir: string): Promise<DigestSettings>
}

export interface PermissionOption {
  value: string
  label: string
  tone: 'affirm' | 'deny' | 'neutral'
  permanent?: boolean
}

export interface PermissionDetection {
  detected: boolean
  kind: 'numbered_choice' | 'yes_no' | 'press_enter' | 'allow_access' | 'generic_confirm' | 'none'
  suggestedAction: string
  riskLevel: 'low' | 'medium' | 'high'
  rationale: string
  requiresUserReview: boolean
  matchedText?: string
  question?: string
  options?: PermissionOption[]
}

export interface ExecutorSummary {
  changedFiles: string[]
  commandsRun: string[]
  testsRun: string | null
  failures: string[]
  currentStatus: string
  likelyNextStep: string
  confidence: number
  needsUserAttention: boolean
  source: 'model' | 'heuristic'
}

export type AgentSummaryResponse =
  | { ok: true; summary: ExecutorSummary; detection: PermissionDetection; signature: string; persisted: boolean }
  | { ok: false; error: string; signature?: string }

export type AgentPermissionResponse =
  | { ok: true; detection: PermissionDetection; alive: boolean }
  | { ok: false; error: string }

export type AgentId = 'claude' | 'codex' | 'ollama' | 'opencode' | 'memory'
export type AgentKind = 'cli' | 'local' | 'memory' | 'future'
export type AgentStatus = 'unknown' | 'available' | 'missing' | 'unauthenticated' | 'disabled' | 'error'
export type AgentCapability =
  | 'chat'
  | 'terminal'
  | 'exec'
  | 'streaming'
  | 'file_patch'
  | 'test_generation'
  | 'review'
  | 'commit'
  | 'memory'
  | 'skills'
  | 'automation'
  | 'mission_planning'

export interface AgentAdapterMetadata {
  id: AgentId
  displayName: string
  kind: AgentKind
  description: string
  executableName?: string
  status: AgentStatus
  capabilities: AgentCapability[]
  currentIntegrationNotes: string[]
  futureIntegrationNotes: string[]
  safetyNotes: string[]
}

export type AgentIntegrationStage =
  | 'metadata-only'
  | 'detection-ready'
  | 'session-placeholder-ready'
  | 'runtime-connected-existing-provider'
  | 'future-runtime'

export interface AgentRuntimeCapability {
  canCreateSession: boolean
  canSendMessage: boolean
  canStream: boolean
  canExecute: boolean
  canAttachToPty: boolean
  canUseExistingProvider: boolean
  canUseExistingTerminal: boolean
  isPlaceholder: boolean
}

export interface AgentAdapterInfo extends AgentAdapterMetadata {
  runtimeCapabilities: AgentRuntimeCapability
  integrationStage: AgentIntegrationStage
}

export interface AgentDetectionResult {
  id: AgentId
  status: AgentStatus
  version?: string
  executablePath?: string
  message?: string
  checkedAt: number
}

export type AgentSessionId = string
export type AgentSessionMode = 'chat' | 'terminal' | 'exec' | 'loop' | 'review' | 'memory'
export type AgentSessionStatus =
  | 'created'
  | 'starting'
  | 'running'
  | 'idle'
  | 'busy'
  | 'waiting_for_permission'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'unsupported'
export type AgentSessionOrigin = 'agent_hub' | 'chat' | 'terminal' | 'loop' | 'test_lab' | 'system'

export interface AgentSession {
  id: AgentSessionId
  agentId: AgentId
  mode: AgentSessionMode
  origin: AgentSessionOrigin
  status: AgentSessionStatus
  projectPath?: string
  title?: string
  createdAt: number
  updatedAt: number
  lastActivityAt?: number
  metadata?: Record<string, unknown>
  error?: string
}

export interface AgentSessionCreateInput {
  agentId: AgentId
  mode: AgentSessionMode
  origin: AgentSessionOrigin
  projectPath?: string
  title?: string
  metadata?: Record<string, unknown>
}

export type AgentSessionEventType = 'created' | 'status_changed' | 'stopped' | 'snapshot' | 'error' | 'note'

export interface AgentSessionEvent {
  id: string
  sessionId: AgentSessionId
  agentId: AgentId
  type: AgentSessionEventType
  message?: string
  timestamp: number
  metadata?: Record<string, unknown>
}

export type AgentRuntimeAttachmentKind =
  | 'provider_call'
  | 'pty_session'
  | 'ollama_connection'
  | 'loop_run'
  | 'test_run'
  | 'system'

export type AgentRuntimeAttachmentStatus =
  | 'observed'
  | 'active'
  | 'idle'
  | 'busy'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'unknown'

export interface AgentRuntimeAttachment {
  id: string
  kind: AgentRuntimeAttachmentKind
  agentId?: AgentId
  sessionId?: string
  externalId?: string
  status: AgentRuntimeAttachmentStatus
  sourceFile?: string
  projectPath?: string
  title?: string
  startedAt?: number
  updatedAt: number
  lastActivityAt?: number
  metadata?: Record<string, unknown>
  error?: string
}

export interface AgentRuntimeSnapshot {
  checkedAt: number
  activeProviderCalls: AgentRuntimeAttachment[]
  activePtySessions: AgentRuntimeAttachment[]
  ollamaStatus?: AgentRuntimeAttachment
  observedSessions: AgentSession[]
  notes?: string[]
}

export interface AgentApi {
  /** Internal runtime evidence used by the workbench, not a management screen. */
  getRuntimeSnapshot(): Promise<AgentRuntimeSnapshot>
  /** Phase 13.2: summarize a terminal's recent output into chat (meta call; no usage_event). */
  summarize(args: {
    terminalId: string
    providerId: string
    model?: string
    goal?: string
    lastPrompt?: string
    /** Phase 14.2: persist the summary into this chat session's memory. */
    sessionId?: string
  }): Promise<AgentSummaryResponse>
  /** Phase 14.1: read-only detection of a pending terminal permission/confirm prompt. */
  detectPermission(terminalId: string): Promise<AgentPermissionResponse>
}

// ---- app settings (Phase 15: theme mirrored for the startup splash) ----

export type AppTheme = 'dark' | 'light'

export interface SettingsApi {
  getTheme(): Promise<AppTheme>
  /** Persist the selected theme to loopex.config.json (read by the next splash). */
  setTheme(theme: AppTheme): Promise<AppTheme>
}

export interface WindowControlsApi {
  close(): Promise<void>
  minimize(): Promise<void>
  toggleFullscreen(): Promise<void>
}

export interface OllamaRemoteProfile {
  id: string
  name: string
  baseUrl: string
  priority: number
  enabled: boolean
  networkHint?: string
  lastStatus?: 'ok' | 'error' | 'unknown'
  lastError?: string
  lastModelCount?: number
  lastConnectedAt?: number
  lastCheckedAt?: number
}

export interface OllamaConnectionSettings {
  enabled: boolean
  baseUrl: string
  autoStart: boolean
  exposeLan: boolean
  lanDiscovery: boolean
  ollamaHost?: string
  remoteProfiles?: OllamaRemoteProfile[]
  lastSuccessfulBaseUrl?: string
}

export interface OllamaActiveEndpoint {
  baseUrl: string
  source: 'configured' | 'last' | 'profile' | 'tailscale' | 'controller'
  profileId?: string
  label: string
}

export interface TailscalePeer {
  hostName: string
  dnsName?: string
  ip: string
  online: boolean
  os?: string
  isSelf: boolean
}

export interface TailscaleStatus {
  installed: boolean
  running: boolean
  note?: string
  peers: TailscalePeer[]
}

export interface RuntimeStatus {
  ok: boolean
  source?: 'configured' | 'last' | 'profile' | 'tailscale' | 'controller'
  label?: string
  baseUrl?: string
  modelCount: number
  models: string[]
  readiness: 'ready' | 'attention' | 'offline' | 'setup'
  reason: string
  tailscale: { installed: boolean; running: boolean; peerCount: number }
  hasRemoteProfiles: boolean
  hasControllerProfiles: boolean
  lastSuccessfulBaseUrl?: string
  checkedAt: number
}

// Shared local-first runtime used by Loop and internal execution providers.
export interface LocalModelInfo {
  id: string
  label: string
}

export interface LocalRuntimeApi {
  listModels(): Promise<LocalModelInfo[]>
  defaultModel(): Promise<string | undefined>
  status(): Promise<RuntimeStatus>
}

export type OllamaAutoConnectResult =
  | { ok: true; active: OllamaActiveEndpoint; models: string[]; modelCount: number; switched: boolean }
  | { ok: false; error: string; lastSuccessfulBaseUrl?: string; triedCount: number }

export type OllamaConnectionTestResult =
  | { ok: true; baseUrl: string; models: string[]; modelCount: number }
  | { ok: false; baseUrl: string; error: string }

export type OllamaSettingsResponse =
  | { ok: true; settings: OllamaConnectionSettings }
  | { ok: false; error: string; settings: OllamaConnectionSettings }

export interface OllamaEndpointSuggestion {
  label: string
  baseUrl: string
  address: string
  kind: 'local' | 'lan' | 'vpn' | 'other'
  recommended: boolean
}

export interface OllamaShareInfo {
  hostName: string
  port: number
  endpoints: OllamaEndpointSuggestion[]
}

export interface OllamaApi {
  getSettings(): Promise<OllamaConnectionSettings>
  getShareInfo(): Promise<OllamaShareInfo>
  setSettings(args: Partial<OllamaConnectionSettings>): Promise<OllamaSettingsResponse>
  testEndpoint(baseUrl: string): Promise<OllamaConnectionTestResult>
  autoConnect(): Promise<OllamaAutoConnectResult>
  runtimeStatus(): Promise<RuntimeStatus>
  tailscaleStatus(): Promise<TailscaleStatus>
}

export interface GitChangeFile {
  status: string
  path: string
}

export type GitStatusResult =
  | { ok: true; isRepo: true; branch: string; files: GitChangeFile[]; truncated: boolean; stat: string; clean: boolean }
  | { ok: true; isRepo: false }
  | { ok: false; error: string }

export interface GitApi {
  status(path: string): Promise<GitStatusResult>
}

export interface GpuDevice {
  name: string
  utilizationPercent?: number
  memoryUsedMb?: number
  memoryTotalMb?: number
  temperatureC?: number
}

export interface GpuOllamaInfo {
  configuredBaseUrl: string
  endpointKind: 'local' | 'remote'
  note?: string
}

export interface GpuStatusResult {
  status: 'observed' | 'unavailable'
  reason?: string
  platform: string
  source: 'nvidia-smi' | 'none'
  gpus: GpuDevice[]
  ollama: GpuOllamaInfo
}

export interface GpuApi {
  getStatus(): Promise<GpuStatusResult>
}

export interface RemoteTelemetryProfileView {
  id: string
  name: string
  baseUrl: string
  enabled: boolean
  priority: number
  lastStatus?: 'ok' | 'error'
  lastError?: string
  lastCheckedAt?: number
  hasToken: boolean
  tokenMasked: string
}

export interface TelemetryStatus {
  source: 'remote' | 'local'
  profile?: { id: string; name: string; baseUrl: string }
  gpu: GpuStatusResult
  ollama?: { configuredBaseUrl?: string; endpointKind?: string; note?: string } & Record<string, unknown>
  checkedAt: number
  remoteError?: string
}

export interface TelemetryTestResult {
  ok: boolean
  message: string
  modelCount?: number
}

export interface TelemetryProfileInput {
  id?: string
  name: string
  baseUrl: string
  token?: string
  enabled: boolean
  priority: number
}

export interface TelemetryApi {
  getStatus(): Promise<TelemetryStatus>
  getProfiles(): Promise<RemoteTelemetryProfileView[]>
  saveProfiles(profiles: TelemetryProfileInput[]): Promise<RemoteTelemetryProfileView[]>
  testProfile(profile: TelemetryProfileInput): Promise<TelemetryTestResult>
  revealToken(id: string): Promise<string>
}

export interface ControllerStatus {
  enabled: boolean
  running: boolean
  host: string
  port: number
  baseUrl: string
  readOnly: boolean
  sseEnabled: boolean
  allowLan: boolean
  hasToken: boolean
  tokenMasked: string
  connectedClients: number
  lastStartedAt?: number
  lastError?: string
}

export interface ControllerConfigView {
  enabled: boolean
  host: string
  port: number
  allowLan: boolean
  readOnly: boolean
  sseEnabled: boolean
  allowedOrigins?: string[]
  lastStartedAt?: number
  lastError?: string
  hasToken: boolean
  tokenMasked: string
}

export interface ControllerEndpoint {
  method: 'GET' | 'POST'
  path: string
  summary: string
  auth: boolean
}

export interface ControllerDocs {
  app: string
  readOnly: boolean
  endpoints: ControllerEndpoint[]
}

export interface ControllerConfigPatch {
  enabled?: boolean
  host?: string
  port?: number
  allowLan?: boolean
  sseEnabled?: boolean
  allowedOrigins?: string[]
}

export interface ControllerApi {
  getConfig(): Promise<ControllerConfigView>
  updateConfig(patch: ControllerConfigPatch): Promise<ControllerStatus>
  getStatus(): Promise<ControllerStatus>
  start(): Promise<ControllerStatus>
  stop(): Promise<ControllerStatus>
  restart(): Promise<ControllerStatus>
  regenerateToken(): Promise<ControllerStatus>
  revealToken(): Promise<string>
  getDocs(): Promise<ControllerDocs>
}

export type PluginKind =
  | 'agent'
  | 'tool'
  | 'workbench'
  | 'automation'
  | 'model_provider'
  | 'integration'
  | 'memory'
  | 'browser'
  | 'telemetry'

export type PluginStatus = 'built_in' | 'available' | 'unavailable' | 'disabled' | 'planned' | 'error'

export type PluginPermission =
  | 'filesystem_read'
  | 'filesystem_write'
  | 'terminal_read'
  | 'terminal_write'
  | 'network'
  | 'git_read'
  | 'git_write'
  | 'browser'
  | 'memory_read'
  | 'memory_write'
  | 'model_runtime'
  | 'controller_api'
  | 'secrets'

export interface PluginDiagnostic {
  pluginId: string
  available: boolean
  status: PluginStatus
  message: string
  checkedAt: number
  details?: string
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  kind: PluginKind
  description: string
  status: PluginStatus
  permissions: PluginPermission[]
  entry?: string
  settingsSchema?: Record<string, unknown>
  safetyNotes: string[]
  docsUrl?: string
  builtIn: boolean
  enabled: boolean
  effectiveStatus: PluginStatus
  diagnostic?: PluginDiagnostic
}

export interface PluginSettingsView {
  disabled: string[]
  chromaEndpoint?: string
}

export interface PluginsApi {
  list(): Promise<PluginInfo[]>
  install(id: string): Promise<unknown>
  update(id: string): Promise<unknown>
  check(id: string): Promise<unknown>
  enable(id: string): Promise<unknown>
  disable(id: string): Promise<unknown>
  uninstall(id: string): Promise<unknown>
  connect(id: string): Promise<unknown>
  configure(id: string): Promise<unknown>
}

export interface DashboardTelemetryApi {
  loadOverview(): Promise<unknown>
  loadHeatmap(mode: 'daily' | 'weekly' | 'cumulative'): Promise<unknown>
  loadGpuSnapshot(): Promise<unknown>
}

export interface RemoteNodeConnectionView {
  phase: 'idle' | 'connecting' | 'online' | 'degraded' | 'offline'
  consecutiveFailures: number
  lastCheckedAt?: number
  lastHealthyAt?: number
  nextRetryAt?: number
  latencyMs?: number
  error?: string
}

export interface RemoteNodeView {
  id: string
  nodeId: string
  name: string
  baseUrl: string
  protocolVersion: string
  deviceId: string
  deviceName: string
  createdAt: number
  updatedAt: number
  privateLanHttpAcknowledged: boolean
  connection: RemoteNodeConnectionView
}

export interface PairRemoteNodeInputView {
  baseUrl: string
  pairingId: string
  code: string
  deviceName: string
  acknowledgePrivateLanHttp?: boolean
}

export interface RemoteNodesApi {
  list(): Promise<RemoteNodeView[]>
  pair(input: PairRemoteNodeInputView): Promise<unknown>
  test(nodeId: string): Promise<unknown>
  catalog(nodeId: string, refresh?: boolean): Promise<unknown>
  revoke(nodeId: string): Promise<boolean>
  onChanged(callback: () => void): () => void
}

export interface BenchmarkLabPreloadApi {
  getCatalog(): Promise<unknown>
  listRuns(limit?: number): Promise<unknown>
  getRun(runId: string): Promise<unknown>
  start(input: unknown): Promise<unknown>
  cancel(runId: string): Promise<unknown>
}

export type UpdateChannel = 'stable' | 'beta'
export type PackagedUpdatePhase = 'unsupported' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'installing' | 'error'

export interface PackagedUpdateSnapshot {
  phase: PackagedUpdatePhase
  channel: UpdateChannel
  currentVersion: string
  support: { supported: boolean; code: string; reason: string }
  update?: { version: string; releaseName?: string; releaseNotes?: string; releaseDate?: string; prerelease: boolean }
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number }
  error?: { code: string; message: string; retryable: boolean; at: number }
  checkedAt?: number
  updatedAt: number
  canCheck: boolean
  canDownload: boolean
  canAuthorizeInstall: boolean
  manualInstallRequired: true
}

export interface UpdateSettingsView {
  automaticChecks: boolean
  channel: UpdateChannel
}

export interface InstallAuthorizationView {
  token: string
  expiresAt: number
  version: string
}

export interface UpdateApi {
  status(): Promise<PackagedUpdateSnapshot>
  settings(): Promise<UpdateSettingsView>
  setSettings(value: Partial<UpdateSettingsView>): Promise<UpdateSettingsView>
  check(channel?: UpdateChannel): Promise<PackagedUpdateSnapshot>
  download(): Promise<PackagedUpdateSnapshot>
  authorizeInstall(): Promise<InstallAuthorizationView | null>
  install(token: string): Promise<PackagedUpdateSnapshot>
  onChanged(callback: (snapshot: PackagedUpdateSnapshot) => void): () => void
}

export interface UsageWindowRow {
  providerId: string
  events: number
  tokens: number
}

export interface UsageLimitConfig {
  claude5h?: string
  claudeWeekly?: string
  codex5h?: string
  codexWeekly?: string
  notes?: string
}

export interface UsageLimitView {
  windows: { fiveHour: UsageWindowRow[]; weekly: UsageWindowRow[] }
  config: UsageLimitConfig
  checkedAt: number
  note: string
}

export interface UsageLimitsApi {
  get(): Promise<UsageLimitView>
  setConfig(patch: Partial<UsageLimitConfig>): Promise<UsageLimitConfig>
}

export type AutonomousLoopStatus = 'setting_up' | 'running' | 'pausing' | 'paused' | 'stopping' | 'stopped' | 'completed' | 'error'
export type AutonomousLoopStage = 'idle' | 'observing' | 'analyzing' | 'inventory' | 'planning' | 'executing' | 'validating' | 'repairing' | 'reviewing' | 'committing' | 'pushing' | 'scheduling'

export interface AutonomousModelSelection {
  catalogId: string
  providerId: string
  model: string
  location: 'local' | 'remote' | 'cloud'
  nodeId?: string
  capabilityProbeId?: string
}

export interface AutonomousLoopRecord {
  id: string
  projectName: string
  status: AutonomousLoopStatus
  stage: AutonomousLoopStage
  repositoryId: string
  workspacePath: string
  remoteUrl: string
  branch: string
  executor: AutonomousModelSelection
  planner: AutonomousModelSelection
  createdAt: number
  updatedAt: number
  startedAt: number | null
  stoppedAt: number | null
  lastActivityAt: number | null
  nextCycleAt: number | null
  tokenUsage: { input: number; output: number; cached: number; costUsd: number }
  commitCount: number
  pushCount: number
  successfulTasks: number
  failedTasks: number
  stopReason: string | null
  error: string | null
}

export interface AutonomousLoopCycle {
  id: string
  index: number
  status: string
  stage: AutonomousLoopStage
  plannedTask: null | { title: string; reason: string; kind: string; acceptanceCriteria: string[] }
  repairAttempts: number
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  changedFiles: string[]
  commitSha: string | null
  commitMessage: string | null
  pushed: boolean
  summary: string | null
  error: string | null
}

export interface AutonomousLoopEvent {
  id: string
  loopId: string
  cycleId: string | null
  occurredAt: number
  stage: AutonomousLoopStage
  level: 'info' | 'success' | 'warning' | 'error'
  kind: string
  title: string
  summary: string
  details: Record<string, string | number | boolean | null>
}

export interface AutonomousLoopDetail {
  loop: AutonomousLoopRecord
  cycles: AutonomousLoopCycle[]
  events: AutonomousLoopEvent[]
}

export interface CatalogModelView {
  id: string
  providerId: string
  providerLabel: string
  source: 'local' | 'remote' | 'cloud'
  modelName: string
  displayLabel: string
  nodeId: string | null
  nodeName: string | null
  availability: { status: 'available' | 'unavailable' | 'unknown'; reason: string | null }
  contextWindowTokens: number | null
  quantization: string | null
  vramRequirementMb: number | null
  currentLoadPercent: number | null
  pingMs: number | null
  effectiveCapabilities: Record<string, { support: 'supported' | 'unsupported' | 'unknown'; source: string; verifiedAt: number | null }>
  latestProbe: null | { id: string; status: string; freshUntil: number | null; failureMessage?: string }
}

export interface CatalogDiscoveryView {
  catalog: { generatedAt: number; models: CatalogModelView[]; collisions: string[] }
  warnings: string[]
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface CreateAutonomousLoopInput {
  source:
    | { kind: 'new'; parentPath: string; projectName: string; remoteUrl?: string; createRemoteWithPlugin?: boolean; githubOwner?: string; githubVisibility?: 'private' | 'public' }
    | { kind: 'existing_github'; remoteUrl: string }
  executor: AutonomousModelSelection & { capabilityProbeId: string }
}

export interface AutonomousLoopOnboardingReview {
  loop: AutonomousLoopRecord
  plannerLabel: string
  remoteAccess: { canPush: boolean | null; message: string }
  initialIdentity: { summary: string; plan: string } | null
}

export interface AutonomousLoopApi {
  list(): Promise<AutonomousLoopRecord[]>
  detail(loopId: string): Promise<AutonomousLoopDetail | null>
  catalog(requestId: string): Promise<IpcResult<CatalogDiscoveryView>>
  probe(requestId: string, catalogModelId: string): Promise<IpcResult<{ id: string; status: string; failureMessage?: string }>>
  create(requestId: string, input: CreateAutonomousLoopInput): Promise<IpcResult<AutonomousLoopOnboardingReview>>
  cancelRequest(requestId: string): Promise<boolean>
  pause(loopId: string): Promise<IpcResult<AutonomousLoopRecord>>
  resume(loopId: string): Promise<IpcResult<AutonomousLoopRecord>>
  stop(loopId: string): Promise<IpcResult<AutonomousLoopRecord>>
  openRepository(loopId: string): Promise<{ ok: boolean; error?: string }>
  openGitHub(loopId: string): Promise<{ ok: boolean; error?: string }>
  onChanged(callback: (loopId: string) => void): () => void
}

export interface PreloadApi {
  app: AppApi
  pty: PtyApi
  chat: ChatApi
  bridge: BridgeApi
  history: HistoryApi
  projects: ProjectsApi
  usage: UsageApi
  router: RouterApi
  digest: DigestApi
  benchmarkLab: BenchmarkLabPreloadApi
  agent: AgentApi
  settings: SettingsApi
  windowControls: WindowControlsApi
  ollama: OllamaApi
  git: GitApi
  gpu: GpuApi
  telemetry: TelemetryApi
  dashboardTelemetry: DashboardTelemetryApi
  remoteNodes: RemoteNodesApi
  controller: ControllerApi
  plugins: PluginsApi
  update: UpdateApi
  usageLimits: UsageLimitsApi
  localRuntime: LocalRuntimeApi
  autonomousLoop: AutonomousLoopApi
}

declare global {
  interface Window {
    api: PreloadApi
  }
}

export {}
