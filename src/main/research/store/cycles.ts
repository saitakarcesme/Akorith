import { randomUUID } from 'crypto'
import { getDb } from '../../db'
import type { ResearchCycle, ResearchCycleStatus, ResearchPhase } from '../types'
import { rowToResearchCycle, type DbRow } from './rows'

export function startResearchCycle(input: {
  jobId: string
  phase: ResearchPhase
  objective: string
}): ResearchCycle {
  const now = Date.now()
  const next = getDb()
    .prepare('SELECT COALESCE(MAX(cycle_index), 0) + 1 AS next FROM research_cycles WHERE job_id = ?')
    .get(input.jobId) as { next: number }
  const cycle: ResearchCycle = {
    id: randomUUID(),
    jobId: input.jobId,
    cycleIndex: next.next,
    phase: input.phase,
    status: 'running',
    objective: input.objective.trim().slice(0, 40_000),
    sourceCount: 0,
    findingCount: 0,
    startedAt: now
  }
  getDb().prepare(
    `INSERT INTO research_cycles (
      id, job_id, cycle_index, phase, status, objective, source_count,
      finding_count, started_at
    ) VALUES (
      @id, @job_id, @cycle_index, @phase, @status, @objective, 0, 0, @started_at
    )`
  ).run({
    id: cycle.id,
    job_id: cycle.jobId,
    cycle_index: cycle.cycleIndex,
    phase: cycle.phase,
    status: cycle.status,
    objective: cycle.objective,
    started_at: cycle.startedAt
  })
  return cycle
}

export function getResearchCycle(id: string): ResearchCycle | null {
  const row = getDb().prepare('SELECT * FROM research_cycles WHERE id = ?').get(id) as DbRow | undefined
  return row ? rowToResearchCycle(row) : null
}

export function listResearchCycles(jobId: string): ResearchCycle[] {
  const rows = getDb()
    .prepare('SELECT * FROM research_cycles WHERE job_id = ? ORDER BY cycle_index ASC')
    .all(jobId) as DbRow[]
  return rows.map(rowToResearchCycle)
}

export function finishResearchCycle(
  id: string,
  patch: {
    status: Exclude<ResearchCycleStatus, 'pending' | 'running'>
    result?: string
    sourceCount?: number
    findingCount?: number
    promptTokens?: number
    completionTokens?: number
    error?: string
  }
): ResearchCycle | null {
  getDb().prepare(
    `UPDATE research_cycles
     SET status = @status,
         result = @result,
         source_count = @source_count,
         finding_count = @finding_count,
         prompt_tokens = @prompt_tokens,
         completion_tokens = @completion_tokens,
         ended_at = @ended_at,
         error = @error
     WHERE id = @id`
  ).run({
    id,
    status: patch.status,
    result: patch.result?.slice(0, 120_000) ?? null,
    source_count: Math.max(0, patch.sourceCount ?? 0),
    finding_count: Math.max(0, patch.findingCount ?? 0),
    prompt_tokens: patch.promptTokens ?? null,
    completion_tokens: patch.completionTokens ?? null,
    ended_at: Date.now(),
    error: patch.error?.slice(0, 20_000) ?? null
  })
  return getResearchCycle(id)
}

export function cancelInterruptedResearchCycles(jobId?: string): number {
  const result = jobId
    ? getDb().prepare(
      `UPDATE research_cycles SET status = 'cancelled', ended_at = @now,
       error = COALESCE(error, 'Research process restarted before the cycle completed.')
       WHERE status = 'running' AND job_id = @job_id`
    ).run({ now: Date.now(), job_id: jobId })
    : getDb().prepare(
      `UPDATE research_cycles SET status = 'cancelled', ended_at = @now,
       error = COALESCE(error, 'Research process restarted before the cycle completed.')
       WHERE status = 'running'`
    ).run({ now: Date.now() })
  return result.changes
}
