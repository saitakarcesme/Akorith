// Claude provider — shells out to the user's `claude` CLI (their own
// subscription/login; no API key). Knows nothing about other providers.

import { homedir } from 'os'
import { runCli } from './util'
import type {
  Provider,
  ProviderAvailability,
  ProviderConfigEntry,
  SendOptions,
  SendResult
} from './types'

const DEFAULT_MODELS = ['default', 'sonnet', 'opus', 'haiku']

export class ClaudeProvider implements Provider {
  readonly id = 'claude'
  readonly label = 'Claude'
  readonly kind: Provider['kind'] = ['chat', 'executor']
  private readonly models: string[]

  constructor(entry: ProviderConfigEntry) {
    this.models = entry.models ?? DEFAULT_MODELS
  }

  async isAvailable(): Promise<ProviderAvailability> {
    try {
      const res = await runCli('claude', ['--version'], { timeoutMs: 15_000 })
      if (res.code === 0) return { ok: true }
      return { ok: false, reason: `claude CLI exited with code ${res.code}` }
    } catch {
      return { ok: false, reason: 'claude CLI not found on PATH' }
    }
  }

  async listModels(): Promise<string[]> {
    return this.models
  }

  async send(prompt: string, opts: SendOptions, onToken: (t: string) => void): Promise<SendResult> {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model)
    }

    let streamedText = ''
    let resultEvent: ClaudeResultEvent | null = null
    let initModel: string | null = null

    // The prompt travels over stdin (never argv): no shell-quoting surface.
    const res = await runCli('claude', args, {
      stdin: prompt,
      signal: opts.signal,
      timeoutMs: 300_000,
      cwd: homedir(),
      onStdoutLine: (line) => {
        let event: ClaudeStreamLine
        try {
          event = JSON.parse(line) as ClaudeStreamLine
        } catch {
          return // non-JSON noise — ignore
        }
        if (event.type === 'system' && typeof event.model === 'string') {
          initModel = event.model
        } else if (event.type === 'stream_event') {
          const delta = event.event?.delta
          if (event.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
            streamedText += delta.text
            onToken(delta.text)
          }
        } else if (event.type === 'result') {
          resultEvent = event
        }
      }
    })

    if (!resultEvent) {
      const detail = res.stderr.trim().slice(-500) || res.stdout.trim().slice(-500) || `exit code ${res.code}`
      throw new Error(`claude CLI failed: ${detail}`)
    }
    const result: ClaudeResultEvent = resultEvent
    if (result.is_error) {
      throw new Error(`claude CLI error: ${String(result.result).slice(0, 500)}`)
    }

    const text = typeof result.result === 'string' && result.result ? result.result : streamedText
    // Older CLIs without partial messages emit no deltas — deliver the text once.
    if (!streamedText && text) onToken(text)

    const usage = result.usage ?? {}
    const promptTokens =
      (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)

    return {
      text,
      usage: {
        promptTokens: promptTokens || undefined,
        completionTokens: usage.output_tokens,
        costUsd: result.total_cost_usd,
        estimated: false
      },
      model: initModel ?? opts.model ?? 'default',
      raw: result
    }
  }
}

interface ClaudeStreamLine {
  type?: string
  model?: string
  event?: {
    type?: string
    delta?: { type?: string; text?: string }
  }
  [key: string]: unknown
}

interface ClaudeResultEvent extends ClaudeStreamLine {
  is_error?: boolean
  result?: unknown
  total_cost_usd?: number
  usage?: {
    input_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    output_tokens?: number
  }
}
