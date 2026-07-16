// Shared child-process plumbing for CLI-backed providers. Infrastructure
// only — nothing here may know about a specific provider.

import { spawn } from 'child_process'
import { accessSync, constants, existsSync } from 'fs'
import { homedir } from 'os'
import { delimiter, isAbsolute, join, sep } from 'path'

export interface RunCliOptions {
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
  cwd?: string
  /** Per-invocation environment overrides. Never mutates the app process env. */
  env?: NodeJS.ProcessEnv
  /** Called once per complete stdout line, as output arrives. */
  onStdoutLine?: (line: string) => void
}

export interface RunCliResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Resolve GUI-launched provider CLIs deterministically. Electron can inherit
 * Codex/ChatGPT helper directories ahead of the user's shell PATH; spawning a
 * bare `codex` would then select an older bundled binary even though Terminal
 * uses the current ~/.local/bin install. Prefer normal user install locations,
 * then walk PATH, while keeping Windows shim resolution unchanged.
 */
export function resolveCliExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32' || isAbsolute(command) || command.includes(sep)) return command

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
    const childEnv = options.env ? { ...process.env, ...options.env } : process.env
    const executable = resolveCliExecutable(command, childEnv)
    const child = spawn(executable, args, {
      shell: process.platform === 'win32',
      windowsHide: true,
      cwd: options.cwd,
      env: childEnv
    })

    let stdout = ''
    let stderr = ''
    let lineBuffer = ''
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const killTree = (): void => {
      if (child.pid === undefined) return
      if (process.platform === 'win32') {
        // shell:true means child is a cmd.exe wrapper — kill the whole tree.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
    }

    const onAbort = (): void => {
      killTree()
      finish(() => reject(new Error('cancelled')))
    }

    const timer = setTimeout(() => {
      killTree()
      finish(() => reject(new Error(`${command} timed out after ${options.timeoutMs}ms`)))
    }, options.timeoutMs ?? 300_000)

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stdout += text
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
      stderr += chunk.toString('utf8')
    })

    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => {
      if (options.onStdoutLine && lineBuffer.trim()) options.onStdoutLine(lineBuffer)
      finish(() => resolve({ code, stdout, stderr }))
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
