import { randomUUID } from 'crypto'
import { getDb } from '../../db'
import type { ResearchEvent, ResearchEventKind } from '../types'
import { rowToResearchEvent, type DbRow } from './rows'

const MAX_EVENT_TITLE = 240
const MAX_EVENT_DETAIL = 80_000
const MAX_LIVE_EVENT_DETAIL = 4_000

export interface ResearchEventCursor {
  id: string
  createdAt: number
}

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

/**
 * Renderer polling only needs the recent activity stream. Bound each detail in
 * SQL so a verbose tool result never crosses IPC on every refresh.
 */
export function listLatestResearchEventSummaries(jobId: string, limit = 80): ResearchEvent[] {
  const bounded = Math.min(Math.max(limit, 1), 200)
  const rows = getDb().prepare(
    `SELECT * FROM (
       SELECT id, job_id, cycle_id, kind, title,
              CASE WHEN detail IS NULL THEN NULL ELSE substr(detail, 1, ?) END AS detail,
              created_at
       FROM research_events
       WHERE job_id = ?
       ORDER BY created_at DESC
       LIMIT ?
     ) ORDER BY created_at ASC`
  ).all(MAX_LIVE_EVENT_DETAIL, jobId, bounded) as DbRow[]
  return rows.map(rowToResearchEvent)
}

export function latestResearchEventCursor(jobId: string): ResearchEventCursor | null {
  const row = getDb().prepare(
    'SELECT id, created_at FROM research_events WHERE job_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(jobId) as { id: string; created_at: number } | undefined
  return row ? { id: row.id, createdAt: row.created_at } : null
}
