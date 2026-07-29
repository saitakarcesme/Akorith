// ChatGPT provider — shells out to the user's `codex` CLI (their own
// ChatGPT login; no API key). Knows nothing about other providers.

import { unlink, readFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import {
  cleanCliEventId,
  estimateTokens,
  providerRuntimeWatchdog,
  redactCliText,
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

const DEFAULT_MODELS = ['default', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'codex-auto-review']
const HOST_CODEX_ENV = [
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_THREAD_ID'
] as const
export const WORKSPACE_CODEX_DISABLED_FEATURES = [
  'hooks',
  'plugins',
  'plugin_sharing',
  'remote_plugin',
  'apps',
  'enable_mcp_apps',
  'skill_mcp_dependency_install',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'in_app_browser'
] as const
const WORKSPACE_CODEX_REASONING_EFFORT = 'medium'
export const WORKSPACE_CODEX_PROJECT_ROOT_OVERRIDE = 'project_root_markers=[]'
export const WORKSPACE_CODEX_WINDOWS_SANDBOX_OVERRIDE = 'windows.sandbox=elevated'

export function buildCodexExecArgs(
  outFile: string,
  opts: Pick<SendOptions, 'workingDirectory' | 'intent' | 'model' | 'attachments'>
): string[] {
  const hasWorkspace = Boolean(opts.workingDirectory)
  const executesWorkspace = hasWorkspace && opts.intent !== 'plan'
  const args: string[] = []

  // `codex exec` is headless, so an approval request can never be answered.
  // Keep the filesystem sandbox, but return command failures directly to the
  // model so it can choose another safe tool instead of silently declining.
  if (hasWorkspace) args.push('--ask-for-approval', 'never')
  args.push('exec', '--ignore-user-config')

  // Akorith supplies its own Workspace tools and renders Codex's JSON event
  // stream itself. `--ignore-user-config` prevents user MCP servers and hooks
  // from starting while preserving CODEX_HOME authentication. An empty
  // `mcp_servers={}` override would merge recursively and would not clear a
  // trusted project's servers, so writable calls make cwd the only config
  // discovery root. The feature overrides then keep built-in integrations
  // from diverting a local build into Plugins, Apps, Browser, Computer Use, or
  // MCP installation.
  if (executesWorkspace) {
    args.push('-c', WORKSPACE_CODEX_PROJECT_ROOT_OVERRIDE)
    // Codex 0.144.x selects the read-only Windows backend whenever user config
    // is ignored, even if `--sandbox workspace-write` is supplied later. Pick
    // the elevated Windows sandbox implementation explicitly; the independent
    // workspace-write policy below still limits writes to the selected cwd.
    if (process.platform === 'win32') {
      args.push('-c', WORKSPACE_CODEX_WINDOWS_SANDBOX_OVERRIDE)
    }
    for (const feature of WORKSPACE_CODEX_DISABLED_FEATURES) {
      args.push('--disable', feature)
    }
    // A user's interactive Codex profile may deliberately use `xhigh`, but a
    // headless Workspace turn has a bounded lifetime and cannot wait for an
    // approval or manually nudge a long silent reasoning pass. Keep strong
    // coding quality while preventing inherited `xhigh` from consuming the
    // entire request window before the remaining files are written.
    args.push('-c', `model_reasoning_effort="${WORKSPACE_CODEX_REASONING_EFFORT}"`)
  }

  args.push('--ephemeral', '--json', '--skip-git-repo-check', '--output-last-message', outFile)
  if (opts.workingDirectory) {
    args.push(
      '--sandbox',
      opts.intent === 'plan' ? 'read-only' : 'workspace-write',
      '--cd',
      // runCli already validates and applies the project as process cwd.
      // Keep the user-selected absolute path out of Windows shell argv, where
      // valid folder characters such as `&` could be interpreted by cmd.exe.
      '.'
    )
  }
  for (const attachment of opts.attachments ?? []) {
    if (attachment.kind === 'image') args.push('--image', attachment.path)
  }
  if (opts.model && opts.model !== 'default') args.push('-m', opts.model)
  return args
}

export function boundedCommandOutput(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = redactCliText(value
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\0/g, '')
    .trim())
  if (!text) return undefined
  return text.length > 480 ? `…${text.slice(-479)}` : text
}

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

  async discover(): Promise<ProviderDiscovery> {
    if (!this.useCatalog) {
      const available = await this.isAvailable()
      return { available, models: available.ok ? this.models : [] }
    }
    try {
      // `codex debug models` proves both executable availability and returns
      // the catalog, avoiding a preceding `codex --version` process.
      const res = await runCli('codex', ['debug', 'models'], { timeoutMs: 20_000 })
      if (res.code === 0) {
        const catalog = JSON.parse(res.stdout) as { models?: { slug?: unknown; visibility?: unknown }[] }
        const slugs = (catalog.models ?? [])
          .filter((model) => model.visibility !== 'hidden')
          .map((model) => model.slug)
          .filter((slug): slug is string => typeof slug === 'string' && slug.trim().length > 0)
        return {
          available: { ok: true },
          models: [...new Set(['default', ...slugs])]
        }
      }
    } catch {
      // Older CLIs may not expose the catalog; retain the compatibility path.
    }
    const available = await this.isAvailable()
    return { available, models: available.ok ? this.models : [] }
  }

  async send(prompt: string, opts: SendOptions, onToken: (t: string) => void): Promise<SendResult> {
    // `--output-last-message` gives the clean final answer in a file, free of
    // codex's session/progress log noise on stdout.
    const outFile = join(tmpdir(), `loopex-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
    // Akorith owns conversation memory and tool integrations. Isolate each
    // headless Codex call from the user's optional MCP startup so a broken or
    // slow global connector cannot take down ordinary chat/workspace sends.
    const args = buildCodexExecArgs(outFile, opts)
    let reportedUsage: SendResult['usage'] | null = null

    try {
      const res = await runCli('codex', args, {
        stdin: prompt,
        signal: opts.signal,
        timeoutMs: 600_000,
        ...providerRuntimeWatchdog('chatgpt', 'Codex', opts.onActivity),
        cwd: opts.workingDirectory ?? homedir(),
        // Akorith is frequently launched from another coding-agent desktop.
        // Do not let that parent task's permission/thread identity redefine the
        // fresh Codex CLI sandbox. CODEX_HOME is deliberately preserved.
        unsetEnv: [...HOST_CODEX_ENV],
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
          const now = Date.now()
          const nativeId = cleanCliEventId(item?.id ?? event.item_id ?? event.id ?? event.turn_id ?? event.thread_id)
          const activityId = nativeId ? `codex:${nativeId}` : undefined
          const lifecycle = status === 'complete'
            ? { timestamp: now, endedAt: now }
            : { timestamp: now, startedAt: now }
          if (type === 'thread.started') {
            opts.onActivity?.({
              id: activityId ?? 'codex:session',
              kind: 'status',
              label: 'Codex session started',
              status: 'complete',
              timestamp: now,
              endedAt: now
            })
          } else if (type === 'turn.started') {
            opts.onActivity?.({
              id: activityId ?? 'codex:turn',
              kind: 'status',
              label: 'Inspecting the workspace',
              status: 'running',
              timestamp: now,
              startedAt: now
            })
          } else if (itemType === 'command_execution') {
            const command = typeof item?.command === 'string' ? item.command : 'Running a command'
            const output = boundedCommandOutput(item?.aggregated_output ?? item?.output)
            opts.onActivity?.({
              id: activityId,
              kind: 'command',
              label: command,
              detail: output,
              status,
              surface: 'terminal',
              ...lifecycle
            })
          } else if (itemType === 'file_change') {
            const changes = Array.isArray(item?.changes) ? item.changes as Record<string, unknown>[] : []
            const paths = changes.map((change) => String(change.path ?? '')).filter(Boolean)
            opts.onActivity?.({
              id: activityId,
              kind: 'file',
              label: paths.length ? paths.join(', ') : 'Updating project files',
              status,
              surface: 'files',
              ...lifecycle
            })
          } else if (itemType === 'reasoning') {
            const text = typeof item?.text === 'string' ? item.text : 'Reasoning through the task'
            opts.onActivity?.({ id: activityId, kind: 'reasoning', label: text, status, ...lifecycle })
          } else if (itemType === 'plan') {
            const text = typeof item?.text === 'string' ? item.text : 'Updating the plan'
            opts.onActivity?.({
              id: activityId,
              kind: 'plan',
              label: text,
              status,
              surface: 'review',
              ...lifecycle
            })
          } else if (type === 'turn.completed') {
            const usage = event.usage && typeof event.usage === 'object'
              ? event.usage as Record<string, unknown>
              : null
            if (usage) {
              const count = (value: unknown): number =>
                typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
              const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
                ? usage.input_tokens_details as Record<string, unknown>
                : {}
              const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
                ? usage.output_tokens_details as Record<string, unknown>
                : {}
              const input = count(usage.input_tokens ?? usage.prompt_tokens)
              const cached = count(usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? inputDetails.cached_tokens)
              const output = count(usage.output_tokens ?? usage.completion_tokens)
              const reasoning = count(usage.reasoning_tokens ?? usage.reasoning_output_tokens ?? outputDetails.reasoning_tokens)
              const total = count(usage.total_tokens) || input + output
              if (total > 0) {
                reportedUsage = {
                  promptTokens: Math.max(0, input - cached) || undefined,
                  completionTokens: output || undefined,
                  cacheReadTokens: cached || undefined,
                  reasoningTokens: reasoning || undefined,
                  totalTokens: total,
                  estimated: false
                }
              }
            }
            opts.onActivity?.({
              id: activityId ?? 'codex:turn',
              kind: 'status',
              label: 'Preparing the final result',
              status: 'complete',
              timestamp: now,
              endedAt: now
            })
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
        usage: reportedUsage ?? {
          // codex exec exposes no reliable counts or pricing — approximate,
          // flag it, and never fabricate a cost.
          promptTokens: estimateTokens(prompt),
          completionTokens: estimateTokens(text),
          totalTokens: estimateTokens(prompt) + estimateTokens(text),
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
