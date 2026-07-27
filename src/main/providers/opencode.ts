// OpenCode provider — shells out to the user's `opencode` CLI. This mirrors
// the Claude/Codex provider shape so Benchmark can run it headlessly.

import { homedir } from 'os'
import { runCli, estimateTokens } from './util'
import { normalizeOpenCodeActivityEvent, parseOpenCodeJson } from '../../shared/opencode-output'
import type {
  Provider,
  ProviderAvailability,
  ProviderConfigEntry,
  SendOptions,
  SendResult
} from './types'

const DEFAULT_MODELS = ['default']

// `opencode run` is non-interactive. If a user's global config asks for tool
// approval, a project read/edit is otherwise rejected because there is no TUI
// to answer it. This runtime-only override grants the minimum useful project
// tools while keeping shell access narrow and external paths unavailable. It is
// never written to the user's config or the selected repository.
const WORKSPACE_PERMISSION_CONFIG = JSON.stringify({
  permission: {
    '*': 'deny',
    read: 'allow',
    edit: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    todowrite: 'allow',
    question: 'deny',
    external_directory: 'deny',
    bash: {
      '*': 'deny',
      pwd: 'allow',
      'ls *': 'allow',
      'git status*': 'allow',
      'git diff*': 'allow',
      'git log*': 'allow',
      'git show*': 'allow',
      'git rev-parse*': 'allow',
      'git ls-files*': 'allow',
      'node --check *': 'allow',
      'npm test*': 'allow',
      'npm run test*': 'allow',
      'npm run lint*': 'allow',
      'npm run build*': 'allow'
    }
  }
})

const PLAN_PERMISSION_CONFIG = JSON.stringify({
  permission: {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    question: 'deny',
    external_directory: 'deny',
    bash: {
      '*': 'deny',
      pwd: 'allow',
      'ls *': 'allow',
      'git status*': 'allow',
      'git diff*': 'allow',
      'git log*': 'allow',
      'git show*': 'allow',
      'git rev-parse*': 'allow',
      'git ls-files*': 'allow'
    }
  }
})

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
    if (opts.workingDirectory) {
      // OpenCode 1.18+ can reuse a background server whose process cwd is the
      // Akorith app directory. Passing --dir is therefore required in addition
      // to spawn.cwd; otherwise the model sees the selected project as an
      // external directory and edits its internal tool-output fallback instead.
      args.push('--dir', opts.workingDirectory)
    }
    if (opts.model && opts.model !== 'default') {
      args.push('-m', opts.model)
    }
    for (const attachment of opts.attachments ?? []) args.push('-f', attachment.path)
    const workspacePrompt = opts.workingDirectory
      ? opts.intent === 'plan'
        ? `${prompt}\n\nOpenCode is running non-interactively inside a trusted read-only boundary. Inspect only files inside this directory. Do not create, edit, rename, or delete files; do not request an interactive permission prompt; do not access a parent directory, commit, or push.`
        : `${prompt}\n\nOpenCode is running non-interactively inside a trusted project boundary. Use project-scoped read, search, and edit tools directly. Shell commands are limited to inspection and existing validation scripts. Akorith's host handles an explicitly requested app start or preview after this turn, so treat that as a concrete action but do not start a long-lived server, run an app-opening shell command, or give the user a manual launch command. Never request an interactive permission prompt, access a parent directory, delete files, commit, or push.`
      : prompt
    args.push(workspacePrompt)
    let streamedText = ''

    const res = await runCli('opencode', args, {
      signal: opts.signal,
      timeoutMs: 600_000,
      cwd: opts.workingDirectory ?? homedir(),
      env: opts.workingDirectory
        ? {
            // Electron keeps the app launch directory in PWD even when
            // child_process.spawn receives a different cwd. OpenCode reads
            // both values, so keep the environment and native cwd aligned.
            PWD: opts.workingDirectory,
            OPENCODE_CONFIG_CONTENT: opts.intent === 'plan' ? PLAN_PERMISSION_CONFIG : WORKSPACE_PERMISSION_CONFIG
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
          onToken(part.text)
        }
        const activity = normalizeOpenCodeActivityEvent(event, opts.workingDirectory)
        if (activity) opts.onActivity?.(activity)
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
    if (parsed.toolErrors.length > 0) {
      opts.onActivity?.({
        kind: 'warning',
        label: 'A workspace tool was blocked',
        detail: parsed.toolErrors.at(-1),
        status: 'error'
      })
    }
    if (!streamedText) onToken(text)

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
      model: opts.model ?? 'default',
      raw: {
        stdout: res.stdout.slice(-2000),
        stderr: res.stderr.slice(-2000),
        toolErrors: parsed.toolErrors
      }
    }
  }
}
