import { randomUUID } from 'crypto'
import { getDb } from '../../db'
import type { ResearchEvent, ResearchEventKind } from '../types'
import { rowToResearchEvent, type DbRow } from './rows'

const MAX_EVENT_TITLE = 240
const MAX_EVENT_DETAIL = 80_000

export function logResearchEvent(input: {
  jobId: string
  cycleId?: string
  kind: ResearchEventKind
  title: string
  detail?: string
}): ResearchEvent {
  const event: ResearchEvent = {
    id: randomUUID(),
    jobId: input.jobId,
    cycleId: input.cycleId,
    kind: input.kind,
    title: input.title.replace(/\s+/g, ' ').trim().slice(0, MAX_EVENT_TITLE),
    detail: input.detail?.trim().slice(0, MAX_EVENT_DETAIL),
    createdAt: Date.now()
  }
  getDb().prepare(
    `INSERT INTO research_events (id, job_id, cycle_id, kind, title, detail, created_at)
     VALUES (@id, @job_id, @cycle_id, @kind, @title, @detail, @created_at)`
  ).run({
    id: event.id,
    job_id: event.jobId,
    cycle_id: event.cycleId ?? null,
    kind: event.kind,
    title: event.title,
    detail: event.detail ?? null,
    created_at: event.createdAt
  })
  return event
}

export function listResearchEvents(jobId: string, limit = 1_000): ResearchEvent[] {
  const bounded = Math.min(Math.max(limit, 1), 5_000)
  const rows = getDb().prepare(
    `SELECT * FROM research_events WHERE job_id = ?
     ORDER BY created_at ASC LIMIT ?`
  ).all(jobId, bounded) as DbRow[]
  return rows.map(rowToResearchEvent)
}

export function listLatestResearchEvents(jobId: string, limit = 200): ResearchEvent[] {
  const bounded = Math.min(Math.max(limit, 1), 1_000)
  const rows = getDb().prepare(
    `SELECT * FROM (
       SELECT * FROM research_events WHERE job_id = ? ORDER BY created_at DESC LIMIT ?
     ) ORDER BY created_at ASC`
  ).all(jobId, bounded) as DbRow[]
  return rows.map(rowToResearchEvent)
}
