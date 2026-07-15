import { listBacklog } from './backlog'
import { logEvent } from './events'
import { runOneCycle, type RunCycleResult } from './runner'
import { getLoop, setLoopStatus, updateLoop } from './store'

export interface GoalRunResult {
  ok: boolean
  status: 'completed' | 'paused' | 'needs_review' | 'error'
  attempts: number
  lastRun?: RunCycleResult
  error?: string
}

/** Run one durable goal until it commits, pauses, or needs review. It never pushes. */
export async function runGoalToCompletion(loopId: string, signal: AbortSignal, maxAttempts = 6): Promise<GoalRunResult> {
  const loop = getLoop(loopId)
  if (!loop) return { ok: false, status: 'error', attempts: 0, error: 'goal not found' }
  setLoopStatus(loopId, 'active')
  updateLoop(loopId, { error: undefined })
  logEvent(loopId, 'resumed', 'Goal started in the background')
  let lastRun: RunCycleResult | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal.aborted) {
      setLoopStatus(loopId, 'paused')
      logEvent(loopId, 'paused', 'Goal paused by the user')
      return { ok: true, status: 'paused', attempts: attempt - 1, lastRun }
    }
    lastRun = await runOneCycle(loopId, signal)
    if (signal.aborted) {
      setLoopStatus(loopId, 'paused')
      logEvent(loopId, 'paused', 'Goal paused by the user')
      return { ok: true, status: 'paused', attempts: attempt, lastRun }
    }
    const hasOpenWork = listBacklog(loopId).some((item) => item.status === 'open' || item.status === 'in_progress')
    if (lastRun.committed || !hasOpenWork) {
      setLoopStatus(loopId, 'completed')
      logEvent(loopId, 'run_succeeded', 'Goal completed and verified')
      return { ok: true, status: 'completed', attempts: attempt, lastRun }
    }
    if (!lastRun.ok && getLoop(loopId)?.status === 'error') {
      setLoopStatus(loopId, 'needs_review')
      return { ok: false, status: 'needs_review', attempts: attempt, lastRun, error: lastRun.error }
    }
  }

  setLoopStatus(loopId, 'needs_review')
  logEvent(loopId, 'note', `Goal paused for review after ${maxAttempts} attempts`)
  return { ok: false, status: 'needs_review', attempts: maxAttempts, lastRun, error: 'maximum attempts reached' }
}
