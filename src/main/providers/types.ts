// The provider contract — the single shared surface between backends.
// Every backend implements Provider; nothing provider-specific may leak
// across provider files. The registry is the only consumer.

export type ProviderKind = 'chat' | 'executor'

export interface ProviderAvailability {
  ok: boolean
  reason?: string
}

export interface SendResult {
  text: string
  usage: {
    promptTokens?: number
    completionTokens?: number
    costUsd?: number
    /** true when numbers are approximations (e.g. char-count heuristics). */
    estimated: boolean
  }
  model: string
  /** The provider's raw response, kept for debugging. */
  raw?: unknown
  // TODO(phase 5): usage feeds the dashboard.
  // TODO(phase 6): usage feeds the router.
}

export interface SendOptions {
  model?: string
  signal?: AbortSignal
  images?: {
    name: string
    mimeType: string
    dataBase64: string
  }[]
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
