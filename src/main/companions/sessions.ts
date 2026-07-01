import { randomUUID } from 'crypto'
import { getDb } from '../db'
import type { CompanionSession } from './types'

// Phase 50: companion conversation sessions.

type Row = Record<string, unknown>

function rowToSession(r: Row): CompanionSession {
  return {
    id: String(r.id),
    companionId: String(r.companion_id),
    title: String(r.title),
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0,
    messageCount: Number(r.message_count) || 0
  }
}

export function createSession(companionId: string, title = 'New conversation'): CompanionSession {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare('INSERT INTO companion_sessions (id, companion_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, companionId, title.slice(0, 120), now, now)
  return getSession(id)!
}

export function getSession(id: string): CompanionSession | null {
  const row = getDb()
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM companion_messages m WHERE m.session_id = s.id) AS message_count
       FROM companion_sessions s WHERE s.id = ?`
    )
    .get(id) as Row | undefined
  return row ? rowToSession(row) : null
}

export function listSessions(companionId: string): CompanionSession[] {
  const rows = getDb()
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM companion_messages m WHERE m.session_id = s.id) AS message_count
       FROM companion_sessions s WHERE s.companion_id = ? ORDER BY s.updated_at DESC`
    )
    .all(companionId) as Row[]
  return rows.map(rowToSession)
}

export function touchSession(id: string, title?: string): void {
  if (title) {
    getDb().prepare('UPDATE companion_sessions SET updated_at = ?, title = ? WHERE id = ?').run(Date.now(), title.slice(0, 120), id)
  } else {
    getDb().prepare('UPDATE companion_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM companion_sessions WHERE id = ?').run(id)
}
