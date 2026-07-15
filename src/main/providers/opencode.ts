// OpenCode provider — shells out to the user's `opencode` CLI. This mirrors
// the Claude/Codex provider shape so Benchmark can run it headlessly.

import { homedir } from 'os'
import { runCli, estimateTokens } from './util'
import { parseOpenCodeJson } from '../../shared/opencode-output'
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
      cwd: opts.workingDirectory ?? homedir(),
      onStdoutLine: (line) => {
        let event: Record<string, unknown>
        try {
          event = JSON.parse(line) as Record<string, unknown>
        } catch {
          return
        }
        const type = typeof event.type === 'string' ? event.type : ''
        const part = event.part && typeof event.part === 'object' ? event.part as Record<string, unknown> : null
        const partType = typeof part?.type === 'string' ? part.type : ''
        if (type === 'step_start' || partType === 'step-start') {
          opts.onActivity?.({ kind: 'status', label: 'OpenCode started a workspace step', status: 'running' })
          return
        }
        if (type === 'step_finish' || partType === 'step-finish') {
          opts.onActivity?.({ kind: 'status', label: 'Workspace step finished', status: 'complete' })
          return
        }
        if (type === 'tool_use' || partType === 'tool') {
          const tool = String(part?.tool ?? event.tool ?? 'tool')
          const input = part?.input && typeof part.input === 'object' ? part.input as Record<string, unknown> : {}
          const state = part?.state && typeof part.state === 'object' ? part.state as Record<string, unknown> : {}
          const file = typeof input.filePath === 'string' ? input.filePath : typeof input.path === 'string' ? input.path : ''
          const command = typeof input.command === 'string' ? input.command : ''
          const rawStatus = String(state.status ?? '')
          const status = rawStatus === 'error' ? 'error' : rawStatus === 'completed' ? 'complete' : 'running'
          opts.onActivity?.({
            kind: command ? 'command' : file ? 'file' : 'tool',
            label: command || file || `Using ${tool}`,
            detail: tool,
            status
          })
        }
      }
    })

    if (res.code !== 0) {
      const detail = stripAnsi(res.stderr || res.stdout).trim().slice(-500) || `exit code ${res.code}`
      throw new Error(`opencode CLI failed: ${detail}`)
    }

    const parsed = parseOpenCodeJson(res.stdout)
    const plainText = parsed.eventCount === 0 ? stripAnsi(res.stdout).trim() : ''
    const text = parsed.text || plainText
    if (!text) {
      const toolError = parsed.toolErrors.at(-1)
      if (toolError) {
        throw new Error(`OpenCode could not complete the workspace action: ${toolError}`)
      }
      throw new Error('OpenCode completed without a text response. Check its workspace permissions and try again.')
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
