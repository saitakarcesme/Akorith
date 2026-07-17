import { randomUUID } from 'crypto'
import { runResearchCycle } from './runner'
import {
  acquireResearchLease,
  cancelInterruptedResearchCycles,
  clearResearchCancellation,
  getResearchJob,
  heartbeatResearchLease,
  listDueResearchJobs,
  logResearchEvent,
  releaseExpiredResearchLeases,
  releaseResearchLease,
  requestResearchCancellation,
  updateResearchJob
} from './store'
import { RESEARCH_DEPTH_PROFILES, type ResearchJob, type ResearchStatus } from './types'

const MAX_CONCURRENT_RESEARCH_JOBS = 3
const SCHEDULER_TICK_MS = 5_000
const RESEARCH_LEASE_MS = 2 * 60_000
const RESEARCH_HEARTBEAT_MS = 30_000
const MIN_RETRY_DELAY_MS = 60_000

interface ActiveResearchRun {
  controller: AbortController
  heartbeatTimer: NodeJS.Timeout | null
  leaseLost: boolean
  promise: Promise<void>
}

export interface ResearchSchedulerSnapshot {
  started: boolean
  owner: string
  maxConcurrency: number
  activeJobIds: string[]
  recoveredLeaseCount: number
  recoveredCycleCount: number
}

const schedulerOwner = `akorith-research-${process.pid}-${randomUUID()}`
const activeRuns = new Map<string, ActiveResearchRun>()

let schedulerTimer: NodeJS.Timeout | null = null
let schedulerStarted = false
let drainInProgress = false
let drainQueued = false
let recoveredLeaseCount = 0
let recoveredCycleCount = 0

function statusForPhase(job: ResearchJob): ResearchStatus {
  switch (job.phase) {
    case 'understand':
    case 'plan':
      return 'planning'
    case 'research':
      return 'researching'
    case 'verify':
      return 'verifying'
    case 'synthesize':
      return 'synthesizing'
    case 'export':
      return 'exporting'
  }
}

function abortRun(jobId: string, reason: string): boolean {
  const active = activeRuns.get(jobId)
  if (!active || active.controller.signal.aborted) return false
  active.controller.abort(new Error(reason))
  return true
}

function retryDelay(job: ResearchJob): number {
  return Math.max(MIN_RETRY_DELAY_MS, RESEARCH_DEPTH_PROFILES[job.depth].cycleIntervalMs)
}

function recordSchedulerFailure(jobId: string, error: unknown): void {
  const job = getResearchJob(jobId)
  if (!job || job.status === 'completed' || job.status === 'paused' || job.status === 'archived') return
  const message = error instanceof Error ? error.message : String(error)
  updateResearchJob(jobId, {
    status: 'error',
    error: message,
    nextRunAt: Date.now() + retryDelay(job)
  })
  logResearchEvent({
    jobId,
    kind: 'error',
    title: 'Research scheduler could not run this cycle',
    detail: message
  })
}

function startLeaseHeartbeat(jobId: string, active: ActiveResearchRun): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (active.controller.signal.aborted) return
    try {
      if (heartbeatResearchLease(jobId, schedulerOwner, RESEARCH_LEASE_MS)) return
      active.leaseLost = true
      active.controller.abort(new Error('The research lease was lost while this cycle was running.'))
    } catch (error) {
      active.leaseLost = true
      const message = error instanceof Error ? error.message : String(error)
      active.controller.abort(new Error(`The research lease heartbeat failed: ${message}`))
    }
  }, RESEARCH_HEARTBEAT_MS)
  timer.unref()
  return timer
}

async function executeLeasedJob(jobId: string, active: ActiveResearchRun): Promise<void> {
  active.heartbeatTimer = startLeaseHeartbeat(jobId, active)
  try {
    await runResearchCycle(jobId, active.controller.signal)
  } catch (error) {
    if (!active.controller.signal.aborted && !active.leaseLost) recordSchedulerFailure(jobId, error)
  } finally {
    if (active.heartbeatTimer) clearInterval(active.heartbeatTimer)
    try {
      releaseResearchLease(jobId, schedulerOwner)
    } finally {
      activeRuns.delete(jobId)
      queueSchedulerDrain()
    }
  }
}

function launchLeasedJob(jobId: string): void {
  if (activeRuns.has(jobId)) return

  const active: ActiveResearchRun = {
    controller: new AbortController(),
    heartbeatTimer: null,
    leaseLost: false,
    promise: Promise.resolve()
  }
  activeRuns.set(jobId, active)
  active.promise = executeLeasedJob(jobId, active).catch((error) => {
    if (!active.controller.signal.aborted && !active.leaseLost) recordSchedulerFailure(jobId, error)
  })
  void active.promise
}

async function drainDueResearchJobs(): Promise<void> {
  if (!schedulerStarted || drainInProgress) return
  drainInProgress = true
  try {
    let remaining = MAX_CONCURRENT_RESEARCH_JOBS - activeRuns.size
    if (remaining <= 0) return

    // Fetch extra candidates because another process may win a lease between
    // listing a due job and this scheduler acquiring it.
    const candidates = listDueResearchJobs(Date.now(), Math.max(remaining * 4, remaining))
    for (const job of candidates) {
      if (remaining <= 0) break
      if (activeRuns.has(job.id)) continue
      if (!acquireResearchLease(job.id, schedulerOwner, RESEARCH_LEASE_MS)) continue
      launchLeasedJob(job.id)
      remaining -= 1
    }
  } finally {
    drainInProgress = false
  }
}

function queueSchedulerDrain(): void {
  if (!schedulerStarted || drainQueued) return
  drainQueued = true
  queueMicrotask(() => {
    drainQueued = false
    void drainDueResearchJobs().catch(() => {
      // A later timer tick retries discovery. Per-job failures are recorded by
      // executeLeasedJob; a global DB failure cannot be attributed safely.
    })
  })
}

export function startResearchScheduler(): void {
  if (schedulerStarted) return
  // During normal app startup this map is empty. The guard also makes an
  // in-process stop/start safe while aborted runs are still unwinding.
  if (activeRuns.size === 0) {
    recoveredLeaseCount = releaseExpiredResearchLeases()
    recoveredCycleCount = cancelInterruptedResearchCycles()
  }
  schedulerStarted = true
  schedulerTimer = setInterval(queueSchedulerDrain, SCHEDULER_TICK_MS)
  schedulerTimer.unref()
  queueSchedulerDrain()
}

export function kickResearchScheduler(): void {
  queueSchedulerDrain()
}

export function stopResearchScheduler(): void {
  schedulerStarted = false
  drainQueued = false
  if (schedulerTimer) clearInterval(schedulerTimer)
  schedulerTimer = null
  for (const jobId of activeRuns.keys()) {
    abortRun(jobId, 'The Research scheduler is shutting down.')
  }
}

export async function shutdownResearchScheduler(): Promise<void> {
  const pending = [...activeRuns.values()].map((active) => active.promise)
  stopResearchScheduler()
  await Promise.allSettled(pending)
}

export function cancelActiveResearchRun(jobId: string): boolean {
  return abortRun(jobId, 'The active research cycle was cancelled.')
}

export function pauseScheduledResearchJob(jobId: string): ResearchJob | null {
  const job = getResearchJob(jobId)
  if (!job || job.status === 'completed' || job.status === 'archived') return job
  requestResearchCancellation(jobId)
  abortRun(jobId, 'The research job was paused.')
  const paused = updateResearchJob(jobId, { status: 'paused', nextRunAt: undefined })
  logResearchEvent({ jobId, kind: 'paused', title: 'Research paused' })
  return paused
}

export function resumeScheduledResearchJob(jobId: string): ResearchJob | null {
  const job = getResearchJob(jobId)
  if (!job || job.status === 'completed' || job.status === 'archived') return job
  clearResearchCancellation(jobId)
  const resumed = updateResearchJob(jobId, {
    status: statusForPhase(job),
    error: undefined,
    startedAt: job.startedAt ?? Date.now(),
    nextRunAt: Date.now()
  })
  logResearchEvent({ jobId, kind: 'resumed', title: 'Research resumed' })
  queueSchedulerDrain()
  return resumed
}

export function isResearchJobRunning(jobId: string): boolean {
  return activeRuns.has(jobId)
}

export function getResearchSchedulerSnapshot(): ResearchSchedulerSnapshot {
  return {
    started: schedulerStarted,
    owner: schedulerOwner,
    maxConcurrency: MAX_CONCURRENT_RESEARCH_JOBS,
    activeJobIds: [...activeRuns.keys()],
    recoveredLeaseCount,
    recoveredCycleCount
  }
}
