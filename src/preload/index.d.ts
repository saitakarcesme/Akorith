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
  changes?: {
    files: Array<{
      status: string
      path: string
      staged: boolean
      additions: number
      deletions: number
    }>
    additions: number
    deletions: number
    truncated: boolean
  }
  raw?: unknown
}

export interface ChatActivity {
  kind: 'status' | 'reasoning' | 'plan' | 'command' | 'file' | 'tool' | 'warning'
  label: string
  detail?: string
  status?: 'running' | 'complete' | 'error'
  timestamp: number
}

export type ChatSendResponse = { ok: true; result: ChatSendResult } | { ok: false; error: string }

export interface ChatImageAttachment {
  name: string
  mimeType: string
  dataBase64: string
}

export type ChatAttachmentKind = 'image' | 'document' | 'code' | 'file'

export interface ChatAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  kind: ChatAttachmentKind
  dataBase64?: string
}

export interface ChatAttachmentInput extends ChatAttachment {
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
  attachments?: ChatAttachmentInput[]
  intent?: 'execute' | 'plan'
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
  /** Subscribe to normalized CLI progress. Raw JSON/protocol events are never exposed. */
  onActivity(requestId: string, listener: (activity: ChatActivity) => void): () => void
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
  pinned: boolean
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
  attachments: ChatAttachment[]
  metadata: {
    startedAt?: number
    endedAt?: number
    usage?: ChatUsage
    changes?: ChatSendResult['changes']
  } | null
  createdAt: number
}

export interface HistoryApi {
  list(): Promise<SessionRow[]>
  messages(sessionId: string): Promise<{ session: SessionRow; messages: MessageRow[] } | null>
  create(providerId: string, title: string, projectId?: string | null): Promise<SessionRow>
  rename(sessionId: string, title: string): Promise<boolean>
  pin(sessionId: string, pinned: boolean): Promise<boolean>
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
  /** Bounded, project-scoped file index used by the Workspace @ mention picker. */
  files(projectId: string, query?: string): Promise<string[]>
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

// ---- usage (dashboard; TODO(phase 6): router reads the same data) ----

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

// ---- test page (Phase 7) ----

export interface TestSettings {
  sourceRepo: string
  installDeps: boolean
  timeoutMs: number
  keepLastN: number
  defaultProviderId: string
}

export type TestFramework = 'pytest' | 'jest' | 'vitest' | 'npm-test' | 'unknown'

export interface TestDetection {
  framework: TestFramework
  testCommand: string
  installCommand: string
  lockfile: string
  suggestedTestPath: string
  note?: string
}

export interface TestGeneratedFile {
  path: string
  content: string
}

export interface TestRunRequest {
  runId: string
  sourceRepo: string
  targetDesc?: string
  providerId?: string
  model?: string
  framework: string
  testCommand: string
  installCommand?: string
  installDeps?: boolean
  files: TestGeneratedFile[]
  tokens?: number
  attempts?: number
  timeoutMs?: number
}

export interface TestRunRow {
  id: string
  ts: number
  sourceRepo: string
  targetDesc: string | null
  providerId: string | null
  model: string | null
  framework: string | null
  passed: number | null
  failed: number | null
  errored: number | null
  durationMs: number | null
  exitCode: number | null
  tokens: number | null
  attempts: number | null
  sandboxPath: string | null
  generatedFiles: TestGeneratedFile[] | null
  rawOutput: string | null
  status: string | null
}

export type TestRunResponse = { ok: true; run: TestRunRow } | { ok: false; error: string }

export interface TestRepoContext {
  tree: string
  samples: { path: string; content: string }[]
  fileCount: number
}

export type TestResolveSourceResponse =
  | { ok: true; path: string; label: string; cloned: boolean }
  | { ok: false; error: string }

export interface TestApi {
  getSettings(): Promise<TestSettings>
  setSourceRepo(dir: string): Promise<TestSettings>
  setSettings(patch: Partial<TestSettings>): Promise<TestSettings>
  /** Accept a local repo path or a GitHub repo URL and return a local path for Test Lab. */
  resolveSource(source: string): Promise<TestResolveSourceResponse>
  /** Auto-detect framework/test/install commands for the source repo. */
  detect(sourceRepo: string): Promise<TestDetection | { error: string }>
  /** Phase 14.1: bounded, read-only repo structure + sample files for the generator. */
  context(sourceRepo: string): Promise<TestRepoContext | { error: string }>
  /** Snapshot → (install) → run in a fresh ephemeral sandbox; persists the run. */
  run(args: TestRunRequest): Promise<TestRunResponse>
  /** Persist a synthetic benchmark run that did not need a sandbox. */
  persistRun(args: Omit<TestRunRow, 'id' | 'ts'> & { id?: string; ts?: number }): Promise<TestRunResponse>
  /** Abort an in-flight run (kills the whole process tree). */
  stop(runId: string): void
  listRuns(limit?: number): Promise<TestRunRow[]>
  /** Subscribe to live sandbox output. Returns an unsubscribe fn. */
  onOutput(listener: (payload: { runId: string; chunk: string }) => void): () => void
}

// ---- benchmark library (public showcase/export layer) ----

export type BenchmarkCategory = 'general' | 'ui' | 'game' | 'repo'
export type BenchmarkMediaType = 'none' | 'image' | 'video' | 'interactive' | 'artifact'

export interface BenchmarkEntry {
  id: string
  signature: string
  createdAt: number
  updatedAt: number
  challengeId: string
  challengeLabel: string
  category: BenchmarkCategory
  metric: string
  model: string
  providerId: string | null
  score: number | null
  rank: number | null
  status: string | null
  durationMs: number | null
  tokens: number | null
  runId: string | null
  source: string | null
  summary: string | null
  prompt: string | null
  artifactPreview: string | null
  artifactPath: string | null
  mediaType: BenchmarkMediaType
  mediaUrl: string | null
}

export type BenchmarkUpsertInput = Omit<BenchmarkEntry, 'id' | 'createdAt' | 'updatedAt' | 'signature' | 'artifactPath'> & {
  id?: string
  signature?: string
}

export interface BenchmarkApi {
  list(limit?: number): Promise<BenchmarkEntry[]>
  get(id: string): Promise<BenchmarkEntry | null>
  upsert(input: BenchmarkUpsertInput): Promise<BenchmarkEntry>
  exportForWeb(): Promise<{ ok: true; path: string; count: number } | { ok: false; error: string }>
}

// ---- evaluate + PDF reports (Phase 8) ----

export interface IsaScoreWeights {
  tests: number
  speed: number
  tokens: number
  quality: number
}

export interface IsaScoreSettings {
  weights: IsaScoreWeights
}

export type EvaluationKind = 'single' | 'comparison'
export type IsaDimensionName = 'tests' | 'speed' | 'tokens' | 'quality'

export interface IsaDimensionScore {
  score: number | null
  weight: number
  effectiveWeight: number
  value: string
  formula: string
  omitted?: boolean
}

export interface IsaRunScore {
  testRunId: string
  model: string
  providerId: string | null
  status: string | null
  objective: {
    passed: number | null
    failed: number | null
    errored: number | null
    passRate: number | null
    durationMs: number | null
    tokens: number | null
  }
  dimensions: Record<IsaDimensionName, IsaDimensionScore>
  totalScore: number
  qualityRationale?: string
  rank?: number
}

export interface IsaScorePayload {
  version: 1
  formulas: {
    tests: string
    speed: string
    tokens: string
    quality: string
    total: string
  }
  qualityRequested: boolean
  qualityIncluded: boolean
  qualityFailure?: string
  judgeUsage?: ChatUsage
  codeAvailability: Record<string, string[]>
  runs: IsaRunScore[]
}

export interface EvaluationRow {
  id: string
  ts: number
  kind: EvaluationKind
  testRunIds: string[]
  judgeModel: string | null
  dimensionScores: IsaScorePayload
  weights: IsaScoreWeights
  totalScore: number
  rationale: string | null
  pdfPath: string | null
}

export interface EvaluateRunRequest {
  testRunIds: string[]
  includeQuality: boolean
  judgeProviderId?: string
  judgeModel?: string
}

export type EvaluateRunResponse = { ok: true; evaluation: EvaluationRow } | { ok: false; error: string }
export type EvaluatePdfResponse =
  | { ok: true; evaluation: EvaluationRow; pdfPath: string }
  | { ok: false; error: string }

export interface EvaluateApi {
  getSettings(): Promise<IsaScoreSettings>
  list(limit?: number): Promise<EvaluationRow[]>
  run(args: EvaluateRunRequest): Promise<EvaluateRunResponse>
  exportPdf(evaluationId: string): Promise<EvaluatePdfResponse>
  revealPdf(evaluationId: string): Promise<{ ok: true } | { ok: false; error: string }>
  openPdf(evaluationId: string): Promise<{ ok: true } | { ok: false; error: string }>
}

// ---- macro-loop orchestration (Phase 9) ----

export type MacroStatus =
  // TODO(phase 28): mirror src/main/loops/types.ts until a renderer-safe shared
  // type package can be imported by both Electron and web builds.
  | 'draft'
  | 'scheduled'
  | 'idle'
  | 'preparing_context'
  | 'proposing'
  | 'awaiting_approval'
  | 'sending'
  | 'awaiting_executor_result'
  | 'summarizing'
  | 'awaiting_permission'
  | 'auto_running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'archived'
  | 'error'

export type MacroMode = 'approval' | 'auto'
export type MacroExecutorType = 'pty' | 'local'

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
  /** Phase 28: read-only Agent OS metadata foundation. */
  list(): Promise<AgentAdapterInfo[]>
  /** Phase 28: read-only agent availability detection. */
  detect(id: AgentId): Promise<AgentDetectionResult>
  /** Phase 28: read-only detection for every known adapter. */
  detectAll(): Promise<AgentDetectionResult[]>
  /** Phase 29/30: in-memory AgentSession list; no runtime processes are started by this API. */
  listSessions(): Promise<AgentSession[]>
  /** Phase 29/30: read one in-memory AgentSession. */
  getSession(id: AgentSessionId): Promise<AgentSession | null>
  /** Phase 29/30: read in-memory session events. */
  listSessionEvents(sessionId: AgentSessionId): Promise<AgentSessionEvent[]>
  /** Phase 30: read observed runtime attachments and synthesized PTY metadata. */
  listRuntimeAttachments(): Promise<AgentRuntimeAttachment[]>
  /** Phase 30: read observed runtime attachments for one in-memory AgentSession. */
  listRuntimeAttachmentsForSession(sessionId: AgentSessionId): Promise<AgentRuntimeAttachment[]>
  /** Phase 30: read an on-demand runtime observation snapshot. */
  getRuntimeSnapshot(): Promise<AgentRuntimeSnapshot>
  /** Phase 30: refresh the on-demand runtime observation snapshot; no execution side effects. */
  refreshRuntimeSnapshot(): Promise<AgentRuntimeSnapshot>
  /** Phase 29: create a placeholder session only; does not call providers, PTYs, or CLIs. */
  createPlaceholderSession(args: AgentSessionCreateInput): Promise<AgentSession>
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

export interface MacroSessionRow {
  id: string
  createdAt: number
  updatedAt: number
  status: MacroStatus
  goal: string
  plannerProvider: string
  plannerModel: string | null
  targetTerminal: string
  maxIterations: number
  goodEnoughThreshold: number
  includeRepoDigest: boolean
  repoDigestSnapshot: string | null
  finalScore: number | null
  stopReason: string | null
  mode: MacroMode
  autoActions: string | null
  pauseReason: string | null
  /** Phase 20 autonomous workspace loop. */
  workspaceDir: string | null
  autoCommit: boolean
  tokenBudget: number
  tokensUsed: number
  /** Phase 21: plain-language loop label. */
  title: string | null
  /** Phase 22: the user's chosen next direction (consumed by the next plan). */
  pendingSteering: string | null
  /** Loop purpose/cadence metadata. */
  loopIntent: string | null
  cadenceMinutes: number
  /** Phase 23.2 Loop Operations Center metadata. */
  loopType: string | null
  targetType: string | null
  targetRef: string | null
  scheduleKind: string | null
  scheduleDetail: string | null
  nextRunAt: number | null
  stopCondition: string | null
  maxRuns: number
  maxCommits: number
  runCount: number
  commitBehavior: string | null
  pushEnabled: boolean
  testCommands: string | null
  reportFormat: string | null
  safetyLevel: string | null
  latestResult: string | null
  archivedAt: number | null
  /** Phase 27 Local Executor Loop. */
  executorType: MacroExecutorType
  executorProvider: string | null
  executorModel: string | null
  lastAttemptStatus: string | null
  lastValidationResult: string | null
  lastCommitMessage: string | null
}

export interface MacroTurnRow {
  id: string
  sessionId: string
  turnIndex: number
  createdAt: number
  status: string
  proposal: string | null
  editedProposal: string | null
  sentPrompt: string | null
  executorResultSummary: string | null
  plannerRationale: string | null
  expectedResult: string | null
  confidenceScore: number | null
  goodEnoughScore: number | null
  riskLevel: string | null
  providerUsed: string | null
  modelUsed: string | null
  error: string | null
  summarizerConfidence: number | null
  permissionDetection: string | null
  terminalSnapshotMeta: string | null
  autoAction: string | null
  resultStatus: string | null
  criticScore: number | null
  criticVerdict: string | null
  criticReview: string | null
  /** Phase 22: JSON array of 3 suggested next directions. */
  nextOptions: string | null
}

export interface MacroState {
  session: MacroSessionRow
  turns: MacroTurnRow[]
}

export interface MacroCreateRequest {
  goal: string
  plannerProvider: string
  plannerModel?: string
  targetTerminal: string
  maxIterations: number
  goodEnoughThreshold: number
  includeRepoDigest: boolean
  mode?: MacroMode
  /** Phase 20: bind the loop to a git workspace and auto-commit each phase. */
  workspaceDir?: string | null
  autoCommit?: boolean
  tokenBudget?: number
}

export interface ProjectIdea {
  name: string
  slug: string
  summary: string
  firstGoal: string
}

export interface WorkspaceCreateRequest {
  seed?: string
  basePath?: string
  plannerProvider: string
  plannerModel?: string
  targetTerminal: string
  maxIterations?: number
  goodEnoughThreshold?: number
  tokenBudget?: number
  mode?: MacroMode
  loopIntent?: 'continuous' | 'monitor' | 'daily-build' | 'custom'
  cadenceMinutes?: number
  loopType?: string
  targetType?: string
  targetRef?: string
  scheduleKind?: string
  scheduleDetail?: string
  autonomyLevel?: string
  stopCondition?: string
  maxRuns?: number
  maxCommits?: number
  commitBehavior?: string
  pushEnabled?: boolean
  testCommands?: string
  reportFormat?: string
  safetyLevel?: string
  executorType?: MacroExecutorType
  executorProvider?: string
  executorModel?: string
}

export type WorkspaceCreateResponse =
  | { ok: true; idea: ProjectIdea; project: ProjectRow; state: MacroState; workspaceDir: string }
  | { ok: false; error: string }

export type LoopSyncState = 'synced' | 'ahead' | 'behind' | 'diverged' | 'dirty' | 'missing' | 'not_git' | 'no_remote' | 'unknown'

export interface LoopWorkspaceStatus {
  ok: boolean
  workspaceDir: string
  repositoryDir: string | null
  branch: string | null
  remoteUrl: string | null
  head: string | null
  headSubject: string | null
  ahead: number
  behind: number
  dirty: boolean
  staged: number
  unstaged: number
  untracked: number
  commitCount: number
  phaseCount: number
  lastPhase: number
  lastCommitAt: number | null
  syncState: LoopSyncState
  error?: string
}

export type MacroResponse = { ok: true; state: MacroState } | { ok: false; error: string; state?: MacroState }
export type MacroDeleteResponse = { ok: true } | { ok: false; error: string }
export type MacroSummarizeResponse =
  | { ok: true; state: MacroState; summaryText?: string }
  | { ok: false; error: string; state?: MacroState }
export type PermissionDetectResponse = { ok: true; detection: PermissionDetection } | { ok: false; error: string }
export type LoopWorkspaceStatusResponse =
  | { ok: true; status: LoopWorkspaceStatus }
  | { ok: false; error: string; status?: LoopWorkspaceStatus }

export interface LoopRunRow {
  id: string
  loopId: string
  runIndex: number
  startedAt: number
  endedAt: number | null
  status: string
  providerId: string | null
  model: string | null
  summary: string | null
  actionsTaken: unknown
  filesChanged: string[] | null
  commandsExecuted: string[] | null
  testBuildResults: string | null
  commitsCreated: string[] | null
  nextSuggestedStep: string | null
  error: string | null
}

export interface LoopEventRow {
  id: string
  loopId: string
  runId: string | null
  ts: number
  type: string
  message: string
  severity: 'info' | 'success' | 'warning' | 'error'
  metadata: unknown
}

export interface MacroApi {
  createSession(args: MacroCreateRequest): Promise<MacroResponse>
  /** Phase 20: scaffold an everyday-dev project and bind an auto-commit loop to it. */
  createWorkspaceProject(args: WorkspaceCreateRequest): Promise<WorkspaceCreateResponse>
  propose(sessionId: string): Promise<MacroResponse>
  approve(args: { sessionId: string; turnId: string; editedProposal?: string }): Promise<MacroResponse>
  recordResult(args: { sessionId: string; turnId: string; summary: string }): Promise<MacroResponse>
  skip(args: { sessionId: string; turnId: string }): Promise<MacroResponse>
  stop(sessionId: string): Promise<MacroResponse>
  complete(sessionId: string): Promise<MacroResponse>
  archive(sessionId: string): Promise<MacroResponse>
  remove(sessionId: string): Promise<MacroDeleteResponse>
  /** Phase 11: switch Approval/Auto mode. */
  setMode(sessionId: string, mode: MacroMode): Promise<MacroResponse>
  /** Switch the loop's planner model/provider, optionally with the executor target. */
  setPlanner(args: {
    sessionId: string
    plannerProvider: string
    plannerModel?: string | null
    targetTerminal?: string
    executorType?: MacroExecutorType
    executorProvider?: string | null
    executorModel?: string | null
  }): Promise<MacroResponse>
  /** Phase 22: steer the next step toward a chosen direction (loop keeps running). */
  steer(sessionId: string, choice: string): Promise<MacroResponse>
  /** Phase 11: begin the cautious Auto-Mode loop (returns immediately). */
  startAuto(sessionId: string): Promise<MacroResponse>
  /** Phase 11: summarize a turn's executor result from the terminal snapshot. */
  summarize(args: { sessionId: string; turnId: string }): Promise<MacroSummarizeResponse>
  /** Phase 11: read-only permission-prompt detection for the target terminal. */
  detectPermission(sessionId: string): Promise<PermissionDetectResponse>
  /** Phase 11: send a (user-approved) response to a detected permission prompt. */
  respondPermission(args: { sessionId: string; turnId: string; action: string }): Promise<MacroResponse>
  /** Phase 24: read-only AkorithLoop git status for this loop workspace. */
  inspectWorkspace(sessionId: string): Promise<LoopWorkspaceStatusResponse>
  /** Phase 24: pull/rebase and push this loop workspace to AkorithLoop. */
  syncWorkspace(sessionId: string): Promise<LoopWorkspaceStatusResponse>
  /** Phase 24: persisted per-run ledger rows. */
  listRuns(sessionId: string, limit?: number): Promise<LoopRunRow[]>
  /** Phase 24: persisted loop event ledger rows. */
  listEvents(sessionId: string, limit?: number): Promise<LoopEventRow[]>
  get(sessionId: string): Promise<MacroState | null>
  list(limit?: number): Promise<MacroSessionRow[]>
}

// ---- Mission Engine skeleton (Phase 32: preview-only, in-memory) ----

export type MissionId = string
export type MissionStatus =
  | 'draft'
  | 'ready'
  | 'planning'
  | 'awaiting_user_choice'
  | 'running'
  | 'paused'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unsupported'

export type MissionStepId = string
export type MissionStepKind =
  | 'inspect'
  | 'plan'
  | 'execute'
  | 'test'
  | 'review'
  | 'commit'
  | 'handoff'
  | 'memory'
  | 'user_choice'
  | 'report'

export type MissionStepStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'unsupported'

export type MissionAgentRole =
  | 'planner'
  | 'executor'
  | 'reviewer'
  | 'tester'
  | 'committer'
  | 'memory'
  | 'observer'

export type MissionRiskLevel = 'low' | 'medium' | 'high' | 'destructive'
export type MissionPermissionMode =
  | 'read_only'
  | 'ask_before_write'
  | 'allow_safe_writes'
  | 'allow_commits'
  | 'manual_only'
export type MissionOrigin = 'dashboard' | 'loop' | 'agent_hub' | 'workspace' | 'system'

export interface MissionStep {
  id: MissionStepId
  missionId: MissionId
  index: number
  title: string
  kind: MissionStepKind
  status: MissionStepStatus
  agentRole?: MissionAgentRole
  preferredAgentId?: AgentId
  dependsOn?: MissionStepId[]
  riskLevel: MissionRiskLevel
  permissionMode: MissionPermissionMode
  createdAt: number
  updatedAt: number
  summary?: string
  safePreview?: string
  metadata?: Record<string, unknown>
}

export interface Mission {
  id: MissionId
  title: string
  description?: string
  status: MissionStatus
  projectPath?: string
  createdAt: number
  updatedAt: number
  origin: MissionOrigin
  permissionMode: MissionPermissionMode
  riskLevel: MissionRiskLevel
  steps: MissionStep[]
  metadata?: Record<string, unknown>
  notes?: string[]
}

export interface MissionEvent {
  id: string
  missionId: MissionId
  stepId?: MissionStepId
  type: string
  message: string
  timestamp: number
  metadata?: Record<string, unknown>
}

export interface MissionPolicy {
  id: string
  name: string
  permissionMode: MissionPermissionMode
  allowProviderCalls: boolean
  allowPtyWrites: boolean
  allowFileWrites: boolean
  allowTests: boolean
  allowCommits: boolean
  allowPush: boolean
  requireUserApprovalForRiskAbove?: MissionRiskLevel
}

export interface MissionCreateInput {
  title?: string
  description?: string
  projectPath?: string
  origin?: MissionOrigin
  permissionMode?: MissionPermissionMode
  metadata?: Record<string, unknown>
}

export interface MissionTemplateStep {
  title: string
  kind: MissionStepKind
  agentRole?: MissionAgentRole
  preferredAgentId?: AgentId
  dependsOn?: number[]
  riskLevel?: MissionRiskLevel
  permissionMode?: MissionPermissionMode
  status?: MissionStepStatus
  summary?: string
  safePreview?: string
  metadata?: Record<string, unknown>
}

export interface MissionTemplate {
  id: string
  title: string
  description: string
  riskLevel: MissionRiskLevel
  permissionMode: MissionPermissionMode
  steps: MissionTemplateStep[]
  notes?: string[]
  metadata?: Record<string, unknown>
}

export interface MissionPreviewPlan {
  title: string
  description?: string
  origin: MissionOrigin
  permissionMode: MissionPermissionMode
  riskLevel: MissionRiskLevel
  policy: MissionPolicy
  steps: MissionStep[]
  warnings: string[]
  notes: string[]
}

export interface MissionApi {
  /** Phase 32: list preview-only mission templates. */
  listTemplates(): Promise<MissionTemplate[]>
  /** Phase 32: create an in-memory draft mission only. Does not execute. */
  createDraft(args: MissionCreateInput): Promise<Mission>
  /** Phase 32: create an in-memory draft mission from a preview template only. */
  createFromTemplate(templateId: string, input?: MissionCreateInput): Promise<Mission | null>
  /** Phase 32: list in-memory draft/preview missions. */
  list(): Promise<Mission[]>
  /** Phase 32: read one in-memory mission. */
  get(id: MissionId): Promise<Mission | null>
  /** Phase 32: read mission event metadata. No prompts, commands, or terminal output are exposed. */
  listEvents(missionId: MissionId): Promise<MissionEvent[]>
  /** Phase 32: build a safe preview plan without storing or executing it. */
  createSafePreviewPlan(args: MissionCreateInput): Promise<MissionPreviewPlan>
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

// Phase 47: shared local-first runtime used by Loop / Companions / Agents.
export interface LocalModelInfo {
  id: string
  label: string
}

export interface LocalRuntimeApi {
  listModels(): Promise<LocalModelInfo[]>
  defaultModel(): Promise<string | undefined>
  status(): Promise<RuntimeStatus>
}

// Phase 48: project-focused Loop.
export type ProjectLoopMode = 'project_builder' | 'repo_grower' | 'github_loop' | 'maintenance'
export type ProjectLoopStatus = 'active' | 'paused' | 'needs_review' | 'error' | 'completed' | 'archived'
export type ProjectLoopAutonomy = 'manual' | 'assisted' | 'auto'
export type ProjectLoopSafety = 'strict' | 'standard' | 'open'

export interface ProjectLoop {
  id: string
  title: string
  mode: ProjectLoopMode
  status: ProjectLoopStatus
  localPath: string
  repoUrl?: string
  githubOwner?: string
  githubName?: string
  idea?: string
  autonomy: ProjectLoopAutonomy
  safety: ProjectLoopSafety
  scheduleKind: 'manual' | 'interval' | 'daily'
  scheduleMinutes: number
  dailyCommitTarget: number
  minCommitsPerRun: number
  maxCommitsPerRun: number
  localModelProvider: string
  localModel?: string
  pushEnabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  nextRunAt?: number
  runCount: number
  commitCount: number
  error?: string
  memorySummary?: string
  roadmapSummary?: string
}

export interface ProjectLoopRun {
  id: string
  loopId: string
  runIndex: number
  status: 'pending' | 'running' | 'success' | 'no_change' | 'failed' | 'rejected'
  startedAt: number
  endedAt?: number
  model?: string
  objective?: string
  summary?: string
  filesChanged: number
  commandsRun: number
  testsRun: number
  commitsCreated: number
  validationResult?: string
  nextStep?: string
  error?: string
}

export interface ProjectLoopEvent {
  id: string
  loopId: string
  runId?: string
  kind: string
  message: string
  detail?: string
  createdAt: number
}

export interface ProjectLoopCommit {
  id: string
  loopId: string
  runId?: string
  sha: string
  message: string
  filesChanged: number
  createdAt: number
  validationSummary?: string
}

export interface ProjectLoopBacklogItem {
  id: string
  loopId: string
  title: string
  detail?: string
  category?: string
  priority: number
  status: 'open' | 'in_progress' | 'done' | 'dropped'
  createdAt: number
  updatedAt: number
}

export interface ProjectLoopMemory {
  id: string
  loopId: string
  kind: string
  content: string
  importance: number
  createdAt: number
  updatedAt: number
}

export interface RunCycleResult {
  ok: boolean
  run: ProjectLoopRun | null
  committed: boolean
  pushed?: boolean
  sha?: string
  summary: string
  error?: string
}

export interface GoalRunResult {
  ok: boolean
  status: 'completed' | 'paused' | 'needs_review' | 'error'
  attempts: number
  lastRun?: RunCycleResult
  error?: string
}

export interface CreateProjectLoopInput {
  title: string
  mode: ProjectLoopMode
  localPath: string
  repoUrl?: string
  githubOwner?: string
  githubName?: string
  idea?: string
  autonomy?: ProjectLoopAutonomy
  safety?: ProjectLoopSafety
  scheduleKind?: 'manual' | 'interval' | 'daily'
  scheduleMinutes?: number
  dailyCommitTarget?: number
  minCommitsPerRun?: number
  maxCommitsPerRun?: number
  localModelProvider?: string
  localModel?: string
  pushEnabled?: boolean
}

// Phase 52: Agents — reusable local action shortcuts.
export type AgentPermissionMode = 'preview' | 'ask_write' | 'safe_writes' | 'safe_commands' | 'manual_each'
export type AgentRiskLevel = 'low' | 'medium' | 'high'

export interface ActionAgent {
  id: string
  name: string
  description: string
  icon: string
  category: string
  templateId: string
  localModelProvider: string
  localModel?: string
  allowedRoot?: string
  permissionMode: AgentPermissionMode
  allowCommands: boolean
  builtin: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  runCount: number
}

export interface AgentTemplateInfo {
  id: string
  name: string
  description: string
  icon: string
  category: string
  defaultPermission: AgentPermissionMode
  allowCommands: boolean
  needsRoot: boolean
  note?: string
}

export interface ActionAgentRun {
  id: string
  agentId: string
  status: 'planning' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'stopped'
  startedAt: number
  endedAt?: number
  input?: string
  summary?: string
  riskLevel?: AgentRiskLevel
  filesChanged: number
  commandsRun: number
  error?: string
}

export interface ActionAgentEvent {
  id: string
  runId: string
  agentId: string
  kind: string
  message: string
  detail?: string
  createdAt: number
}

export interface ActionAgentArtifact {
  id: string
  runId: string
  agentId: string
  kind: string
  title: string
  content: string
  createdAt: number
}

export interface AgentPlanStep {
  kind: 'read' | 'write' | 'command' | 'report' | 'ask'
  title: string
  reason: string
  requiresPermission: boolean
}

export interface AgentPlan {
  type: 'agent_plan'
  summary: string
  riskLevel: AgentRiskLevel
  steps: AgentPlanStep[]
}

export interface AgentPlanResult {
  ok: boolean
  plan?: AgentPlan
  raw?: string
  error?: string
}

export interface AgentRunResult {
  ok: boolean
  run: ActionAgentRun | null
  events: ActionAgentEvent[]
  artifacts: ActionAgentArtifact[]
  previewOnly: boolean
  error?: string
}

export interface CreateActionAgentInput {
  name: string
  description?: string
  templateId?: string
  allowedRoot?: string
  permissionMode?: AgentPermissionMode
  allowCommands?: boolean
  localModel?: string
  icon?: string
  category?: string
}

export interface ActionAgentApi {
  templates(): Promise<AgentTemplateInfo[]>
  permissionModes(): Promise<{ id: AgentPermissionMode; description: string }[]>
  list(): Promise<ActionAgent[]>
  get(id: string): Promise<ActionAgent | null>
  create(input: CreateActionAgentInput): Promise<ActionAgent>
  update(id: string, patch: Partial<ActionAgent>): Promise<ActionAgent | null>
  remove(id: string): Promise<boolean>
  plan(id: string, input?: string): Promise<AgentPlanResult>
  run(id: string, input?: string): Promise<AgentRunResult>
  listRuns(id: string): Promise<ActionAgentRun[]>
  getRun(runId: string): Promise<{ run: ActionAgentRun | null; events: ActionAgentEvent[]; artifacts: ActionAgentArtifact[] }>
  pickFolder(): Promise<string | null>
}

// Phase 50: Companions.
export type CompanionMemoryType =
  | 'preference' | 'project' | 'decision' | 'idea' | 'goal' | 'personal_context'
  | 'writing_style' | 'technical_context' | 'warning' | 'relationship' | 'recurring_topic'

export interface Companion {
  id: string
  name: string
  tagline: string
  tags: string[]
  builtin: boolean
  model?: string
  createdAt: number
  updatedAt: number
}

export interface CompanionSession {
  id: string
  companionId: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface CompanionMessage {
  id: string
  sessionId: string
  companionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export interface CompanionMemory {
  id: string
  companionId: string
  type: CompanionMemoryType
  title: string
  content: string
  importance: number
  confidence: number
  sourceSessionId?: string
  pinned: boolean
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  archivedAt?: number
  tags: string[]
}

export interface CompanionContextInfo {
  recentMessageCount: number
  usedMemories: { id: string; title: string; type: CompanionMemoryType }[]
}

export interface SendCompanionMessageResult {
  ok: boolean
  reply?: CompanionMessage
  contextInfo?: CompanionContextInfo
  error?: string
}

export interface CompanionApi {
  list(): Promise<Companion[]>
  get(id: string): Promise<Companion | null>
  setModel(id: string, model: string | null): Promise<Companion | null>
  memoryCount(id: string): Promise<number>
  listSessions(companionId: string): Promise<CompanionSession[]>
  createSession(companionId: string, title?: string): Promise<CompanionSession>
  getSession(id: string): Promise<CompanionSession | null>
  deleteSession(id: string): Promise<boolean>
  listMessages(sessionId: string): Promise<CompanionMessage[]>
  sendMessage(input: { companionId: string; sessionId: string; prompt: string; model?: string; requestId?: string }): Promise<SendCompanionMessageResult>
  cancelMessage(requestId: string): void
  extractMemories(sessionId: string): Promise<{ ok: boolean; created: CompanionMemory[]; error?: string }>
  contextInfo(companionId: string, sessionId: string, query: string): Promise<CompanionContextInfo>
  listMemories(companionId: string, includeArchived?: boolean): Promise<CompanionMemory[]>
  searchMemories(companionId: string, query: string): Promise<CompanionMemory[]>
  createMemory(input: { companionId: string; type: CompanionMemoryType; title: string; content: string; importance?: number; tags?: string[] }): Promise<CompanionMemory>
  updateMemory(id: string, patch: Partial<CompanionMemory>): Promise<CompanionMemory | null>
  pinMemory(id: string, pinned: boolean): Promise<CompanionMemory | null>
  archiveMemory(id: string): Promise<CompanionMemory | null>
  forgetMemory(id: string): Promise<boolean>
}

export interface ProjectLoopApi {
  list(): Promise<ProjectLoop[]>
  runningIds(): Promise<string[]>
  get(id: string): Promise<ProjectLoop | null>
  create(input: CreateProjectLoopInput): Promise<ProjectLoop>
  update(id: string, patch: Partial<ProjectLoop>): Promise<ProjectLoop | null>
  setStatus(id: string, status: ProjectLoopStatus): Promise<ProjectLoop | null>
  archive(id: string): Promise<ProjectLoop | null>
  remove(id: string): Promise<boolean>
  runOnce(id: string): Promise<RunCycleResult>
  runGoal(id: string): Promise<GoalRunResult>
  pauseGoal(id: string): Promise<boolean>
  editGoal(id: string, goal: string): Promise<ProjectLoop | null>
  listRuns(id: string): Promise<ProjectLoopRun[]>
  listEvents(id: string): Promise<ProjectLoopEvent[]>
  listCommits(id: string): Promise<ProjectLoopCommit[]>
  listBacklog(id: string): Promise<ProjectLoopBacklogItem[]>
  addBacklog(id: string, title: string, detail?: string): Promise<ProjectLoopBacklogItem>
  setBacklogStatus(itemId: string, status: string): Promise<boolean>
  listMemories(id: string): Promise<ProjectLoopMemory[]>
  addMemory(id: string, content: string): Promise<ProjectLoopMemory>
  cloneRepository(url: string): Promise<{ path: string; name: string; isRepo: true; repoUrl: string; githubOwner: string; githubName: string }>
  pickFolder(): Promise<string | null>
  inspectTarget(path: string): Promise<{ path: string; name: string; isRepo: boolean }>
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
  staged: boolean
}

export type GitStatusResult =
  | { ok: true; isRepo: true; branch: string; files: GitChangeFile[]; truncated: boolean; stat: string; clean: boolean }
  | { ok: true; isRepo: false }
  | { ok: false; error: string }

export interface GitApi {
  status(path: string): Promise<GitStatusResult>
  diff(path: string, filePath: string): Promise<{ ok: true; diff: string } | { ok: false; error: string }>
  setStaged(path: string, filePath: string, staged: boolean): Promise<{ ok: boolean; error?: string }>
  revealFile(path: string, filePath: string): Promise<boolean>
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

export interface CpuStatus {
  name: string
  logicalCores: number
  utilizationPercent: number
  source: 'os-times'
}

export interface GpuStatusResult {
  status: 'observed' | 'unavailable'
  reason?: string
  platform: string
  source: 'nvidia-smi' | 'system-profiler' | 'none'
  gpus: GpuDevice[]
  cpu?: CpuStatus
  ollama: GpuOllamaInfo
}

export interface GpuApi {
  getStatus(): Promise<GpuStatusResult>
  getCpuStatus(): Promise<CpuStatus | undefined>
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
  diagnosticCommand?: { command: string; args: string[] }
  capabilityHint?: string
  installHint?: string
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
  getDiagnostics(): Promise<PluginDiagnostic[]>
  check(id: string): Promise<PluginDiagnostic | null>
  checkAll(): Promise<PluginInfo[]>
  enable(id: string): Promise<PluginInfo[]>
  disable(id: string): Promise<PluginInfo[]>
  getSettings(): Promise<PluginSettingsView>
  setChromaEndpoint(endpoint: string): Promise<PluginSettingsView>
}

export interface UpdateStatus {
  mode: 'git' | 'packaged'
  runtimeMode: 'dev' | 'source' | 'packaged-windows' | 'packaged-macos' | 'packaged-other'
  platform: string
  executablePath: string
  appPath: string
  repoPath?: string
  sourceCheckoutPath?: string
  currentBranch?: string
  currentCommit?: string
  currentCommitFull?: string
  remoteMainCommit?: string
  remoteUrl?: string
  behindBy: number
  aheadBy: number
  hasUpdate: boolean
  isDirty: boolean
  dirtyFiles: string[]
  safeToUpdate: boolean
  canUpdateInstalledApp: boolean
  updateTarget: string
  relaunchTarget?: string
  warnings: string[]
  lastCheckedAt?: number
  appVersion: string
  releaseVersion?: string
  releaseTag?: string
  releaseUrl?: string
  releasePublishedAt?: string
  releaseAssetName?: string
  releaseAssetUrl?: string
  releaseAssetSize?: number
  releaseAssetDigest?: string
}

export interface UpdateLogEntry {
  command: string
  ok: boolean
  output: string
  at: number
}

export interface UpdateRunOptions {
  runInstall?: boolean
  runBuild?: boolean
}

export interface UpdateRunResult {
  ok: boolean
  status: UpdateStatus
  logs: UpdateLogEntry[]
  error?: string
  restartRecommended: boolean
}

export interface UpdateApi {
  status(): Promise<UpdateStatus>
  check(): Promise<UpdateStatus>
  run(options: UpdateRunOptions): Promise<UpdateRunResult>
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
  test: TestApi
  benchmark: BenchmarkApi
  evaluate: EvaluateApi
  macro: MacroApi
  agent: AgentApi
  mission: MissionApi
  settings: SettingsApi
  windowControls: WindowControlsApi
  ollama: OllamaApi
  git: GitApi
  gpu: GpuApi
  telemetry: TelemetryApi
  controller: ControllerApi
  plugins: PluginsApi
  update: UpdateApi
  usageLimits: UsageLimitsApi
  localRuntime: LocalRuntimeApi
  projectLoop: ProjectLoopApi
  companion: CompanionApi
  actionAgent: ActionAgentApi
}

declare global {
  interface Window {
    api: PreloadApi
  }
}

export {}
