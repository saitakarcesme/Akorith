// Shared child-process plumbing for CLI-backed providers. Infrastructure
// only — nothing here may know about a specific provider.

import { spawn } from 'child_process'
import { accessSync, constants, existsSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, sep } from 'path'
import type { ProviderActivity } from './types'

export interface RunCliOptions {
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Directory whose executable shims must never be selected. By default this
   * remains the child cwd, preserving the project-boundary protection for
   * command and validation calls. Provider chat calls that deliberately use a
   * trusted home-directory cwd can pass null so CLIs installed under the
   * user's home (for example %APPDATA%\npm\claude.cmd) remain discoverable.
   */
  excludedExecutableDirectory?: string | null
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
  /**
   * Host-only variables that must not leak into a nested provider process.
   * This is intentionally explicit rather than a broad prefix filter so auth
   * locations such as CODEX_HOME remain available.
   */
  unsetEnv?: string[]
  /** Called for raw stdout chunks as they arrive. Keep parsing bounded. */
  onStdoutChunk?: (chunk: string) => void
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
): Pick<RunCliOptions, 'inactivityWarningMs' | 'onDiagnostic'> {
  return {
    inactivityWarningMs: PROVIDER_INACTIVITY_WARNING_MS,
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

export interface ResolvedCliLaunch {
  /** Absolute native executable passed to child_process.spawn(). */
  executable: string
  /** Trusted wrapper arguments inserted before the caller's arguments. */
  prefixArgs: string[]
  /** Absolute path that supplied the resolved command. */
  source: string
}

const resolvedLaunchCache = new Map<string, ResolvedCliLaunch>()

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return env[key]
  const actual = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase()
  )
  return actual ? env[actual] : undefined
}

function pathWithin(root: string | undefined, candidate: string): boolean {
  if (!root) return false
  let rootPath: string
  let candidatePath: string
  try {
    rootPath = realpathSync.native(root)
    candidatePath = realpathSync.native(candidate)
  } catch {
    rootPath = resolve(root)
    candidatePath = resolve(candidate)
  }
  if (process.platform === 'win32') {
    rootPath = rootPath.toLowerCase()
    candidatePath = candidatePath.toLowerCase()
  }
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`)
}

function preferredExecutableDirectories(env: NodeJS.ProcessEnv): string[] {
  const home = homedir()
  const directories = [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin')
  ]
  if (process.platform === 'win32') {
    directories.push(
      join(envValue(env, 'APPDATA') ?? join(home, 'AppData', 'Roaming'), 'npm'),
      join(envValue(env, 'ProgramFiles') ?? 'C:\\Program Files', 'nodejs'),
      join(envValue(env, 'SystemRoot') ?? 'C:\\Windows', 'System32')
    )
  } else {
    directories.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin')
  }
  directories.push(
    ...(envValue(env, 'PATH') ?? '').split(delimiter).filter((directory) => isAbsolute(directory))
  )
  return [...new Set(directories.map((directory) => resolve(directory)))]
}

function executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (isAbsolute(command)) return [resolve(command)]
  if (command.includes('/') || command.includes('\\')) {
    throw new Error(`Refusing relative executable path: ${command}`)
  }
  const extensions =
    process.platform === 'win32' && !extname(command)
      ? ['.exe', '.cmd', '']
      : ['']
  return preferredExecutableDirectories(env).flatMap((directory) =>
    extensions.map((extension) => join(directory, `${command}${extension}`))
  )
}

function findExecutableSource(
  command: string,
  env: NodeJS.ProcessEnv,
  excludedDirectory?: string
): string {
  for (const candidate of executableCandidates(command, env)) {
    if (!existsSync(candidate) || pathWithin(excludedDirectory, candidate)) continue
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      const real = realpathSync.native(candidate)
      if (pathWithin(excludedDirectory, real)) continue
      return real
    } catch {
      // Continue when the candidate cannot be executed or raced away.
    }
  }
  throw new Error(`Trusted executable "${command}" was not found outside the workspace.`)
}

function resolveWindowsNpmShim(
  source: string,
  env: NodeJS.ProcessEnv,
  excludedDirectory?: string
): ResolvedCliLaunch {
  const command = basename(source, extname(source)).toLowerCase()
  const npmRoot = dirname(source)
  if (command === 'claude') {
    const executable = join(
      npmRoot,
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe'
    )
    if (
      existsSync(executable) &&
      statSync(executable).isFile() &&
      !pathWithin(excludedDirectory, executable)
    ) {
      return {
        executable: realpathSync.native(executable),
        prefixArgs: [],
        source
      }
    }
  }
  if (command === 'opencode') {
    const executable = join(npmRoot, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    if (
      existsSync(executable) &&
      statSync(executable).isFile() &&
      !pathWithin(excludedDirectory, executable)
    ) {
      return {
        executable: realpathSync.native(executable),
        prefixArgs: [],
        source
      }
    }
  }
  if (command === 'codex') {
    const script = join(npmRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (
      existsSync(script) &&
      statSync(script).isFile() &&
      !pathWithin(excludedDirectory, script)
    ) {
      const executable = findExecutableSource('node', env, excludedDirectory)
      return {
        executable,
        prefixArgs: [realpathSync.native(script)],
        source
      }
    }
  }
  if (command === 'npm' || command === 'npx') {
    const script = join(
      npmRoot,
      'node_modules',
      'npm',
      'bin',
      command === 'npm' ? 'npm-cli.js' : 'npx-cli.js'
    )
    if (
      existsSync(script) &&
      statSync(script).isFile() &&
      !pathWithin(excludedDirectory, script)
    ) {
      const executable = findExecutableSource('node', env, excludedDirectory)
      return {
        executable,
        prefixArgs: [realpathSync.native(script)],
        source
      }
    }
  }
  throw new Error(`Refusing unsupported Windows command shim: ${source}`)
}

/**
 * Resolve every provider/validation executable before spawning it. A project
 * directory is never searched, relative executable paths are rejected, and
 * Windows npm shims are unwrapped into a native executable plus fixed argv so
 * no cmd.exe/shell parsing is needed.
 */
export function resolveCliLaunch(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  excludedDirectory?: string
): ResolvedCliLaunch {
  const cacheKey = [
    command,
    envValue(env, 'PATH') ?? '',
    envValue(env, 'APPDATA') ?? '',
    envValue(env, 'ProgramFiles') ?? '',
    envValue(env, 'SystemRoot') ?? '',
    excludedDirectory ?? ''
  ].join('\0')
  const cached = resolvedLaunchCache.get(cacheKey)
  if (cached) return { ...cached, prefixArgs: [...cached.prefixArgs] }

  const source = findExecutableSource(command, env, excludedDirectory)
  const launch =
    process.platform === 'win32' && extname(source).toLowerCase() === '.cmd'
      ? resolveWindowsNpmShim(source, env, excludedDirectory)
      : { executable: source, prefixArgs: [], source }
  if (!isAbsolute(launch.executable) || pathWithin(excludedDirectory, launch.executable)) {
    throw new Error(`Refusing executable inside the workspace: ${launch.executable}`)
  }
  resolvedLaunchCache.set(cacheKey, launch)
  return { ...launch, prefixArgs: [...launch.prefixArgs] }
}

/** Compatibility helper for callers that only need the final native binary. */
export function resolveCliExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  excludedDirectory?: string
): string {
  return resolveCliLaunch(command, env, excludedDirectory).executable
}

/**
 * Run a CLI through a resolved absolute native executable. shell:false is an
 * invariant on every platform; caller arguments are never re-parsed by a
 * command shell.
 */
export function runCli(command: string, args: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let lastOutputAt = startedAt
    const childEnv = { ...process.env, ...options.env }
    for (const key of options.unsetEnv ?? []) {
      for (const actual of Object.keys(childEnv)) {
        if (actual.toLowerCase() === key.toLowerCase()) delete childEnv[actual]
      }
    }
    const excludedExecutableDirectory =
      options.excludedExecutableDirectory === undefined
        ? options.cwd
        : options.excludedExecutableDirectory ?? undefined
    const launch = resolveCliLaunch(command, childEnv, excludedExecutableDirectory)
    const child = spawn(launch.executable, [...launch.prefixArgs, ...args], {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      cwd: options.cwd,
      env: childEnv
    })

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    let lineBuffer = ''
    let settled = false
    let hasOutput = false
    let inactivityWarned = false
    let nextInactivityNoticeMs = 0
    let watchdogTimer: ReturnType<typeof setInterval> | null = null
    const positiveMs = (value: number | undefined): number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
    const warningMs = positiveMs(options.inactivityWarningMs)
    const inactivityTimeoutMs = positiveMs(options.inactivityTimeoutMs)
    nextInactivityNoticeMs = warningMs

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
        // Providers may spawn descendants; terminate the resolved native
        // process tree through the trusted Windows system binary.
        const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
        const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], {
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
      hasOutput = true
      if (inactivityWarned) {
        emitDiagnostic({ kind: 'activity', inactiveMs })
      }
      inactivityWarned = false
      nextInactivityNoticeMs = warningMs
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
        if (hasOutput && warningMs && inactiveMs >= nextInactivityNoticeMs) {
          inactivityWarned = true
          emitDiagnostic({ kind: 'inactive', inactiveMs, thresholdMs: warningMs })
          nextInactivityNoticeMs = inactiveMs + warningMs
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
      options.onStdoutChunk?.(text)
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

    child.once('exit', () => {
      // On Windows the shell wrapper can take a short moment to emit `close`
      // after the provider process has already exited. Do not mislabel that
      // teardown gap as provider inactivity.
      if (watchdogTimer) {
        clearInterval(watchdogTimer)
        watchdogTimer = null
      }
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
