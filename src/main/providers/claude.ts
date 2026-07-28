// Claude provider — shells out to the user's `claude` CLI (their own
// subscription/login; no API key). Knows nothing about other providers.

import { homedir } from 'os'
import { dirname } from 'path'
import {
  cleanCliEventId,
  providerRuntimeWatchdog,
  runCli
} from './util'
import type {
  Provider,
  ProviderAvailability,
  ProviderConfigEntry,
  ProviderDiscovery,
  SendOptions,
  SendResult
} from './types'

const DEFAULT_MODELS = ['default', 'claude-fable-5', 'claude-sonnet-5', 'claude-opus-5']

export class ClaudeProvider implements Provider {
  readonly id = 'claude'
  readonly label = 'Claude'
  readonly kind: Provider['kind'] = ['chat', 'executor']
  private readonly models: string[]

  constructor(entry: ProviderConfigEntry) {
    this.models = entry.models ?? DEFAULT_MODELS
  }

  async discover(): Promise<ProviderDiscovery> {
    try {
      // Modern Claude CLIs expose login and executable health through one
      // command. Older builds fall back to --version below.
      const auth = await runCli('claude', ['auth', 'status', '--json'], { timeoutMs: 15_000 })
      try {
        const status = JSON.parse(auth.stdout || auth.stderr) as { loggedIn?: boolean }
        if (status.loggedIn === false) {
          return {
            available: { ok: false, reason: 'Claude login expired. Run `claude auth login` in Terminal.' },
            models: []
          }
        }
        if (auth.code === 0 && status.loggedIn === true) {
          return { available: { ok: true }, models: this.models }
        }
      } catch {
        // Older Claude CLIs may not support the JSON auth command.
      }

      const version = await runCli('claude', ['--version'], { timeoutMs: 15_000 })
      return version.code === 0
        ? { available: { ok: true }, models: this.models }
        : {
            available: { ok: false, reason: `claude CLI exited with code ${version.code}` },
            models: []
          }
    } catch {
      return {
        available: { ok: false, reason: 'claude CLI not found on PATH' },
        models: []
      }
    }
  }

  async isAvailable(): Promise<ProviderAvailability> {
    return (await this.discover()).available
  }

  async listModels(): Promise<string[]> {
    return this.models
  }

  async send(prompt: string, opts: SendOptions, onToken: (t: string) => void): Promise<SendResult> {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    if (opts.workingDirectory) args.push('--permission-mode', opts.intent === 'plan' ? 'plan' : 'acceptEdits')
    for (const directory of [...new Set((opts.attachments ?? []).map((item) => dirname(item.path)).filter(Boolean))]) {
      args.push('--add-dir', directory)
    }
    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model)
    }

    let streamedText = ''
    let resultEvent: ClaudeResultEvent | null = null
    let initModel: string | null = null
    let toolSequence = 0
    const activeTools = new Map<number, {
      id: string
      kind: 'command' | 'file' | 'tool'
      label: string
      detail?: string
      surface?: 'terminal' | 'files'
      startedAt: number
    }>()

    // The prompt travels over stdin (never argv): no shell-quoting surface.
    const res = await runCli('claude', args, {
      stdin: prompt,
      signal: opts.signal,
      timeoutMs: 300_000,
      ...providerRuntimeWatchdog('claude', 'Claude', opts.onActivity),
      cwd: opts.workingDirectory ?? homedir(),
      onStdoutLine: (line) => {
        let event: ClaudeStreamLine
        try {
          event = JSON.parse(line) as ClaudeStreamLine
        } catch {
          return // non-JSON noise — ignore
        }
        if (event.type === 'system' && typeof event.model === 'string') {
          initModel = event.model
          const now = Date.now()
          opts.onActivity?.({
            id: 'claude:session',
            kind: 'status',
            label: 'Claude session started',
            status: 'complete',
            timestamp: now,
            endedAt: now
          })
        } else if (event.type === 'stream_event') {
          const delta = event.event?.delta
          if (event.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
            streamedText += delta.text
            onToken(delta.text)
          } else if (event.event?.type === 'content_block_start') {
            const block = event.event.content_block
            if (block?.type === 'tool_use') {
              const name = block.name ?? 'tool'
              const input = block.input ?? {}
              const file = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : ''
              const command = typeof input.command === 'string' ? input.command : ''
              const index = typeof event.event.index === 'number' ? event.event.index : toolSequence++
              const now = Date.now()
              const activity = {
                id: `claude:${cleanCliEventId(block.id) ?? `tool-${index}`}`,
                kind: command ? 'command' as const : file ? 'file' as const : 'tool' as const,
                label: command || file || `Using ${name}`,
                detail: command || file ? name : undefined,
                surface: command ? 'terminal' as const : file ? 'files' as const : undefined,
                startedAt: now
              }
              activeTools.set(index, activity)
              opts.onActivity?.({
                ...activity,
                status: 'running',
                timestamp: now
              })
            }
          } else if (event.event?.type === 'content_block_stop') {
            const index = typeof event.event.index === 'number' ? event.event.index : -1
            const activity = activeTools.get(index)
            if (activity) {
              const now = Date.now()
              opts.onActivity?.({
                ...activity,
                status: 'complete',
                timestamp: now,
                endedAt: now
              })
              activeTools.delete(index)
            }
          }
        } else if (event.type === 'result') {
          resultEvent = event
          const now = Date.now()
          opts.onActivity?.({
            id: 'claude:result',
            kind: 'status',
            label: 'Claude finished the workspace task',
            status: event.is_error ? 'error' : 'complete',
            timestamp: now,
            endedAt: now
          })
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
    // Claude can report very large cache counters for tiny follow-up prompts.
    // Keep Akorith's visible prompt-token badge focused on the direct input
    // count for this turn; the raw CLI event still carries the full provider
    // accounting for audits.
    const promptTokens = usage.input_tokens ?? 0
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
    const completionTokens = usage.output_tokens ?? 0

    return {
      text,
      usage: {
        promptTokens: promptTokens || undefined,
        completionTokens: completionTokens || undefined,
        cacheReadTokens: cacheReadTokens || undefined,
        cacheWriteTokens: cacheWriteTokens || undefined,
        totalTokens: promptTokens + completionTokens + cacheReadTokens + cacheWriteTokens,
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
    index?: number
    delta?: { type?: string; text?: string }
    content_block?: {
      id?: string
      type?: string
      name?: string
      input?: Record<string, unknown>
    }
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
