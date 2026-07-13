import { randomUUID } from 'crypto'
import { getDb } from '../db'
import type { BacklogItemStatus, ProjectLoopBacklogItem } from './types'

// Phase 48: the per-loop backlog — feature ideas / roadmap items the planner can
// pull the next objective from.

type Row = Record<string, unknown>

function rowToItem(r: Row): ProjectLoopBacklogItem {
  return {
    id: String(r.id),
    loopId: String(r.loop_id),
    title: String(r.title),
    detail: typeof r.detail === 'string' ? r.detail : undefined,
    category: typeof r.category === 'string' ? r.category : undefined,
    priority: typeof r.priority === 'number' ? r.priority : 0,
    status: String(r.status) as BacklogItemStatus,
    createdAt: typeof r.created_at === 'number' ? r.created_at : 0,
    updatedAt: typeof r.updated_at === 'number' ? r.updated_at : 0
  }
}

export function addBacklogItem(input: {
  loopId: string
  title: string
  detail?: string
  category?: string
  priority?: number
}): ProjectLoopBacklogItem {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO project_loop_backlog_items (id, loop_id, title, detail, category, priority, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    )
    .run(id, input.loopId, input.title.slice(0, 200), input.detail ?? null, input.category ?? null, input.priority ?? 0, now, now)
  return rowToItem(getDb().prepare('SELECT * FROM project_loop_backlog_items WHERE id = ?').get(id) as Row)
}

export function listBacklog(loopId: string): ProjectLoopBacklogItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_loop_backlog_items WHERE loop_id = ? ORDER BY status, priority DESC, created_at')
    .all(loopId) as Row[]
  return rows.map(rowToItem)
}

export function setBacklogStatus(id: string, status: BacklogItemStatus): void {
  getDb().prepare('UPDATE project_loop_backlog_items SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
}

/** Next open item by priority — the planner's default objective source. */
export function nextOpenBacklogItem(loopId: string): ProjectLoopBacklogItem | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM project_loop_backlog_items WHERE loop_id = ? AND status = 'open' ORDER BY priority DESC, created_at LIMIT 1"
    )
    .get(loopId) as Row | undefined
  return row ? rowToItem(row) : null
}
