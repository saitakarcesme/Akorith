import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { LoopCommandEvidence, LoopDetectedCommand, LoopValidationResult } from './types'
import { changedFilesForValidation, parseValidationCommand, type ValidationCommandSpec } from './commands'

const MAX_OUTPUT_CHARS = 120_000

function appendBounded(current: string, next: string): string {
  const combined = current + next
  return combined.length <= MAX_OUTPUT_CHARS ? combined : combined.slice(combined.length - MAX_OUTPUT_CHARS)
}

function terminateTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try { child.kill('SIGTERM') } catch { /* process already exited */ }
  }
}

export interface ValidationExecutionResult {
  durationMs: number
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

export interface ValidationCommandRunner {
  run(spec: ValidationCommandSpec, options: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<ValidationExecutionResult>
}

export class ProcessValidationCommandRunner implements ValidationCommandRunner {
  run(spec: ValidationCommandSpec, options: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<ValidationExecutionResult> {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      if (options.signal?.aborted) {
        resolve({ durationMs: 0, exitCode: null, timedOut: false, stdout: '', stderr: 'Validation cancelled.' })
        return
      }
      const child = spawn(spec.executable, spec.args, {
        cwd: options.cwd,
        env: process.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      let timer: NodeJS.Timeout
      let forceFinishTimer: NodeJS.Timeout | null = null
      const finish = (exitCode: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (forceFinishTimer) clearTimeout(forceFinishTimer)
        options.signal?.removeEventListener('abort', onAbort)
        resolve({ durationMs: Date.now() - startedAt, exitCode, timedOut, stdout, stderr })
      }
      const onAbort = (): void => {
        stderr = appendBounded(stderr, '\nValidation cancelled.')
        terminateTree(child)
      }
      child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk.toString('utf8')) })
      child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk.toString('utf8')) })
      child.once('error', (error) => {
        stderr = appendBounded(stderr, `\n${error.message}`)
        finish(null)
      })
      child.once('close', (code) => finish(code))
      options.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        timedOut = true
        stderr = appendBounded(stderr, '\nValidation timed out.')
        terminateTree(child)
        forceFinishTimer = setTimeout(() => finish(null), 2_000)
      }, options.timeoutMs)
    })
  }
}

function validationKind(command: string, detected: readonly LoopDetectedCommand[]): LoopCommandEvidence['kind'] {
  return detected.find((item) => item.command === command)?.kind ?? 'targeted'
}

export async function runLoopValidation(input: {
  root: string
  detectedCommands: readonly LoopDetectedCommand[]
  plannedCommands: readonly string[]
  timeoutMs: number
  signal?: AbortSignal
  runner?: ValidationCommandRunner
  changedFiles?: () => Promise<string[]>
}): Promise<LoopValidationResult> {
  const runner = input.runner ?? new ProcessValidationCommandRunner()
  const commands = [...new Set([
    ...input.detectedCommands.map((command) => command.command),
    ...input.plannedCommands,
    'git diff --check'
  ])].slice(0, 24)
  const evidence: LoopCommandEvidence[] = []
  for (const command of commands) {
    const startedAt = Date.now()
    const parsed = parseValidationCommand(command)
    if (!parsed.ok) {
      evidence.push({
        kind: validationKind(command, input.detectedCommands),
        command,
        startedAt,
        durationMs: 0,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: parsed.error
      })
      continue
    }
    const result = await runner.run(parsed.spec, { cwd: input.root, timeoutMs: input.timeoutMs, signal: input.signal })
    evidence.push({
      kind: validationKind(command, input.detectedCommands),
      command,
      startedAt,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr
    })
    if (input.signal?.aborted) break
  }

  const changedFiles = await (input.changedFiles ?? (() => changedFilesForValidation(input.root)))()
  const failures = evidence.filter((item) => item.exitCode !== 0 || item.timedOut)
  const failureSummary = failures.length === 0
    ? null
    : failures.map((item) => `${item.command}: ${item.timedOut ? 'timed out' : `exit ${item.exitCode ?? 'unavailable'}`}`).join('; ').slice(0, 4_000)
  return {
    passed: failures.length === 0 && !input.signal?.aborted,
    commands: evidence,
    changedFiles,
    regressionDetected: failures.length > 0 && changedFiles.length > 0,
    failureSummary
  }
}
