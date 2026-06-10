// Local provider — talks to a local Ollama server over HTTP. The user's own
// hardware; no key, no cost. Knows nothing about other providers.

import type {
  Provider,
  ProviderAvailability,
  ProviderConfigEntry,
  SendOptions,
  SendResult
} from './types'

const DEFAULT_BASE_URL = 'http://localhost:11434'

export class LocalProvider implements Provider {
  readonly id = 'local'
  readonly label = 'Local (Ollama)'
  readonly kind: Provider['kind'] = ['chat', 'executor']
  private readonly baseUrl: string

  constructor(entry: ProviderConfigEntry) {
    this.baseUrl = (entry.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  async isAvailable(): Promise<ProviderAvailability> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return { ok: true }
      return { ok: false, reason: `Ollama responded with HTTP ${res.status}` }
    } catch {
      return { ok: false, reason: `Ollama not reachable at ${this.baseUrl}` }
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return []
    const body = (await res.json()) as { models?: { name?: string }[] }
    return (body.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string')
  }

  async send(prompt: string, opts: SendOptions, onToken: (t: string) => void): Promise<SendResult> {
    let model = opts.model
    if (!model || model === 'default') {
      model = (await this.listModels())[0]
      if (!model) throw new Error('No Ollama models installed — run `ollama pull <model>` first')
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: true
      }),
      signal: opts.signal
    })
    if (!res.ok || !res.body) {
      throw new Error(`Ollama /api/chat failed: HTTP ${res.status}`)
    }

    const decoder = new TextDecoder()
    let lineBuffer = ''
    let text = ''
    let finalChunk: OllamaChunk | null = null

    const handleLine = (line: string): void => {
      if (!line.trim()) return
      let chunk: OllamaChunk
      try {
        chunk = JSON.parse(line) as OllamaChunk
      } catch {
        return
      }
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`)
      const token = chunk.message?.content
      if (token) {
        text += token
        onToken(token)
      }
      if (chunk.done) finalChunk = chunk
    }

    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      lineBuffer += decoder.decode(part, { stream: true })
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    }
    if (lineBuffer.trim()) handleLine(lineBuffer)

    // Cast: TS can't see the closure assignment inside handleLine.
    const done = finalChunk as OllamaChunk | null
    return {
      text,
      usage: {
        // Ollama reports real counts; local inference costs nothing.
        promptTokens: done?.prompt_eval_count,
        completionTokens: done?.eval_count,
        costUsd: 0,
        estimated: false
      },
      model: done?.model ?? model,
      raw: done ?? undefined
    }
  }
}

interface OllamaChunk {
  model?: string
  message?: { content?: string }
  done?: boolean
  error?: string
  prompt_eval_count?: number
  eval_count?: number
}
