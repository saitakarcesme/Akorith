// Shape of the preload bridge as seen from the renderer.
// Extended in lockstep with src/preload/index.ts.

export interface PtyCreateOptions {
  cols: number
  rows: number
  cwd?: string
  commandKind?: PtyCommandKind
}

export type PtyCommandKind = 'shell' | 'codex' | 'claude'

export type PtyCreateResponse =
  | { ok: true; started: PtyCommandKind; fallback?: boolean; message?: string }
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

export interface ChatSendRequest {
  requestId: string
  providerId: string
  model?: string
  prompt: string
  /** When set, the exchange + usage event are persisted to this session. */
  sessionId?: string
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

export interface TestApi {
  getSettings(): Promise<TestSettings>
  setSourceRepo(dir: string): Promise<TestSettings>
  /** Auto-detect framework/test/install commands for the source repo. */
  detect(sourceRepo: string): Promise<TestDetection | { error: string }>
  /** Snapshot → (install) → run in a fresh ephemeral sandbox; persists the run. */
  run(args: TestRunRequest): Promise<TestRunResponse>
  /** Abort an in-flight run (kills the whole process tree). */
  stop(runId: string): void
  listRuns(limit?: number): Promise<TestRunRow[]>
  /** Subscribe to live sandbox output. Returns an unsubscribe fn. */
  onOutput(listener: (payload: { runId: string; chunk: string }) => void): () => void
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
  | 'idle'
  | 'preparing_context'
  | 'proposing'
  | 'awaiting_approval'
  | 'sending'
  | 'awaiting_executor_result'
  | 'summarizing'
  | 'awaiting_permission'
  | 'auto_running'
  | 'completed'
  | 'stopped'
  | 'error'

export type MacroMode = 'approval' | 'auto'

export interface PermissionDetection {
  detected: boolean
  kind: 'numbered_choice' | 'yes_no' | 'press_enter' | 'allow_access' | 'generic_confirm' | 'none'
  suggestedAction: string
  riskLevel: 'low' | 'medium' | 'high'
  rationale: string
  requiresUserReview: boolean
  matchedText?: string
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
}

export type MacroResponse = { ok: true; state: MacroState } | { ok: false; error: string; state?: MacroState }
export type MacroSummarizeResponse =
  | { ok: true; state: MacroState; summaryText?: string }
  | { ok: false; error: string; state?: MacroState }
export type PermissionDetectResponse = { ok: true; detection: PermissionDetection } | { ok: false; error: string }

export interface MacroApi {
  createSession(args: MacroCreateRequest): Promise<MacroResponse>
  propose(sessionId: string): Promise<MacroResponse>
  approve(args: { sessionId: string; turnId: string; editedProposal?: string }): Promise<MacroResponse>
  recordResult(args: { sessionId: string; turnId: string; summary: string }): Promise<MacroResponse>
  skip(args: { sessionId: string; turnId: string }): Promise<MacroResponse>
  stop(sessionId: string): Promise<MacroResponse>
  complete(sessionId: string): Promise<MacroResponse>
  /** Phase 11: switch Approval/Auto mode. */
  setMode(sessionId: string, mode: MacroMode): Promise<MacroResponse>
  /** Phase 11: begin the cautious Auto-Mode loop (returns immediately). */
  startAuto(sessionId: string): Promise<MacroResponse>
  /** Phase 11: summarize a turn's executor result from the terminal snapshot. */
  summarize(args: { sessionId: string; turnId: string }): Promise<MacroSummarizeResponse>
  /** Phase 11: read-only permission-prompt detection for the target terminal. */
  detectPermission(sessionId: string): Promise<PermissionDetectResponse>
  /** Phase 11: send a (user-approved) response to a detected permission prompt. */
  respondPermission(args: { sessionId: string; turnId: string; action: string }): Promise<MacroResponse>
  get(sessionId: string): Promise<MacroState | null>
  list(limit?: number): Promise<MacroSessionRow[]>
}

export interface PreloadApi {
  pty: PtyApi
  chat: ChatApi
  bridge: BridgeApi
  history: HistoryApi
  projects: ProjectsApi
  usage: UsageApi
  router: RouterApi
  digest: DigestApi
  test: TestApi
  evaluate: EvaluateApi
  macro: MacroApi
}

declare global {
  interface Window {
    api: PreloadApi
  }
}

export {}
