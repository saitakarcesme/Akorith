import {
  buildLocalExecutorPrompt,
  executeLocalExecutorAttempt,
  renderLocalValidationEvidence,
  type LocalExecutorAttemptResult
} from '../local-executor'
import { inspectProject, renderProjectContext } from '../project-loop/context'
import type {
  Provider,
  ProviderActivity,
  ProviderGenerationOptions,
  ProviderUsageSource,
  SendResult
} from './types'

const LOCAL_WORKSPACE_ATTEMPTS = 2
const LOCAL_WORKSPACE_DEFAULT_MAX_TOKENS = 8_192
const LOCAL_WORKSPACE_ATTEMPT_TIMEOUT_MS = 8 * 60 * 1_000

type Usage = SendResult['usage']

export function localGenerationStopReason(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const reason = (raw as { done_reason?: unknown }).done_reason
  return typeof reason === 'string' && reason.trim() ? reason.trim() : null
}

function boundedAttemptSignal(parent: AbortSignal): {
  signal: AbortSignal
  timedOut: () => boolean
  cleanup: () => void
} {
  const controller = new AbortController()
  let timeoutReached = false
  const onParentAbort = (): void => controller.abort(parent.reason)
  if (parent.aborted) onParentAbort()
  else parent.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(() => {
    timeoutReached = true
    controller.abort(
      new Error(
        `Local workspace attempt exceeded ${LOCAL_WORKSPACE_ATTEMPT_TIMEOUT_MS}ms`
      )
    )
  }, LOCAL_WORKSPACE_ATTEMPT_TIMEOUT_MS)
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timer)
      parent.removeEventListener('abort', onParentAbort)
    }
  }
}

function sumDefined(usages: Usage[], key: keyof Omit<Usage, 'estimated'>): number | undefined {
  let total = 0
  let found = false
  for (const usage of usages) {
    const value = usage[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    total += value
    found = true
  }
  return found ? total : undefined
}

export function mergeLocalWorkspaceUsage(usages: Usage[]): Usage {
  return {
    promptTokens: sumDefined(usages, 'promptTokens'),
    completionTokens: sumDefined(usages, 'completionTokens'),
    cacheReadTokens: sumDefined(usages, 'cacheReadTokens'),
    cacheWriteTokens: sumDefined(usages, 'cacheWriteTokens'),
    reasoningTokens: sumDefined(usages, 'reasoningTokens'),
    totalTokens: usages.length
      ? usages.reduce(
          (sum, usage) =>
            sum +
            (usage.totalTokens ??
              (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)),
          0
        )
      : undefined,
    costUsd: sumDefined(usages, 'costUsd'),
    estimated: usages.some((usage) => usage.estimated)
  }
}

function validationSummary(attempt: LocalExecutorAttemptResult): string {
  if (attempt.commandResults.length === 0) {
    return 'no applicable command; Akorith used structured artifact checks'
  }
  const passed = attempt.commandResults.filter(
    (command) => command.allowed && command.passed
  ).length
  return `${passed}/${attempt.commandResults.length} checks passed`
}

function attemptFeedback(
  attempt: LocalExecutorAttemptResult,
  attemptNumber: number
): string {
  const reasons =
    attempt.score.reasons.length > 0
      ? attempt.score.reasons.join('; ')
      : attempt.errors.join('; ') || 'the patch did not meet the acceptance gate'
  return `Attempt ${attemptNumber} was rejected${attempt.rolledBack ? ' and fully reverted' : ''}.
Acceptance reasons: ${reasons}.
Validation evidence: ${renderLocalValidationEvidence(attempt.commandResults)}
Return a complete corrected patch, not another scaffold or explanation.`
}

export async function sendWorkspaceLocal(
  provider: Provider,
  goal: string,
  model: string | undefined,
  workspaceDir: string,
  signal: AbortSignal,
  emit: (activity: ProviderActivity) => void,
  onToken: (token: string) => void,
  generation?: ProviderGenerationOptions,
  usageSource?: ProviderUsageSource
): Promise<SendResult> {
  const usages: Usage[] = []
  let previousAttempts = ''
  let lastModel = model ?? 'local'
  const workspaceGeneration: ProviderGenerationOptions = {
    ...generation,
    maxTokens: generation?.maxTokens ?? LOCAL_WORKSPACE_DEFAULT_MAX_TOKENS
  }

  for (let attemptNumber = 1; attemptNumber <= LOCAL_WORKSPACE_ATTEMPTS; attemptNumber += 1) {
    emit({
      kind: 'status',
      label: attemptNumber === 1
        ? 'Inspecting the project'
        : 'Inspecting the restored project before the final attempt',
      status: 'running'
    })
    const context = inspectProject(workspaceDir)
    emit({
      kind: 'status',
      label: `Project context ready (${context.fileTree.length} entries)`,
      status: 'complete'
    })
    const draftId = `local-workspace:draft:${attemptNumber}`
    const draftStartedAt = Date.now()
    let draftChars = 0
    let lastDraftUpdateAt = 0
    emit({
      id: draftId,
      kind: 'reasoning',
      label: attemptNumber === 1
        ? 'Drafting the complete workspace change'
        : 'Drafting the corrected workspace change',
      detail: 'The local model is generating a candidate patch. Akorith will validate it before any result is accepted.',
      status: 'running',
      timestamp: draftStartedAt,
      startedAt: draftStartedAt
    })
    const prompt = buildLocalExecutorPrompt({
      goal,
      workspaceContext: renderProjectContext(context),
      previousAttempts,
      validationCommands: '',
      completionMode: 'complete_request'
    })
    const attemptSignal = boundedAttemptSignal(signal)
    let generated: SendResult
    try {
      generated = await provider.send(
        prompt,
        {
          model,
          signal: attemptSignal.signal,
          generation: workspaceGeneration,
          usageSource,
          workingDirectory: workspaceDir,
          intent: 'execute'
        },
        (token) => {
          draftChars += token.length
          const now = Date.now()
          if (now - lastDraftUpdateAt < 2_000) return
          lastDraftUpdateAt = now
          emit({
            id: draftId,
            kind: 'reasoning',
            label: attemptNumber === 1
              ? 'Drafting the complete workspace change'
              : 'Drafting the corrected workspace change',
            detail: `The local model has streamed ${draftChars.toLocaleString()} characters into the candidate patch; validation follows before files are accepted.`,
            status: 'running',
            timestamp: now,
            startedAt: draftStartedAt
          })
        }
      )
    } catch (error) {
      if (!attemptSignal.timedOut() || signal.aborted) throw error
      const timeoutMessage = `Local model attempt ${attemptNumber} exceeded eight minutes before returning a complete candidate patch.`
      emit({
        id: draftId,
        kind: 'warning',
        label: 'Local workspace draft timed out',
        detail:
          attemptNumber < LOCAL_WORKSPACE_ATTEMPTS
            ? `${timeoutMessage} Akorith is starting the bounded final attempt.`
            : timeoutMessage,
        status: 'error',
        timestamp: Date.now(),
        startedAt: draftStartedAt,
        endedAt: Date.now()
      })
      if (attemptNumber === LOCAL_WORKSPACE_ATTEMPTS) {
        throw new Error(
          'Local model did not return a complete workspace patch within either bounded attempt.'
        )
      }
      previousAttempts =
        `${timeoutMessage}\nReturn a smaller complete patch that still implements the entire request.`
      continue
    } finally {
      attemptSignal.cleanup()
    }
    usages.push(generated.usage)
    lastModel = generated.model
    const stopReason = localGenerationStopReason(generated.raw)
    if (stopReason === 'length') {
      const lengthMessage =
        `Local model attempt ${attemptNumber} reached its output limit before the workspace patch was complete.`
      emit({
        id: draftId,
        kind: 'warning',
        label: 'Local workspace draft reached its output limit',
        detail:
          attemptNumber < LOCAL_WORKSPACE_ATTEMPTS
            ? `${lengthMessage} Akorith is retrying with a compact, self-contained implementation.`
            : lengthMessage,
        status: 'error',
        timestamp: Date.now(),
        startedAt: draftStartedAt,
        endedAt: Date.now()
      })
      if (attemptNumber === LOCAL_WORKSPACE_ATTEMPTS) {
        throw new Error(
          'Local model reached the output limit on both bounded attempts; no partial JSON or unverified files were applied.'
        )
      }
      previousAttempts =
        `${lengthMessage}\nReturn a compact complete implementation. Prefer one self-contained HTML file with inline CSS and JavaScript when that can satisfy the request.`
      continue
    }
    emit({
      id: draftId,
      kind: 'reasoning',
      label: attemptNumber === 1
        ? 'Workspace draft is ready for validation'
        : 'Corrected workspace draft is ready for validation',
      detail: `${draftChars.toLocaleString()} generated characters are ready for Akorith's deterministic checks.`,
      status: 'complete',
      timestamp: Date.now(),
      startedAt: draftStartedAt,
      endedAt: Date.now()
    })
    emit({
      kind: 'file',
      label: `Validating local workspace draft ${attemptNumber}/${LOCAL_WORKSPACE_ATTEMPTS}`,
      status: 'running'
    })
    const attempt = await executeLocalExecutorAttempt({
      workspaceDir,
      rawOutput: generated.text,
      goal,
      completionMode: 'complete_request',
      signal,
      revertOnNoCommit: true
    })
    for (const command of attempt.commandResults) {
      emit({
        kind: 'command',
        label: command.cmd,
        detail: command.passed ? 'Passed' : command.error ?? 'Failed',
        status: command.passed ? 'complete' : 'error'
      })
    }

    if (attempt.score.shouldCommit && !attempt.rollbackFailed) {
      for (const file of attempt.changedFiles) {
        emit({ kind: 'file', label: file, detail: 'Changed', status: 'complete' })
      }
      const validation = validationSummary(attempt)
      const files = attempt.changedFiles.length
        ? `\n\nChanged files:\n${attempt.changedFiles.map((file) => `- ${file}`).join('\n')}`
        : ''
      const text = `${attempt.action?.summary ?? 'Verified local workspace change'}\n\n${validation}.${files}`.trim()
      onToken(text)
      return {
        text,
        usage: mergeLocalWorkspaceUsage(usages),
        model: lastModel,
        raw: { acceptedAttempt: attemptNumber, score: attempt.score }
      }
    }

    if (attempt.rollbackFailed || attemptNumber === LOCAL_WORKSPACE_ATTEMPTS) {
      const reasons =
        attempt.score.reasons.join('; ') ||
        attempt.errors.join('; ') ||
        'the patch did not meet the acceptance gate'
      throw new Error(
        attempt.rollbackFailed
          ? `Local model attempt ${attemptNumber} failed acceptance and Akorith could not safely restore the draft. Review the workspace before retrying. ${reasons}`
          : `Local model did not produce a verified workspace change after ${attemptNumber} attempts. No failed draft was kept. ${validationSummary(attempt)}; ${reasons}`
      )
    }

    previousAttempts = attemptFeedback(attempt, attemptNumber)
    emit({
      kind: 'warning',
      label: 'Local draft did not pass acceptance; it was reverted',
      detail: `${validationSummary(attempt)}. Akorith is making one bounded correction.`,
      status: 'error'
    })
  }

  throw new Error('Local workspace execution ended without an accepted patch.')
}
