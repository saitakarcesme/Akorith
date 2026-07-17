// The provider contract — the single shared surface between backends.
// Every backend implements Provider; nothing provider-specific may leak
// across provider files. The registry is the only consumer.

export type ProviderKind = 'chat' | 'executor'

export type ProviderActivityKind = 'status' | 'reasoning' | 'plan' | 'command' | 'file' | 'tool' | 'warning'
export type ProviderActivityStatus = 'running' | 'complete' | 'error'

/** A provider-neutral progress event. Raw CLI protocol envelopes never cross IPC. */
export interface ProviderActivity {
  kind: ProviderActivityKind
  label: string
  detail?: string
  status?: ProviderActivityStatus
}

export interface ProviderAvailability {
  ok: boolean
  reason?: string
}

export interface SendResult {
  text: string
  usage: {
    promptTokens?: number
    completionTokens?: number
    /** Provider-reported prompt-cache reads that are not part of promptTokens. */
    cacheReadTokens?: number
    /** Provider-reported prompt-cache writes that are not part of promptTokens. */
    cacheWriteTokens?: number
    /** Reasoning tokens when the CLI exposes them as a separate counter. */
    reasoningTokens?: number
    /** Canonical provider total; avoids double-counting counters that are subsets. */
    totalTokens?: number
    costUsd?: number
    /** true when numbers are approximations (e.g. char-count heuristics). */
    estimated: boolean
  }
  model: string
  /** Files changed by this completed workspace turn, derived from Git snapshots. */
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
  /** The provider's raw response, kept for debugging. */
  raw?: unknown
  // TODO(phase 5): usage feeds the dashboard.
  // TODO(phase 6): usage feeds the router.
}

export interface SendOptions {
  model?: string
  signal?: AbortSignal
  /** Trusted project directory for workspace-scoped CLI providers. */
  workingDirectory?: string
  /** Normalized, user-facing activity emitted while a CLI works. */
  onActivity?: (activity: ProviderActivity) => void
  images?: {
    name: string
    mimeType: string
    dataBase64: string
  }[]
  /** Files copied into Akorith's managed attachment store for this turn. */
  attachments?: {
    id: string
    name: string
    mimeType: string
    size: number
    kind: 'image' | 'document' | 'code' | 'file'
    path: string
    /** Kept only for image-capable local runtimes. Never persisted in SQLite. */
    dataBase64?: string
  }[]
  /** Read-only planning pass: inspect and propose, but do not edit files. */
  intent?: 'execute' | 'plan'
}

export interface Provider {
  id: string
  label: string
  /** Capability flags. TODO(phase 6): the router selects providers by kind. */
  kind: ProviderKind[]
  isAvailable(): Promise<ProviderAvailability>
  listModels(): Promise<string[]>
  send(prompt: string, opts: SendOptions, onToken: (t: string) => void): Promise<SendResult>
}

/** One entry under `providers` in loopex.config.json. */
export interface ProviderConfigEntry {
  enabled: boolean
  /** Local provider: Ollama base URL. */
  baseUrl?: string
  /** Local provider: start `ollama serve` when the loopback server is down. */
  autoStart?: boolean
  /** Local provider: when auto-starting, bind Ollama for LAN clients. */
  exposeLan?: boolean
  /** Local provider: scan the local private subnet for a reachable Ollama server. */
  lanDiscovery?: boolean
  /** Local provider: optional OLLAMA_HOST override, e.g. "0.0.0.0:11434". */
  ollamaHost?: string
  /** Phase 33.13: Local provider saved remote Ollama endpoints (auto-connect). */
  remoteProfiles?: unknown
  /** Phase 33.14: Local provider last endpoint that answered, tried first next. */
  lastSuccessfulBaseUrl?: string
  /** Override the provider's model list. */
  models?: string[]
  /** Advanced: path to an external module exporting a Provider factory. */
  module?: string
}

/** Wire shape sent to the renderer for the provider list. */
export interface ProviderInfo {
  id: string
  label: string
  kind: ProviderKind[]
  available: ProviderAvailability
  models: string[]
}
