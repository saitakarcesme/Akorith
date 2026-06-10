// Shared child-process plumbing for CLI-backed providers. Infrastructure
// only — nothing here may know about a specific provider.

import { spawn } from 'child_process'

export interface RunCliOptions {
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
  cwd?: string
  /** Called once per complete stdout line, as output arrives. */
  onStdoutLine?: (line: string) => void
}

export interface RunCliResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Run a CLI on the user's PATH. Uses a shell so Windows .cmd shims (npm
 * installs) resolve; callers must never put untrusted text in `args` —
 * prompts go through `stdin`.
 */
export function runCli(command: string, args: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: true,
      windowsHide: true,
      cwd: options.cwd,
      env: process.env
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
