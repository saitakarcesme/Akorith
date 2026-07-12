import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateTokens, runCli, type RunCliResult } from '../providers/util'
import { buildLoopExecutorPrompt } from './executor-prompt'
import {
  EMPTY_LOOP_USAGE,
  type LoopExecutorAdapter,
  type LoopExecutorRequest,
  type LoopExecutorResult
} from './executor-contracts'

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const MAX_RESULT_CHARS = 80_000

type CliFamily = 'codex' | 'claude' | 'opencode'

function familyForProvider(providerId: string): CliFamily | null {
  if (providerId === 'chatgpt' || providerId === 'codex' || providerId === 'openai') return 'codex'
  if (providerId === 'claude' || providerId === 'anthropic') return 'claude'
  if (providerId === 'opencode') return 'opencode'
  return null
}

function bounded(value: string, max = MAX_RESULT_CHARS): string {
  const clean = value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').replace(/\0/g, '')
  return clean.length <= max ? clean : `${clean.slice(-max)}\n[earlier output bounded by Akorith]`
}

function parseChangedFiles(stdout: string): string[] {
  const entries = stdout.split('\0').filter(Boolean)
  const files: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3).replace(/\\/g, '/').trim()
    if (path && !path.startsWith('.git/') && !files.includes(path)) files.push(path)
    if ((status[0] === 'R' || status[0] === 'C') && entries[index + 1]) index += 1
  }
  return files.slice(0, 256)
}

async function changedFiles(workspacePath: string, signal?: AbortSignal): Promise<string[]> {
  const result = await runCli('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: workspacePath,
    signal,
    timeoutMs: 15_000,
    maxOutputChars: 1_000_000
  })
  return result.code === 0 ? parseChangedFiles(result.stdout) : []
}

function resultSummary(result: RunCliResult, fallback: string): string {
  const output = bounded(result.stdout.trim() || result.stderr.trim(), 16_000)
  if (!output) return fallback
  const lines = output.split(/\r?\n/).filter((line) => line.trim())
  return lines.slice(-24).join('\n').slice(0, 16_000)
}

async function executeCodex(request: LoopExecutorRequest, prompt: string, scratch: string): Promise<RunCliResult> {
  const outputFile = join(scratch, 'codex-result.txt')
  const args = [
    'exec', '--sandbox', 'workspace-write', '--ephemeral', '--color', 'never',
    '--output-last-message', outputFile, '--skip-git-repo-check'
  ]
  if (request.selection.model !== 'default') args.push('--model', request.selection.model)
  const result = await runCli('codex', args, {
    cwd: request.workspacePath,
    stdin: prompt,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    maxOutputChars: 2_000_000
  })
  try {
    const finalMessage = await readFile(outputFile, 'utf8')
    if (finalMessage.trim()) result.stdout = finalMessage.trim()
  } catch {
    // A failed Codex run may not produce the optional final-message file.
  }
  return result
}

async function executeClaude(request: LoopExecutorRequest, prompt: string): Promise<RunCliResult> {
  const args = [
    '--print', '--output-format', 'json', '--permission-mode', 'auto', '--no-session-persistence'
  ]
  if (request.selection.model !== 'default') args.push('--model', request.selection.model)
  return runCli('claude', args, {
    cwd: request.workspacePath,
    stdin: prompt,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    maxOutputChars: 2_000_000
  })
}

async function executeOpenCode(
  request: LoopExecutorRequest,
  prompt: string,
  scratch: string
): Promise<RunCliResult> {
  const promptFile = join(scratch, 'task.txt')
  await writeFile(promptFile, prompt, { encoding: 'utf8', mode: 0o600 })
  const args = [
    'run', '--format', 'json', '--auto', '--file', promptFile
  ]
  if (request.selection.model !== 'default') args.push('--model', request.selection.model)
  args.push('Implement the attached Akorith task, then report changed files and checks.')
  return runCli('opencode', args, {
    cwd: request.workspacePath,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    maxOutputChars: 2_000_000
  })
}

export class CliLoopExecutorAdapter implements LoopExecutorAdapter {
  readonly id = 'cli-coding-agent'

  supports(selection: LoopExecutorRequest['selection']): boolean {
    return selection.location !== 'remote' && familyForProvider(selection.providerId) !== null
  }

  async execute(request: LoopExecutorRequest): Promise<LoopExecutorResult> {
    const family = familyForProvider(request.selection.providerId)
    if (!family || !this.supports(request.selection)) {
      return {
        outcome: 'unavailable', summary: 'No supported local CLI executor is registered for this model.',
        changedFiles: [], usage: { ...EMPTY_LOOP_USAGE }, estimatedUsage: false, durationMs: 0,
        rawOutput: '', errorCode: 'executor-unavailable', retryable: false
      }
    }
    if (!SAFE_MODEL.test(request.selection.model)) {
      return {
        outcome: 'failed', summary: 'The selected model identifier contains unsupported characters.',
        changedFiles: [], usage: { ...EMPTY_LOOP_USAGE }, estimatedUsage: false, durationMs: 0,
        rawOutput: '', errorCode: 'invalid-model', retryable: false
      }
    }

    const startedAt = Date.now()
    const prompt = buildLoopExecutorPrompt(request)
    const scratch = await mkdtemp(join(tmpdir(), 'akorith-loop-'))
    request.onEvent?.({ kind: 'status', occurredAt: startedAt, summary: `Starting ${family} executor.` })
    try {
      const cli = family === 'codex'
        ? await executeCodex(request, prompt, scratch)
        : family === 'claude'
          ? await executeClaude(request, prompt)
          : await executeOpenCode(request, prompt, scratch)
      const files = await changedFiles(request.workspacePath, request.signal)
      const rawOutput = bounded(cli.stdout || cli.stderr)
      const durationMs = Date.now() - startedAt
      const usage = {
        input: estimateTokens(prompt),
        output: rawOutput ? estimateTokens(rawOutput) : 0,
        cached: 0,
        costUsd: 0
      }
      if (cli.code !== 0) {
        const summary = resultSummary(cli, `${family} exited with code ${cli.code}.`)
        return {
          outcome: 'failed', summary, changedFiles: files, usage, estimatedUsage: true, durationMs,
          rawOutput, errorCode: 'executor-exit', retryable: true
        }
      }
      if (files.length === 0) {
        return {
          outcome: 'failed', summary: resultSummary(cli, 'The executor completed without changing repository files.'),
          changedFiles: [], usage, estimatedUsage: true, durationMs, rawOutput,
          errorCode: 'no-changes', retryable: true
        }
      }
      const summary = resultSummary(cli, `Changed ${files.length} repository file${files.length === 1 ? '' : 's'}.`)
      request.onEvent?.({
        kind: 'summary', occurredAt: Date.now(), summary: `Executor changed ${files.length} file${files.length === 1 ? '' : 's'}.`,
        details: { durationMs, fileCount: files.length }
      })
      return {
        outcome: 'completed', summary, changedFiles: files, usage, estimatedUsage: true, durationMs,
        rawOutput, errorCode: null, retryable: false
      }
    } catch (error) {
      const cancelled = request.signal?.aborted === true || (error instanceof Error && error.message === 'cancelled')
      return {
        outcome: cancelled ? 'cancelled' : 'unavailable',
        summary: cancelled ? 'Executor cancelled.' : `Executor unavailable: ${error instanceof Error ? error.message : String(error)}`,
        changedFiles: [], usage: { ...EMPTY_LOOP_USAGE }, estimatedUsage: false,
        durationMs: Date.now() - startedAt, rawOutput: '',
        errorCode: cancelled ? 'cancelled' : 'executor-unavailable', retryable: !cancelled
      }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export const __executorCliTest = { familyForProvider, parseChangedFiles }
