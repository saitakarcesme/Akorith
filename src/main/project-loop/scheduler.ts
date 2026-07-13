import { getLoop, listLoops, updateLoop } from './store'
import { runOneCycle } from './runner'
import type { ProjectLoop } from './types'

const AUTO_LOOP_TICK_MS = 10_000
const AUTO_LOOP_DEFAULT_INTERVAL_MS = 60_000
const AUTO_LOOP_MIN_INTERVAL_MS = 60_000

let timer: NodeJS.Timeout | null = null
let checking = false
const running = new Set<string>()

function intervalMs(loop: ProjectLoop): number {
  if (loop.scheduleKind === 'interval' && loop.scheduleMinutes > 0) {
    return Math.max(loop.scheduleMinutes * 60_000, AUTO_LOOP_MIN_INTERVAL_MS)
  }
  if (loop.scheduleKind === 'daily') {
    const runsPerDay = Math.max(1, loop.dailyCommitTarget || 1)
    return Math.max(Math.floor(24 * 60 * 60_000 / runsPerDay), AUTO_LOOP_MIN_INTERVAL_MS)
  }
  return AUTO_LOOP_DEFAULT_INTERVAL_MS
}

function isRunnable(loop: ProjectLoop, now: number): boolean {
  if (loop.status !== 'active' || loop.autonomy !== 'auto' || running.has(loop.id)) return false
  if (loop.nextRunAt && loop.nextRunAt > now) return false
  if (!loop.lastRunAt) return true
  return now - loop.lastRunAt >= intervalMs(loop)
}

async function runAutoLoop(loop: ProjectLoop): Promise<void> {
  running.add(loop.id)
  try {
    updateLoop(loop.id, { nextRunAt: Date.now() + intervalMs(loop) })
    const result = await runOneCycle(loop.id)
    const latest = getLoop(loop.id)
    if (latest?.autonomy === 'auto' && (latest.status === 'active' || latest.status === 'error')) {
      updateLoop(loop.id, {
        status: 'active',
        error: result.ok ? undefined : result.error ?? latest.error,
        nextRunAt: Date.now() + intervalMs(latest)
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const latest = getLoop(loop.id)
    if (latest?.autonomy === 'auto' && latest.status !== 'paused' && latest.status !== 'archived' && latest.status !== 'completed') {
      updateLoop(loop.id, { status: 'active', error: message, nextRunAt: Date.now() + intervalMs(latest) })
    } else {
      updateLoop(loop.id, { status: 'error', error: message })
    }
  } finally {
    running.delete(loop.id)
  }
}

async function runDueAutoLoops(): Promise<void> {
  if (checking) return
  checking = true
  try {
    const now = Date.now()
    const due = listLoops().filter((loop) => isRunnable(loop, now))
    for (const loop of due) await runAutoLoop(loop)
  } finally {
    checking = false
  }
}

export function startProjectLoopAutoScheduler(): void {
  if (timer) return
  timer = setInterval(() => void runDueAutoLoops(), AUTO_LOOP_TICK_MS)
  void runDueAutoLoops()
}

export function kickProjectLoopAutoScheduler(): void {
  if (!timer) return
  void runDueAutoLoops()
}

export function stopProjectLoopAutoScheduler(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
