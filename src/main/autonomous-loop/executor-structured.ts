import { sendMetaPrompt } from '../providers/registry'
import {
  buildLocalExecutorPrompt,
  executeLocalExecutorAttempt,
  renderLocalValidationEvidence
} from '../local-executor'
import { estimateTokens } from '../providers/util'
import { buildLoopExecutorPrompt } from './executor-prompt'
import {
  EMPTY_LOOP_USAGE,
  type LoopExecutorAdapter,
  type LoopExecutorRequest,
  type LoopExecutorResult
} from './executor-contracts'
import type { LoopExecutorSelection, LoopTokenUsage } from './types'

export interface StructuredExecutorGeneration {
  text: string
  usage: LoopTokenUsage
  estimated: boolean
}

export interface StructuredExecutorClient {
  generate(
    selection: LoopExecutorSelection,
    prompt: string,
    signal?: AbortSignal,
    onToken?: (token: string) => void
  ): Promise<StructuredExecutorGeneration>
}

export class ProviderStructuredExecutorClient implements StructuredExecutorClient {
  async generate(
    selection: LoopExecutorSelection,
    prompt: string,
    signal?: AbortSignal,
    onToken?: (token: string) => void
  ): Promise<StructuredExecutorGeneration> {
    const result = await sendMetaPrompt(selection.providerId, selection.model, prompt, signal)
    onToken?.(result.text)
    return {
      text: result.text,
      usage: {
        input: result.usage.promptTokens ?? estimateTokens(prompt),
        output: result.usage.completionTokens ?? estimateTokens(result.text),
        cached: 0,
        costUsd: result.usage.costUsd ?? 0
      },
      estimated: result.usage.estimated
    }
  }
}

function previousAttempt(request: LoopExecutorRequest): string {
  if (!request.repair) return ''
  return [
    `Attempt ${request.repair.attempt - 1}: ${request.repair.priorSummary}`,
    renderLocalValidationEvidence(request.repair.validation.commands.map((command) => ({
      cmd: command.command,
      reason: command.kind,
      allowed: true,
      passed: command.exitCode === 0 && !command.timedOut,
      exitCode: command.exitCode,
      timedOut: command.timedOut,
      durationMs: command.durationMs,
      stdout: command.stdout,
      stderr: command.stderr,
      error: command.exitCode === 0 ? null : request.repair?.validation.failureSummary ?? 'Validation failed.'
    })))
  ].join('\n\n')
}

export class StructuredPatchLoopExecutorAdapter implements LoopExecutorAdapter {
  readonly id = 'structured-workspace-patch'

  constructor(private readonly client: StructuredExecutorClient = new ProviderStructuredExecutorClient()) {}

  supports(selection: LoopExecutorSelection): boolean {
    return selection.location === 'remote' || selection.providerId === 'local' || selection.providerId.startsWith('remote:')
  }

  async execute(request: LoopExecutorRequest): Promise<LoopExecutorResult> {
    if (!this.supports(request.selection)) {
      return {
        outcome: 'unavailable', summary: 'The structured patch adapter does not support this model.',
        changedFiles: [], usage: { ...EMPTY_LOOP_USAGE }, estimatedUsage: false, durationMs: 0,
        rawOutput: '', errorCode: 'executor-unavailable', retryable: false
      }
    }
    const startedAt = Date.now()
    const prompt = buildLocalExecutorPrompt({
      goal: buildLoopExecutorPrompt(request),
      workspaceContext: request.repositoryContext,
      previousAttempts: previousAttempt(request),
      validationCommands: request.task.validationCommands.join('\n')
    })
    request.onEvent?.({
      kind: 'status', occurredAt: startedAt,
      summary: request.selection.location === 'remote' ? 'Requesting a remote structured patch.' : 'Requesting a local structured patch.'
    })
    try {
      const generation = await this.client.generate(request.selection, prompt, request.signal)
      const applied = await executeLocalExecutorAttempt({
        workspaceDir: request.workspacePath,
        rawOutput: generation.text,
        goal: request.task.proposedTask,
        extraCommands: request.task.validationCommands.map((cmd) => ({ cmd, reason: 'Planner validation' })),
        timeoutMs: Math.min(request.timeoutMs, 180_000),
        signal: request.signal,
        revertOnNoCommit: false
      })
      const durationMs = Date.now() - startedAt
      if (!applied.action || applied.changedFiles.length === 0) {
        return {
          outcome: 'failed',
          summary: applied.errors.join(' ') || applied.score.reasons.join(' ') || 'The model produced no applicable repository patch.',
          changedFiles: [], usage: generation.usage, estimatedUsage: generation.estimated, durationMs,
          rawOutput: generation.text.slice(-80_000), errorCode: 'invalid-structured-patch', retryable: true
        }
      }
      const validationSummary = renderLocalValidationEvidence(applied.commandResults)
      request.onEvent?.({
        kind: 'summary', occurredAt: Date.now(), summary: applied.action.summary,
        details: { fileCount: applied.changedFiles.length, localScore: applied.score.score, durationMs }
      })
      return {
        outcome: 'completed',
        summary: `${applied.action.summary}\n\n${validationSummary}`.slice(0, 16_000),
        changedFiles: applied.changedFiles,
        usage: generation.usage,
        estimatedUsage: generation.estimated,
        durationMs,
        rawOutput: generation.text.slice(-80_000),
        errorCode: null,
        retryable: false
      }
    } catch (error) {
      const cancelled = request.signal?.aborted === true || (error instanceof Error && error.message === 'cancelled')
      return {
        outcome: cancelled ? 'cancelled' : 'failed',
        summary: cancelled ? 'Structured executor cancelled.' : `Structured executor failed: ${error instanceof Error ? error.message : String(error)}`,
        changedFiles: [], usage: { ...EMPTY_LOOP_USAGE }, estimatedUsage: false,
        durationMs: Date.now() - startedAt, rawOutput: '',
        errorCode: cancelled ? 'cancelled' : 'generation-failed', retryable: !cancelled
      }
    }
  }
}

