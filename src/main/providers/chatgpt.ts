// ChatGPT provider — shells out to the user's `codex` CLI (their own
// ChatGPT login; no API key). Knows nothing about other providers.

import { unlink, readFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { runCli, estimateTokens } from './util'
import type {
  Provider,
  ProviderAvailability,
  ProviderConfigEntry,
  SendOptions,
  SendResult
} from './types'

const DEFAULT_MODELS = ['default', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'codex-auto-review']

export class ChatGPTProvider implements Provider {
  readonly id = 'chatgpt'
  readonly label = 'ChatGPT'
  readonly kind: Provider['kind'] = ['chat', 'executor']
  private readonly models: string[]
  private readonly useCatalog: boolean

  constructor(entry: ProviderConfigEntry) {
    this.useCatalog = !entry.models
    this.models = entry.models ?? DEFAULT_MODELS
  }

  async isAvailable(): Promise<ProviderAvailability> {
    try {
      const res = await runCli('codex', ['--version'], { timeoutMs: 15_000 })
      if (res.code === 0) return { ok: true }
      return { ok: false, reason: `codex CLI exited with code ${res.code}` }
    } catch {
      return { ok: false, reason: 'codex CLI not found on PATH' }
    }
  }

  async listModels(): Promise<string[]> {
    if (!this.useCatalog) return this.models
    try {
      const res = await runCli('codex', ['debug', 'models'], { timeoutMs: 20_000 })
      if (res.code !== 0) return this.models
      const catalog = JSON.parse(res.stdout) as { models?: { slug?: unknown; visibility?: unknown }[] }
      const slugs = (catalog.models ?? [])
        .filter((m) => m.visibility !== 'hidden')
        .map((m) => m.slug)
        .filter((slug): slug is string => typeof slug === 'string' && slug.trim().length > 0)
      return [...new Set(['default', ...slugs])]
    } catch {
      return this.models
    }
  }

  async send(prompt: string, opts: SendOptions, onToken: (t: string) => void): Promise<SendResult> {
    // `--output-last-message` gives the clean final answer in a file, free of
    // codex's session/progress log noise on stdout.
    const outFile = join(tmpdir(), `loopex-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
    // Akorith owns conversation memory and tool integrations. Isolate each
    // headless Codex call from the user's optional MCP startup so a broken or
    // slow global connector cannot take down ordinary chat/workspace sends.
    const args = ['exec', '--ignore-user-config', '--ephemeral', '--json', '--skip-git-repo-check', '--output-last-message', outFile]
    if (opts.workingDirectory) args.push('--sandbox', opts.intent === 'plan' ? 'read-only' : 'workspace-write')
    for (const attachment of opts.attachments ?? []) {
      if (attachment.kind === 'image') args.push('--image', attachment.path)
    }
    if (opts.model && opts.model !== 'default') {
      args.push('-m', opts.model)
    }

    try {
      const res = await runCli('codex', args, {
        stdin: prompt,
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
          const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : null
          const itemType = typeof item?.type === 'string' ? item.type : ''
          const status = type.endsWith('.completed') ? 'complete' : 'running'
          if (type === 'thread.started') {
            opts.onActivity?.({ kind: 'status', label: 'Codex session started', status: 'complete' })
          } else if (type === 'turn.started') {
            opts.onActivity?.({ kind: 'status', label: 'Inspecting the workspace', status: 'running' })
          } else if (itemType === 'command_execution') {
            const command = typeof item?.command === 'string' ? item.command : 'Running a command'
            opts.onActivity?.({ kind: 'command', label: command, status })
          } else if (itemType === 'file_change') {
            const changes = Array.isArray(item?.changes) ? item.changes as Record<string, unknown>[] : []
            const paths = changes.map((change) => String(change.path ?? '')).filter(Boolean)
            opts.onActivity?.({ kind: 'file', label: paths.length ? paths.join(', ') : 'Updating project files', status })
          } else if (itemType === 'reasoning') {
            const text = typeof item?.text === 'string' ? item.text : 'Reasoning through the task'
            opts.onActivity?.({ kind: 'reasoning', label: text, status })
          } else if (itemType === 'plan') {
            const text = typeof item?.text === 'string' ? item.text : 'Updating the plan'
            opts.onActivity?.({ kind: 'plan', label: text, status })
          } else if (type === 'turn.completed') {
            opts.onActivity?.({ kind: 'status', label: 'Preparing the final result', status: 'complete' })
          }
        }
      })

      let text = ''
      try {
        text = (await readFile(outFile, 'utf8')).trim()
      } catch {
        // file missing — fall through to stdout fallback below
      }
      if (!text) {
        if (res.code !== 0) {
          const detail = res.stderr.trim().slice(-500) || `exit code ${res.code}`
          throw new Error(`codex CLI failed: ${detail}`)
        }
        text = res.stdout.trim()
      }
      if (!text) {
        throw new Error('codex CLI produced no output')
      }

      // codex exec has no reliable token stream — the text arrives whole.
      onToken(text)

      return {
        text,
        usage: {
          // codex exec exposes no reliable counts or pricing — approximate,
          // flag it, and never fabricate a cost.
          promptTokens: estimateTokens(prompt),
          completionTokens: estimateTokens(text),
          estimated: true
        },
        model: opts.model ?? 'default',
        raw: { stdout: res.stdout.slice(-2000), stderr: res.stderr.slice(-2000) }
      }
    } finally {
      unlink(outFile).catch(() => {})
    }
  }
}
