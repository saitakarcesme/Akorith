import { randomUUID } from 'crypto'
import { getDb } from '../db'
import type { ProjectLoopEvent, ProjectLoopEventKind } from './types'

// Phase 48: the loop event log — an append-only audit trail of everything a loop
// does (inspect, plan, propose, validate, apply, validate, commit, …).

type Row = Record<string, unknown>

function rowToEvent(r: Row): ProjectLoopEvent {
  return {
    id: String(r.id),
    loopId: String(r.loop_id),
    runId: typeof r.run_id === 'string' ? r.run_id : undefined,
    kind: String(r.kind) as ProjectLoopEventKind,
    message: String(r.message),
    detail: typeof r.detail === 'string' ? r.detail : undefined,
    createdAt: typeof r.created_at === 'number' ? r.created_at : 0
  }
}

export function logEvent(
  loopId: string,
  kind: ProjectLoopEventKind,
  message: string,
  detail?: string,
  runId?: string
): ProjectLoopEvent {
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO project_loop_events (id, loop_id, run_id, kind, message, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, loopId, runId ?? null, kind, message.slice(0, 500), detail ?? null, Date.now())
  const row = getDb().prepare('SELECT * FROM project_loop_events WHERE id = ?').get(id) as Row
  return rowToEvent(row)
}

export function listEvents(loopId: string, limit = 100): ProjectLoopEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_loop_events WHERE loop_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(loopId, limit) as Row[]
  return rows.map(rowToEvent)
}

export function listRunEvents(runId: string): ProjectLoopEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_loop_events WHERE run_id = ? ORDER BY created_at ASC')
    .all(runId) as Row[]
  return rows.map(rowToEvent)
}
