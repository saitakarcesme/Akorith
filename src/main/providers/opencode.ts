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
      ? `${prompt}\n\nOpenCode is running non-interactively inside a trusted project boundary. Use project-scoped read, search, and edit tools directly. Shell commands are limited to inspection and existing validation scripts; never request an interactive permission prompt, access a parent directory, delete files, commit, or push.`
      : prompt
    args.push(workspacePrompt)

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
        const type = typeof event.type === 'string' ? event.type : ''
        const part = event.part && typeof event.part === 'object' ? event.part as Record<string, unknown> : null
        const partType = typeof part?.type === 'string' ? part.type : ''
        if (type === 'step_start' || partType === 'step-start') {
          opts.onActivity?.({ kind: 'status', label: 'Planning the next project change', status: 'running' })
          return
        }
        if (type === 'step_finish' || partType === 'step-finish') {
          opts.onActivity?.({ kind: 'status', label: 'Project step finished', status: 'complete' })
          return
        }
        if (type === 'tool_use' || partType === 'tool') {
          const tool = String(part?.tool ?? event.tool ?? 'tool')
          const state = part?.state && typeof part.state === 'object' ? part.state as Record<string, unknown> : {}
          const stateInput = state.input && typeof state.input === 'object' ? state.input as Record<string, unknown> : {}
          const input = part?.input && typeof part.input === 'object' ? part.input as Record<string, unknown> : stateInput
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
