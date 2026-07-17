import { randomUUID } from 'crypto'
import { getDb } from '../../db'
import type { ResearchCheckpoint, ResearchPhase, ResearchWorkspaceState } from '../types'
import { numberValue, optionalString, type DbRow } from './rows'

function rowToCheckpoint(row: DbRow): ResearchCheckpoint {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    cycleId: optionalString(row.cycle_id),
    idempotencyKey: String(row.idempotency_key),
    phase: String(row.phase) as ResearchPhase,
    state: JSON.parse(String(row.state_json)) as ResearchWorkspaceState,
    createdAt: numberValue(row.created_at)
  }
}

export function saveResearchCheckpoint(input: {
  jobId: string
  cycleId?: string
  idempotencyKey: string
  phase: ResearchPhase
  state: ResearchWorkspaceState
}): ResearchCheckpoint {
  const id = randomUUID()
  const createdAt = Date.now()
  getDb().prepare(
    `INSERT INTO research_checkpoints (
      id, job_id, cycle_id, idempotency_key, phase, state_json, created_at
    ) VALUES (
      @id, @job_id, @cycle_id, @idempotency_key, @phase, @state_json, @created_at
    )
    ON CONFLICT(job_id, idempotency_key) DO UPDATE SET
      cycle_id = excluded.cycle_id,
      phase = excluded.phase,
      state_json = excluded.state_json,
      created_at = excluded.created_at`
  ).run({
    id,
    job_id: input.jobId,
    cycle_id: input.cycleId ?? null,
    idempotency_key: input.idempotencyKey.slice(0, 240),
    phase: input.phase,
    state_json: JSON.stringify(input.state),
    created_at: createdAt
  })
  return getResearchCheckpoint(input.jobId, input.idempotencyKey)!
}

export function getResearchCheckpoint(jobId: string, idempotencyKey: string): ResearchCheckpoint | null {
  const row = getDb().prepare(
    'SELECT * FROM research_checkpoints WHERE job_id = ? AND idempotency_key = ?'
  ).get(jobId, idempotencyKey) as DbRow | undefined
  return row ? rowToCheckpoint(row) : null
}

export function latestResearchCheckpoint(jobId: string): ResearchCheckpoint | null {
  const row = getDb().prepare(
    'SELECT * FROM research_checkpoints WHERE job_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(jobId) as DbRow | undefined
  return row ? rowToCheckpoint(row) : null
}
