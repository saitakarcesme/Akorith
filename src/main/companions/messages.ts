import { randomUUID } from 'crypto'
import { getDb } from '../db'
import type { CompanionMessage, CompanionRole } from './types'

// Phase 50: companion chat messages.

type Row = Record<string, unknown>

function rowToMessage(r: Row): CompanionMessage {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    companionId: String(r.companion_id),
    role: String(r.role) as CompanionRole,
    content: String(r.content),
    createdAt: Number(r.created_at) || 0
  }
}

export function addMessage(sessionId: string, companionId: string, role: CompanionRole, content: string): CompanionMessage {
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO companion_messages (id, session_id, companion_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, sessionId, companionId, role, content, Date.now())
  return rowToMessage(getDb().prepare('SELECT * FROM companion_messages WHERE id = ?').get(id) as Row)
}

export function listMessages(sessionId: string): CompanionMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM companion_messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as Row[]
  return rows.map(rowToMessage)
}

/** The most recent N messages (for the model's short-term context window). */
export function recentMessages(sessionId: string, limit = 12): CompanionMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM companion_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(sessionId, limit) as Row[]
  return rows.map(rowToMessage).reverse()
}
