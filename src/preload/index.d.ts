// Shape of the preload bridge as seen from the renderer.
// Extended in lockstep with src/preload/index.ts.

export interface PtyCreateOptions {
  cols: number
  rows: number
  cwd?: string
}

export interface PtyApi {
  /** Spawn the platform shell in a PTY bound to this terminal id. */
  create(id: string, options: PtyCreateOptions): Promise<void>
  /** Send keystrokes/text to the shell's stdin. */
  input(id: string, data: string): void
  /** Propagate an xterm fit to the PTY so the shell reflows. */
  resize(id: string, cols: number, rows: number): void
  /** Kill the PTY process. */
  kill(id: string): void
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
  create(providerId: string, title: string): Promise<SessionRow>
  rename(sessionId: string, title: string): Promise<boolean>
  remove(sessionId: string): Promise<boolean>
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

export interface PreloadApi {
  pty: PtyApi
  chat: ChatApi
  bridge: BridgeApi
  history: HistoryApi
  usage: UsageApi
}

declare global {
  interface Window {
    api: PreloadApi
  }
}

export {}
