import { execFile, type ExecFileException } from 'node:child_process'
import { isAbsolute } from 'node:path'

export interface CommandRequest {
  executable: string
  args: readonly string[]
  cwd: string
  stdin?: string
  timeoutMs?: number
  maxBufferBytes?: number
  signal?: AbortSignal
  env?: Readonly<Record<string, string>>
}

export interface CommandResult {
  ok: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
  spawnError: boolean
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>
}

export interface ExecFileCommandRunnerOptions {
  allowedExecutables?: readonly string[]
  defaultTimeoutMs?: number
  defaultMaxBufferBytes?: number
}

function validateRequest(request: CommandRequest, allowedExecutables: Set<string>): void {
  if (!allowedExecutables.has(request.executable)) throw new Error(`Executable is not allowed: ${request.executable}`)
  if (!isAbsolute(request.cwd)) throw new Error('Command cwd must be absolute.')
  if (request.args.length > 512) throw new Error('Command has too many arguments.')
  for (const arg of request.args) {
    if (typeof arg !== 'string' || arg.length > 8_192 || /[\0\r\n]/.test(arg)) {
      throw new Error('Command argument contains invalid data.')
    }
  }
  if (request.stdin && Buffer.byteLength(request.stdin, 'utf8') > 64 * 1024) {
    throw new Error('Command stdin exceeds the 64 KiB limit.')
  }
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 300_000)) {
    throw new Error('Command timeout is outside the supported range.')
  }
}

/**
 * Shell-free command runner. Arguments are passed directly to execFile and are
 * never concatenated into a command string or evaluated by a shell.
 */
export class ExecFileCommandRunner implements CommandRunner {
  private readonly allowedExecutables: Set<string>
  private readonly defaultTimeoutMs: number
  private readonly defaultMaxBufferBytes: number

  constructor(options: ExecFileCommandRunnerOptions = {}) {
    this.allowedExecutables = new Set(options.allowedExecutables ?? ['git'])
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
    this.defaultMaxBufferBytes = options.defaultMaxBufferBytes ?? 4 * 1024 * 1024
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    validateRequest(request, this.allowedExecutables)
    if (request.signal?.aborted) {
      return {
        ok: false,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: 'Command cancelled.',
        timedOut: false,
        cancelled: true,
        spawnError: false
      }
    }

    return new Promise((resolve) => {
      let cancelled = false
      const onAbort = (): void => {
        cancelled = true
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const child = execFile(
        request.executable,
        [...request.args],
        {
          cwd: request.cwd,
          timeout: request.timeoutMs ?? this.defaultTimeoutMs,
          maxBuffer: request.maxBufferBytes ?? this.defaultMaxBufferBytes,
          windowsHide: true,
          shell: false,
          encoding: 'utf8',
          signal: request.signal,
          env: {
            ...process.env,
            ...request.env,
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'Never'
          }
        },
        (error: ExecFileException | null, stdout, stderr) => {
          request.signal?.removeEventListener('abort', onAbort)
          const code = typeof error?.code === 'number' ? error.code : error ? null : 0
          const spawnError = typeof error?.code === 'string' && ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)
          const timedOut = Boolean(error?.killed && !cancelled && error.signal)
          resolve({
            ok: error === null,
            exitCode: code,
            signal: error?.signal ?? null,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            timedOut,
            cancelled,
            spawnError
          })
        }
      )
      child.stdin?.end(request.stdin ?? '')
    })
  }
}

export function runGit(
  runner: CommandRunner,
  cwd: string,
  args: readonly string[],
  options: Pick<CommandRequest, 'stdin' | 'timeoutMs' | 'signal' | 'env'> = {}
): Promise<CommandResult> {
  return runner.run({ executable: 'git', args, cwd, ...options })
}
