import {
  RESEARCH_DEPTH_PROFILES,
  type ResearchJob,
  type ResearchPlan,
  type ResearchPlanSection
} from './types'

const MIN_SOURCE_GATE: Record<ResearchJob['depth'], number> = {
  quick: 3,
  standard: 8,
  focused3h: 12,
  extended6h: 16,
  deep: 20,
  day: 28,
  continuous: 3
}

export const SUSTAINED_LOCAL_RESEARCH_COOLDOWN_MS = 5_000

const FOLLOW_UP_LENSES = [
  'primary source update',
  'independent corroboration',
  'contradictory evidence and limitations',
  'recent developments and changed facts'
] as const

export interface ResearchCoverageSnapshot {
  total: number
  coverage: number
}

export interface ResearchCompletionDecision {
  allSectionsComplete: boolean
  evidenceReady: boolean
  cycleBudgetUsed: boolean
  targetDurationReached: boolean
  shouldSynthesize: boolean
}

/**
 * Only scheduler-active time counts toward a bounded Research promise. Queue,
 * pause, provider-error, app-offline, and machine-sleep gaps are excluded by
 * the persisted active clock.
 */
export function researchActiveElapsedMs(job: ResearchJob, now = Date.now()): number {
  const settled = Math.max(0, job.activeElapsedMs || 0)
  if (job.activeAccountingAt == null) return settled
  return settled + Math.min(15_000, Math.max(0, now - job.activeAccountingAt))
}

export function researchTargetDeadline(job: ResearchJob, now = Date.now()): number | null {
  if (job.depth === 'continuous') return null
  const remaining = Math.max(0, job.targetDurationMs - researchActiveElapsedMs(job, now))
  return now + remaining
}

export function hasReachedResearchTargetDuration(job: ResearchJob, now = Date.now()): boolean {
  return job.depth !== 'continuous'
    && researchActiveElapsedMs(job, now) >= Math.max(0, job.targetDurationMs)
}

/**
 * Evidence readiness and elapsed-time readiness are intentionally separate.
 * Bounded modes need both. Continuous mode retains its evidence-driven snapshot
 * behavior and never acquires an artificial duration deadline.
 */
export function evaluateResearchCompletion(input: {
  job: ResearchJob
  plan: ResearchPlan
  coverage: ResearchCoverageSnapshot
  now?: number
}): ResearchCompletionDecision {
  const { job, plan, coverage } = input
  const allSectionsComplete = plan.sections.length > 0
    && plan.sections.every((section) => section.status === 'complete')
  const sourceGate = job.sourceCount >= MIN_SOURCE_GATE[job.depth]
  const coverageGate = coverage.total > 0 && coverage.coverage >= 0.6
  const cycleBudgetUsed = job.maxCycles > 0 && job.cycleCount >= job.maxCycles

  if (job.depth === 'continuous') {
    const evidenceReady = allSectionsComplete && sourceGate && coverageGate
    return {
      allSectionsComplete,
      evidenceReady,
      cycleBudgetUsed: false,
      targetDurationReached: false,
      shouldSynthesize: evidenceReady
    }
  }

  // Once a bounded job has spent its full successful-cycle budget, a local
  // model failing to emit sectionComplete must not make the job immortal.
  // Preserve allSectionsComplete as a diagnostic, while requiring a non-empty
  // plan plus the objective source/coverage gates before synthesis is allowed.
  // A zero-source report is never considered ready merely because a clock
  // expired.
  const hasPlan = plan.sections.length > 0
  const evidenceReady = hasPlan && sourceGate && coverageGate && cycleBudgetUsed
  const targetDurationReached = hasReachedResearchTargetDuration(job, input.now)
  return {
    allSectionsComplete,
    evidenceReady,
    cycleBudgetUsed,
    targetDurationReached,
    shouldSynthesize: evidenceReady && targetDurationReached
  }
}

/**
 * Pick pending work first. Bounded jobs may revisit completed sections for
 * additional corroboration while their promised research window is still open.
 * Continuous jobs leave this disabled so their existing snapshot/reset cycle is
 * unchanged.
 */
export function chooseResearchSection(
  plan: ResearchPlan,
  cycleCount: number,
  options: { revisitCompleted?: boolean } = {}
): ResearchPlanSection | null {
  const pending = plan.sections.filter((section) => section.status !== 'complete')
  if (pending.length > 0) return pending[cycleCount % pending.length]
  if (!options.revisitCompleted || plan.sections.length === 0) return null
  return plan.sections[cycleCount % plan.sections.length]
}

/**
 * A repeated section is a verification pass, not a byte-for-byte replay. Rotate
 * through the planner's query set and add a corroboration lens so later cycles
 * can discover evidence that the first search pass did not surface.
 */
export function prepareResearchSectionForCycle(
  section: ResearchPlanSection,
  cycleCount: number
): ResearchPlanSection {
  if (section.status !== 'complete') return section
  const baseQueries = section.queries.length > 0 ? section.queries : [section.objective]
  const offset = cycleCount % baseQueries.length
  const rotated = [...baseQueries.slice(offset), ...baseQueries.slice(0, offset)]
  const queries = rotated.map((query, index) =>
    `${query} ${FOLLOW_UP_LENSES[(cycleCount + index) % FOLLOW_UP_LENSES.length]}`.slice(0, 1_000)
  )
  const lens = FOLLOW_UP_LENSES[cycleCount % FOLLOW_UP_LENSES.length]
  return {
    ...section,
    status: 'active',
    objective: `${section.objective} Follow-up verification: seek ${lens}, re-check prior conclusions, and preserve conflicts.`,
    queries
  }
}

/**
 * Spread the remaining successful-cycle budget over the remaining active
 * duration instead of burning every cycle at the profile's minimum interval.
 * If an older job already exhausted its budget too early, keep doing measured
 * corroboration passes at the nominal profile cadence until the duration gate.
 */
export function nextResearchCycleAt(job: ResearchJob, now = Date.now()): number {
  const minimumInterval = RESEARCH_DEPTH_PROFILES[job.depth].cycleIntervalMs

  // A single bounded local inference already saturates the GPU. Keep that
  // model fed with a small cooperative cooldown instead of spreading its
  // cycle budget across the full target duration. Continuous remains on its
  // watch cadence, and remote providers retain the existing paced policy.
  if (job.providerId === 'local' && job.depth !== 'continuous') {
    return now + SUSTAINED_LOCAL_RESEARCH_COOLDOWN_MS
  }

  const deadline = researchTargetDeadline(job, now)
  if (deadline === null) return now + minimumInterval

  const remainingDuration = Math.max(0, deadline - now)
  const remainingCycles = Math.max(0, job.maxCycles - job.cycleCount)
  const nominalInterval = job.maxCycles > 0
    ? Math.ceil(Math.max(0, job.targetDurationMs) / job.maxCycles)
    : minimumInterval
  // An overdue job may still owe cycles after an app restart. Keep the normal
  // floor instead of issuing a burst. If its budget is already complete but
  // evidence is still weak, continue measured verification at nominal cadence.
  if (remainingDuration === 0) {
    return now + Math.max(minimumInterval, remainingCycles > 0 ? minimumInterval : nominalInterval)
  }

  const pacedInterval = remainingCycles > 0
    ? Math.ceil(remainingDuration / remainingCycles)
    : nominalInterval
  const delay = Math.max(minimumInterval, pacedInterval)
  return now + Math.min(remainingDuration, delay)
}

/** A successful cycle advances exactly once, regardless of failed attempt ids. */
export function completedResearchCycleCountAfterSuccess(currentCount: number): number {
  return Math.max(0, Math.floor(currentCount)) + 1
}
