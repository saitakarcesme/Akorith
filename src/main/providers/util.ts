// Shared child-process plumbing for CLI-backed providers. Infrastructure
// only — nothing here may know about a specific provider.

import { spawn } from 'child_process'
import { accessSync, constants, existsSync } from 'fs'
import { homedir } from 'os'
import { delimiter, isAbsolute, join, sep } from 'path'
import type { ProviderActivity } from './types'

export interface RunCliOptions {
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Emit one diagnostic when a live process has produced no stdout/stderr for
   * this long. This is informational; the process keeps running.
   */
  inactivityWarningMs?: number
  /**
   * Abort a live process after this much continuous stdout/stderr silence.
   * Kept separate from timeoutMs so a chat can distinguish a stalled stream
   * from a request that exhausted its total budget.
   */
  inactivityTimeoutMs?: number
  cwd?: string
  /** Per-invocation environment overrides. Never mutates the app process env. */
  env?: NodeJS.ProcessEnv
  /** Called once per complete stdout line, as output arrives. */
  onStdoutLine?: (line: string) => void
  /**
   * Process-lifecycle telemetry. It intentionally contains no argv, prompt,
   * cwd, environment, stdout, or stderr.
   */
  onDiagnostic?: (diagnostic: RunCliDiagnostic) => void
}

export interface RunCliResult {
  code: number | null
  stdout: string
  stderr: string
}

export type RunCliDiagnosticKind =
  | 'started'
  | 'activity'
  | 'inactive'
  | 'timed_out'
  | 'cancelled'
  | 'exited'

export interface RunCliDiagnostic {
  kind: RunCliDiagnosticKind
  /** Executable name only. Arguments and prompt content are never included. */
  command: string
  elapsedMs: number
  inactiveMs?: number
  thresholdMs?: number
  pid?: number
  code?: number | null
}

export type CliTimeoutKind = 'total' | 'inactivity'

/** Shared interactive-provider watchdog defaults. */
export const PROVIDER_INACTIVITY_WARNING_MS = 20_000
export const PROVIDER_INACTIVITY_TIMEOUT_MS = 120_000

export function cleanCliEventId(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const id = String(value).replace(/[\0\r\n\t\s]+/g, '-').slice(0, 120)
  return id || undefined
}

export function redactCliText(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /\b(api[-_ ]?key|authorization|password|secret|token)(\s*[:=]\s*)([^\s,;]+)/gi,
      '$1$2[redacted]'
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[a-z]-[A-Za-z0-9-]{8,})\b/g, '[redacted]')
}

/**
 * Translate prompt-free process diagnostics into provider-neutral activity.
 * Keeping this here makes every CLI use identical stall/recovery semantics.
 */
export function createProviderRuntimeDiagnostics(
  providerId: string,
  providerLabel: string,
  onActivity?: (activity: ProviderActivity) => void
): (diagnostic: RunCliDiagnostic) => void {
  return (diagnostic) => {
    console.info('[provider-runtime]', {
      provider: providerId,
      event: diagnostic.kind,
      elapsedMs: diagnostic.elapsedMs,
      inactiveMs: diagnostic.inactiveMs,
      thresholdMs: diagnostic.thresholdMs,
      exitCode: diagnostic.code
    })
    if (diagnostic.kind === 'inactive') {
      const now = Date.now()
      const inactiveMs = diagnostic.inactiveMs ?? 0
      onActivity?.({
        id: `runtime:${providerId}:stream`,
        kind: 'status',
        label: `${providerLabel} is still waiting for model output`,
        detail: `No new CLI output has arrived for ${Math.max(1, Math.round(inactiveMs / 1_000))}s. The process is still running and can be stopped at any time.`,
        status: 'running',
        surface: 'terminal',
        timestamp: now,
        startedAt: now - inactiveMs
      })
    } else if (diagnostic.kind === 'activity' && (diagnostic.inactiveMs ?? 0) >= PROVIDER_INACTIVITY_WARNING_MS) {
      const now = Date.now()
      onActivity?.({
        id: `runtime:${providerId}:stream`,
        kind: 'status',
        label: `${providerLabel} output resumed`,
        detail: 'The model stream is active again and Akorith is continuing this request.',
        status: 'complete',
        surface: 'terminal',
        timestamp: now,
        endedAt: now
      })
    }
  }
}

export function providerRuntimeWatchdog(
  providerId: string,
  providerLabel: string,
  onActivity?: (activity: ProviderActivity) => void
): Pick<RunCliOptions, 'inactivityWarningMs' | 'inactivityTimeoutMs' | 'onDiagnostic'> {
  return {
    inactivityWarningMs: PROVIDER_INACTIVITY_WARNING_MS,
    inactivityTimeoutMs: PROVIDER_INACTIVITY_TIMEOUT_MS,
    onDiagnostic: createProviderRuntimeDiagnostics(providerId, providerLabel, onActivity)
  }
}

/** Typed timeout so the registry can persist an honest timed_out lifecycle. */
export class CliTimeoutError extends Error {
  readonly code = 'CLI_TIMEOUT'

  constructor(
    readonly command: string,
    readonly timeoutKind: CliTimeoutKind,
    readonly thresholdMs: number,
    readonly elapsedMs: number,
    readonly inactiveMs?: number
  ) {
    super(
      timeoutKind === 'inactivity'
        ? `${command} stopped producing output for ${thresholdMs}ms`
        : `${command} timed out after ${thresholdMs}ms`
    )
    this.name = 'CliTimeoutError'
  }
}

export function isCliTimeoutError(error: unknown): error is CliTimeoutError {
  return error instanceof CliTimeoutError || Boolean(
    error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'CLI_TIMEOUT' &&
    ((error as { timeoutKind?: unknown }).timeoutKind === 'total' ||
      (error as { timeoutKind?: unknown }).timeoutKind === 'inactivity')
  )
}

const resolvedExecutableCache = new Map<string, string>()

/**
 * Resolve GUI-launched provider CLIs deterministically. Electron can inherit
 * Codex/ChatGPT helper directories ahead of the user's shell PATH; spawning a
 * bare `codex` would then select an older bundled binary even though Terminal
 * uses the current ~/.local/bin install. Prefer normal user install locations,
 * then walk PATH, while keeping Windows shim resolution unchanged.
 */
export function resolveCliExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32' || isAbsolute(command) || command.includes(sep)) return command
  const cacheKey = `${command}\0${env.PATH ?? ''}`
  const cached = resolvedExecutableCache.get(cacheKey)
  if (cached) return cached

  const home = homedir()
  const preferredDirectories = [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  const pathDirectories = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const candidates = [...new Set([...preferredDirectories, ...pathDirectories])]
    .map((directory) => join(directory, command))

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      accessSync(candidate, constants.X_OK)
      resolvedExecutableCache.set(cacheKey, candidate)
      return candidate
    } catch {
      // Continue to the next candidate when a file exists but is not executable.
    }
  }
  return command
}

/**
 * Run a CLI on the user's PATH. Windows uses a shell so .cmd shims (npm
 * installs) resolve; macOS/Linux spawn the executable directly so packaged
 * loops cannot strand shell wrappers around git/provider calls.
 */
export function runCli(command: string, args: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let lastOutputAt = startedAt
    const childEnv = options.env ? { ...process.env, ...options.env } : process.env
    const executable = resolveCliExecutable(command, childEnv)
    const child = spawn(executable, args, {
      shell: process.platform === 'win32',
      windowsHide: true,
      detached: process.platform !== 'win32',
      cwd: options.cwd,
      env: childEnv
    })

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    let lineBuffer = ''
    let settled = false
    let inactivityWarned = false
    let watchdogTimer: ReturnType<typeof setInterval> | null = null
    const positiveMs = (value: number | undefined): number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
    const warningMs = positiveMs(options.inactivityWarningMs)
    const inactivityTimeoutMs = positiveMs(options.inactivityTimeoutMs)

    const elapsed = (): number => Math.max(0, Date.now() - startedAt)
    const emitDiagnostic = (diagnostic: Omit<RunCliDiagnostic, 'command' | 'elapsedMs'> & {
      elapsedMs?: number
    }): void => {
      try {
        const { elapsedMs, ...rest } = diagnostic
        options.onDiagnostic?.({
          command,
          ...rest,
          elapsedMs: elapsedMs ?? elapsed()
        })
      } catch {
        // Diagnostics must never affect the provider process.
      }
    }

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (watchdogTimer) clearInterval(watchdogTimer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const killTree = (): void => {
      if (child.pid === undefined) return
      if (process.platform === 'win32') {
        // shell:true means child is a cmd.exe wrapper — kill the whole tree.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.once('error', () => {})
        killer.unref()
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          try {
            child.kill('SIGKILL')
          } catch {
            // already gone
          }
        }
      }
    }

    const recordOutputActivity = (): void => {
      if (settled) return
      const now = Date.now()
      const inactiveMs = Math.max(0, now - lastOutputAt)
      lastOutputAt = now
      if (inactivityWarned) {
        emitDiagnostic({ kind: 'activity', inactiveMs })
      }
      inactivityWarned = false
    }

    const onAbort = (): void => {
      emitDiagnostic({ kind: 'cancelled' })
      killTree()
      finish(() => reject(new Error('cancelled')))
    }

    const totalTimeoutMs = options.timeoutMs ?? 300_000
    const timer = setTimeout(() => {
      const timeoutError = new CliTimeoutError(command, 'total', totalTimeoutMs, elapsed())
      emitDiagnostic({ kind: 'timed_out', thresholdMs: totalTimeoutMs })
      killTree()
      finish(() => reject(timeoutError))
    }, totalTimeoutMs)
    const checkEveryMs = Math.max(25, Math.min(1_000, warningMs || Infinity, inactivityTimeoutMs || Infinity))
    if (Number.isFinite(checkEveryMs)) {
      watchdogTimer = setInterval(() => {
        const inactiveMs = Math.max(0, Date.now() - lastOutputAt)
        if (!inactivityWarned && warningMs && inactiveMs >= warningMs) {
          inactivityWarned = true
          emitDiagnostic({ kind: 'inactive', inactiveMs, thresholdMs: warningMs })
        }
        if (inactivityTimeoutMs && inactiveMs >= inactivityTimeoutMs) {
          const timeoutError = new CliTimeoutError(
            command,
            'inactivity',
            inactivityTimeoutMs,
            elapsed(),
            inactiveMs
          )
          emitDiagnostic({ kind: 'timed_out', inactiveMs, thresholdMs: inactivityTimeoutMs })
          killTree()
          finish(() => reject(timeoutError))
        }
      }, checkEveryMs)
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    emitDiagnostic({ kind: 'started', pid: child.pid })

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      recordOutputActivity()
      const text = chunk.toString('utf8')
      stdoutChunks.push(text)
      if (options.onStdoutLine) {
        lineBuffer += text
        const lines = lineBuffer.split(/\r?\n/)
        lineBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) options.onStdoutLine(line)
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return
      recordOutputActivity()
      stderrChunks.push(chunk.toString('utf8'))
    })

    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => {
      if (options.onStdoutLine && lineBuffer.trim()) options.onStdoutLine(lineBuffer)
      emitDiagnostic({ kind: 'exited', code })
      finish(() =>
        resolve({
          code,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join('')
        })
      )
    })

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin)
    }
    child.stdin.end()
  })
}

/** Rough ~4-chars-per-token heuristic. Only for usage marked estimated. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4))
}
