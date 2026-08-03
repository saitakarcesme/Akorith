// OpenCode provider — shells out to the user's `opencode` CLI. This mirrors
// the Claude/Codex provider shape so Benchmark can run it headlessly.

import { homedir } from 'os'
import {
  estimateTokens,
  providerRuntimeWatchdog,
  runCli
} from './util'
import { normalizeOpenCodeActivityEvent, parseOpenCodeJson } from '../../shared/opencode-output'
import type {
  Provider,
  ProviderAvailability,
  ProviderConfigEntry,
  ProviderDiscovery,
  SendOptions,
  SendResult
} from './types'

const DEFAULT_MODELS = ['opencode/nemotron-3-ultra-free']

export const OPENCODE_READ_ONLY_SHELL_PERMISSIONS = {
  '*': 'deny'
} as const

export const OPENCODE_WORKSPACE_SHELL_PERMISSIONS = {
  '*': 'deny'
} as const

// `opencode run` is non-interactive. If a user's global config asks for tool
// approval, a project read/edit is otherwise rejected because there is no TUI
// to answer it. This runtime-only override grants the minimum useful project
// tools while keeping shell access narrow and external paths unavailable. It is
// never written to the user's config or the selected repository.
export const OPENCODE_WORKSPACE_PERMISSION_CONFIG = JSON.stringify({
  mcp: {},
  plugin: [],
  instructions: [],
  permission: {
    '*': 'deny',
    read: 'allow',
    edit: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    todowrite: 'allow',
    question: 'deny',
    external_directory: 'deny',
    bash: OPENCODE_WORKSPACE_SHELL_PERMISSIONS
  }
})

const PLAN_PERMISSION_CONFIG = JSON.stringify({
  mcp: {},
  plugin: [],
  instructions: [],
  permission: {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    question: 'deny',
    external_directory: 'deny',
    bash: OPENCODE_READ_ONLY_SHELL_PERMISSIONS
  }
})

export function buildOpenCodeRunArgs(
  opts: Pick<SendOptions, 'workingDirectory' | 'model' | 'attachments'>
): string[] {
  const args = ['run', '--pure', '--format', 'json']
  if (opts.workingDirectory) {
    // spawn.cwd is already the validated project. A relative --dir keeps the
    // tool boundary pinned to that same folder without exposing an absolute
    // path through model-controlled configuration.
    args.push('--dir', '.')
  }
  if (opts.model && opts.model !== 'default') args.push('-m', opts.model)
  for (const attachment of opts.attachments ?? []) args.push('-f', attachment.path)
  return args
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
}

/**
 * OpenCode's public catalog includes OpenCode Go paid models even when the
 * signed-in account has no credits. The zero-cost Zen catalog uses the
 * `opencode/` namespace; paid models remain opt-in through an explicit
 * `providers.opencode.models` configuration override.
 */
export function usableOpenCodeCatalogModels(stdout: string): string[] {
  const models = stripAnsi(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^opencode\/[\w.:/-]+$/.test(line))
  return [...new Set([
    ...DEFAULT_MODELS.filter((model) => models.includes(model)),
    ...models
  ])]
}

const INSPECTION_GUIDANCE =
  'Use only the native read, list, glob, grep, and edit tools. Shell, LSP, external plugins, and MCP tools are unavailable; Akorith performs host-selected syntax checks after the patch.'

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
      const models = usableOpenCodeCatalogModels(res.stdout)
      return models.length > 0 ? models : this.models
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
      // The catalog command also proves the CLI can start. On the successful
      // path this replaces the old `--version` + `models` process waterfall.
      const res = await runCli('opencode', ['models'], { timeoutMs: 20_000 })
      if (res.code === 0) {
        const models = usableOpenCodeCatalogModels(res.stdout)
        return {
          available: { ok: true },
          models: models.length > 0 ? models : this.models
        }
      }
    } catch {
      // Older CLIs retain the --version/default-model compatibility path.
    }
    const available = await this.isAvailable()
    return { available, models: available.ok ? this.models : [] }
  }

  async send(prompt: string, opts: SendOptions, onToken: (t: string) => void): Promise<SendResult> {
    const requestedModel = opts.model && opts.model !== 'default'
      ? opts.model
      : (await this.listModels())[0]
    if (!requestedModel) {
      throw new Error('OpenCode has no usable models. Refresh the model catalog and try again.')
    }
    const args = buildOpenCodeRunArgs({ ...opts, model: requestedModel })
    const workspacePrompt = opts.workingDirectory
      ? opts.intent === 'plan'
        ? `${prompt}\n\nOpenCode is running non-interactively inside a trusted read-only boundary. Inspect only files inside this directory. ${INSPECTION_GUIDANCE} Do not create, edit, rename, or delete files; do not request an interactive permission prompt; do not access a parent directory, commit, or push.`
        : `${prompt}\n\nOpenCode is running non-interactively inside a trusted project boundary. Use project-scoped read, search, and edit tools directly. ${INSPECTION_GUIDANCE} Akorith's host handles an explicitly requested app start or preview after this turn, so do not start a server, run an app-opening command, or give the user a manual launch command. Never request an interactive permission prompt, access a parent directory, delete files, commit, or push.`
      : prompt
    let streamedText = ''
    const streamVisibleText = !opts.workingDirectory

    const res = await runCli('opencode', args, {
      // Keep the complete prompt off argv. OpenCode's run command natively
      // appends piped stdin to its message, preserving newlines without making
      // prompt text part of the process command line.
      stdin: workspacePrompt,
      signal: opts.signal,
      timeoutMs: 600_000,
      ...providerRuntimeWatchdog('opencode', 'OpenCode', opts.onActivity),
      cwd: opts.workingDirectory ?? homedir(),
      excludedExecutableDirectory: opts.workingDirectory ?? null,
      env: opts.workingDirectory
        ? {
            // Electron keeps the app launch directory in PWD even when
            // child_process.spawn receives a different cwd. OpenCode reads
            // both values, so keep the environment and native cwd aligned.
            PWD: opts.workingDirectory,
            OPENCODE_CONFIG_CONTENT: opts.intent === 'plan' ? PLAN_PERMISSION_CONFIG : OPENCODE_WORKSPACE_PERMISSION_CONFIG
          }
        : undefined,
      onStdoutLine: (line) => {
        let event: Record<string, unknown>
        try {
          event = JSON.parse(line) as Record<string, unknown>
        } catch {
          return
        }
        const part = event.part && typeof event.part === 'object'
          ? event.part as Record<string, unknown>
          : null
        if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
          streamedText += part.text
          if (streamVisibleText) onToken(part.text)
        }
        const activity = normalizeOpenCodeActivityEvent(event, opts.workingDirectory)
        if (activity) opts.onActivity?.(activity)
      }
    })

    if (res.code !== 0) {
      const parsedError = parseOpenCodeJson(res.stdout)
      const detail = parsedError.apiErrors.at(-1)
        || stripAnsi(res.stderr || res.stdout).trim().slice(-500)
        || `exit code ${res.code}`
      throw new Error(`opencode CLI failed: ${detail}`)
    }

    const parsed = parseOpenCodeJson(res.stdout)
    const plainText = parsed.eventCount === 0 ? stripAnsi(res.stdout).trim() : ''
    const text = parsed.text || plainText
    if (!text) {
      const apiError = parsed.apiErrors.at(-1)
      if (apiError) throw new Error(`OpenCode request failed: ${apiError}`)
      const toolError = parsed.toolErrors.at(-1)
      if (toolError) {
        throw new Error(`OpenCode could not complete the workspace action: ${toolError}`)
      }
      throw new Error('OpenCode completed without a text response. Check its workspace permissions and try again.')
    }
    if (parsed.toolErrors.length > 0) {
      opts.onActivity?.({
        kind: 'warning',
        label: 'A workspace tool was blocked',
        detail: parsed.toolErrors.at(-1),
        status: 'error'
      })
    }
    if (!streamedText || !streamVisibleText) onToken(text)

    return {
      text,
      usage: parsed.usage
        ? { ...parsed.usage, estimated: false }
        : {
            promptTokens: estimateTokens(prompt),
            completionTokens: estimateTokens(text),
            totalTokens: estimateTokens(prompt) + estimateTokens(text),
            estimated: true
          },
      model: requestedModel,
      raw: {
        stdout: res.stdout.slice(-2000),
        stderr: res.stderr.slice(-2000),
        toolErrors: parsed.toolErrors
      }
    }
  }
}
