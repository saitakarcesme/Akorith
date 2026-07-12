// Shared local-first runtime contract used by Loop and internal
// Agents. It wraps the existing local/Ollama provider + runtime resolution
// (ollama-connection.ts) without changing the chat provider code.

/** Where the active local model endpoint resolved to (mirrors ollama-connection). */
export type LocalRuntimeSource = 'configured' | 'last' | 'profile' | 'tailscale' | 'controller' | 'mock'

/** A plain text completion from the local runtime. */
export interface LocalRuntimeResult {
  ok: boolean
  text: string
  model: string
  /** Approximate or real token usage when the provider reports it. */
  usage?: {
    promptTokens?: number
    completionTokens?: number
    estimated: boolean
  }
  error?: string
}

/** A structured (JSON) completion, parsed + validated by the caller's schema check. */
export interface LocalStructuredResult<T> {
  ok: boolean
  /** Parsed value when ok. */
  value?: T
  /** The raw model text (for debugging / showing the user what came back). */
  raw: string
  model: string
  /** True when a repair retry was needed to get valid JSON. */
  repaired: boolean
  error?: string
}

export interface LocalRuntimeSendOptions {
  /** Optional model override; defaults to the provider's configured model. */
  model?: string
  /** Optional system preamble prepended to the prompt. */
  system?: string
  signal?: AbortSignal
}

/** A model entry the user can pick for a feature. */
export interface LocalModelInfo {
  id: string
  /** Human label (usually same as id for Ollama tags). */
  label: string
}
