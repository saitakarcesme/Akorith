// OpenCode provider — shells out to the user's `opencode` CLI. This mirrors
// the Claude/Codex provider shape so Benchmark can run it headlessly.

import { homedir } from 'os'
import { runCli, estimateTokens } from './util'
import type {
  Provider,
  ProviderAvailability,
  ProviderConfigEntry,
  SendOptions,
  SendResult
} from './types'

const DEFAULT_MODELS = ['default']

function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
}

function parseJsonText(stdout: string): string {
  const chunks: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      const message = event.message
      if (typeof message === 'string') chunks.push(message)
      const text = event.text ?? event.content ?? event.result
      if (typeof text === 'string') chunks.push(text)
      const part = event.part as Record<string, unknown> | undefined
      if (part && typeof part.text === 'string') chunks.push(part.text)
    } catch {
      // Some versions emit formatted lines even in json mode; fall back below.
    }
  }
  return chunks.join('').trim()
}

export class OpenCodeProvider implements Provider {
  readonly id = 'opencode'
  readonly label = 'OpenCode'
  readonly kind: Provider['kind'] = ['chat', 'executor']
  private readonly models: string[]
  private readonly useCatalog: boolean

  constructor(entry: ProviderConfigEntry) {
    this.useCatalog = !entry.models
    this.models = entry.models ?? DEFAULT_MODELS
  }

  async isAvailable(): Promise<ProviderAvailability> {
    try {
      const res = await runCli('opencode', ['--version'], { timeoutMs: 15_000 })
      if (res.code === 0) return { ok: true }
      return { ok: false, reason: `opencode CLI exited with code ${res.code}` }
    } catch {
      return { ok: false, reason: 'opencode CLI not found on PATH' }
    }
  }

  async listModels(): Promise<string[]> {
    if (!this.useCatalog) return this.models
    try {
      const res = await runCli('opencode', ['models'], { timeoutMs: 20_000 })
      if (res.code !== 0) return this.models
      const models = stripAnsi(res.stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[\w.-]+\/[\w.:/-]+$/.test(line))
      return [...new Set(['default', ...models])]
    } catch {
      return this.models
    }
  }

  async send(prompt: string, opts: SendOptions, onToken: (t: string) => void): Promise<SendResult> {
    const args = ['run', '--format', 'json']
    if (opts.model && opts.model !== 'default') {
      args.push('-m', opts.model)
    }
    args.push(prompt)

    const res = await runCli('opencode', args, {
      signal: opts.signal,
      timeoutMs: 600_000,
      cwd: homedir()
    })

    if (res.code !== 0) {
      const detail = stripAnsi(res.stderr || res.stdout).trim().slice(-500) || `exit code ${res.code}`
      throw new Error(`opencode CLI failed: ${detail}`)
    }

    const text = parseJsonText(res.stdout) || stripAnsi(res.stdout).trim()
    if (!text) {
      throw new Error('opencode CLI produced no output')
    }
    onToken(text)

    return {
      text,
      usage: {
        promptTokens: estimateTokens(prompt),
        completionTokens: estimateTokens(text),
        estimated: true
      },
      model: opts.model ?? 'default',
      raw: { stdout: res.stdout.slice(-2000), stderr: res.stderr.slice(-2000) }
    }
  }
}
