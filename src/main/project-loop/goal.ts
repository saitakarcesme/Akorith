import { addBacklogItem, listBacklog, updateBacklogItem } from './backlog'
import { inspectProject, renderProjectContext } from './context'
import { logEvent } from './events'
import {
  buildGoalReviewPrompt,
  buildGoalUnderstandingPrompt,
  fallbackGoalReview,
  fallbackGoalUnderstanding,
  parseGoalProgressReview,
  parseGoalUnderstanding,
  renderGoalContract,
  type GoalProgressReview,
  type GoalUnderstanding
} from './goal-cycle'
import { runOneCycle, type RunCycleResult } from './runner'
import { getLoop, setLoopStatus, updateLoop } from './store'
import { sendMetaPrompt } from '../providers/registry'

export interface GoalRunResult {
  ok: boolean
  status: 'completed' | 'paused' | 'needs_review' | 'error'
  attempts: number
  lastRun?: RunCycleResult
  error?: string
}

async function understandGoal(loopId: string, signal: AbortSignal): Promise<GoalUnderstanding> {
  const loop = getLoop(loopId)
  if (!loop) return fallbackGoalUnderstanding('Complete the requested outcome.')

  if (loop.roadmapSummary?.trim().startsWith('{')) {
    return parseGoalUnderstanding(loop.roadmapSummary, loop.idea ?? loop.title)
  }

  const context = renderProjectContext(inspectProject(loop.localPath))
  let understanding = fallbackGoalUnderstanding(loop.idea ?? loop.title)
  try {
    const response = await sendMetaPrompt(
      loop.localModelProvider,
      loop.localModel,
      buildGoalUnderstandingPrompt(loop, context),
      signal
    )
    understanding = parseGoalUnderstanding(response.text, loop.idea ?? loop.title)
  } catch (error) {
    if (signal.aborted) throw error
    logEvent(loopId, 'note', 'Goal contract used a safe local fallback', error instanceof Error ? error.message : String(error))
  }

  updateLoop(loopId, { roadmapSummary: JSON.stringify(understanding) })
  const current = listBacklog(loopId).find((item) => item.status === 'open' || item.status === 'in_progress')
  if (current) updateBacklogItem(current.id, understanding.firstObjective, renderGoalContract(understanding))
  else addBacklogItem({ loopId, title: understanding.firstObjective, detail: renderGoalContract(understanding), priority: 100 })
  logEvent(loopId, 'goal_understood', understanding.summary, renderGoalContract(understanding))
  return understanding
}

async function reviewProgress(
  loopId: string,
  understanding: GoalUnderstanding,
  lastRun: RunCycleResult,
  attempt: number,
  signal: AbortSignal
): Promise<GoalProgressReview> {
  const loop = getLoop(loopId)
  const fallback = fallbackGoalReview(lastRun.run, attempt)
  if (!loop) return fallback
  const context = renderProjectContext(inspectProject(loop.localPath))
  logEvent(loopId, 'analysis_started', `Analyzing cycle ${attempt}`, 'Checking the complete Goal contract against files, validation results, and the latest execution evidence.', lastRun.run?.id)
  try {
    const response = await sendMetaPrompt(
      loop.localModelProvider,
      loop.localModel,
      buildGoalReviewPrompt({ loop, understanding, run: lastRun.run, attempt, workspaceContext: context }),
      signal
    )
    return parseGoalProgressReview(response.text, lastRun.run, attempt)
  } catch (error) {
    if (signal.aborted) throw error
    logEvent(loopId, 'note', 'Goal analysis used a safe local fallback', error instanceof Error ? error.message : String(error), lastRun.run?.id)
    return fallback
  }
}

function queueNextObjective(loopId: string, review: GoalProgressReview, runId?: string): void {
  const next = review.nextObjective?.trim()
  if (!next) return
  const detail = [review.progressSummary, ...review.remainingWork.map((item) => `Remaining: ${item}`)].join('\n')
  const current = listBacklog(loopId).find((item) => item.status === 'open' || item.status === 'in_progress')
  if (current) updateBacklogItem(current.id, next, detail)
  else addBacklogItem({ loopId, title: next, detail, priority: 100 })
  logEvent(loopId, 'replanned', next, detail, runId)
}

/**
 * Run a durable Goal until the complete contract is satisfied, paused, or needs
 * review. Each cycle checkpoints Understand -> Plan -> Execute -> Analyze ->
 * Replan. GitHub-linked Loops may push verified checkpoints, and a single
 * commit is never treated as completion by itself.
 */
export async function runGoalToCompletion(loopId: string, signal: AbortSignal, maxAttempts = 12): Promise<GoalRunResult> {
  const loop = getLoop(loopId)
  if (!loop) return { ok: false, status: 'error', attempts: 0, error: 'goal not found' }
  setLoopStatus(loopId, 'active')
  updateLoop(loopId, { error: undefined })
  logEvent(loopId, 'resumed', 'Goal started in the background')

  let understanding: GoalUnderstanding
  try {
    understanding = await understandGoal(loopId, signal)
  } catch (error) {
    if (signal.aborted) {
      setLoopStatus(loopId, 'paused')
      return { ok: true, status: 'paused', attempts: 0 }
    }
    const message = error instanceof Error ? error.message : String(error)
    setLoopStatus(loopId, 'needs_review')
    updateLoop(loopId, { error: message })
    return { ok: false, status: 'error', attempts: 0, error: message }
  }

  let lastRun: RunCycleResult | undefined
  let stalledCycles = 0

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal.aborted) {
      setLoopStatus(loopId, 'paused')
      logEvent(loopId, 'paused', 'Goal paused by the user')
      return { ok: true, status: 'paused', attempts: attempt - 1, lastRun }
    }

    setLoopStatus(loopId, 'active')
    lastRun = await runOneCycle(loopId, signal)
    if (signal.aborted) {
      setLoopStatus(loopId, 'paused')
      logEvent(loopId, 'paused', 'Goal paused by the user')
      return { ok: true, status: 'paused', attempts: attempt, lastRun }
    }

    const review = await reviewProgress(loopId, understanding, lastRun, attempt, signal)
    updateLoop(loopId, { memorySummary: JSON.stringify(review), error: lastRun.error })
    logEvent(
      loopId,
      'analyzed',
      review.progressSummary,
      JSON.stringify({
        completedEvidence: review.completedEvidence,
        remainingWork: review.remainingWork,
        confidence: review.confidence,
        blocked: review.blocked
      }),
      lastRun.run?.id
    )

    if (review.goalMet && review.confidence >= 0.55) {
      setLoopStatus(loopId, 'completed')
      updateLoop(loopId, { error: undefined })
      logEvent(loopId, 'goal_completed', 'Goal reached with inspectable evidence', review.completedEvidence.join('\n'), lastRun.run?.id)
      return { ok: true, status: 'completed', attempts: attempt, lastRun }
    }

    const materiallyChanged = lastRun.committed || Boolean(lastRun.run && (lastRun.run.filesChanged > 0 || lastRun.run.commandsRun > 0))
    stalledCycles = materiallyChanged ? 0 : stalledCycles + 1
    if (review.blocked || stalledCycles >= 3) {
      const reason = review.blocked
        ? 'The Goal analysis found a blocker that needs review.'
        : 'The Goal made no material progress in three consecutive cycles.'
      setLoopStatus(loopId, 'needs_review')
      updateLoop(loopId, { error: reason })
      logEvent(loopId, 'note', reason, review.remainingWork.join('\n'), lastRun.run?.id)
      return { ok: false, status: 'needs_review', attempts: attempt, lastRun, error: reason }
    }

    queueNextObjective(loopId, review, lastRun.run?.id)
  }

  const error = `Goal needs review after ${maxAttempts} cycles.`
  setLoopStatus(loopId, 'needs_review')
  updateLoop(loopId, { error })
  logEvent(loopId, 'note', error)
  return { ok: false, status: 'needs_review', attempts: maxAttempts, lastRun, error }
}
