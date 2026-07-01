import { randomUUID } from 'crypto'
import { getDb } from '../db'
import type { CompanionMemory, CompanionMemoryEventKind, CompanionMemoryType } from './types'

// Phase 50: durable companion memory. Simple token-overlap scoring for retrieval
// (no vector DB needed for MVP); FTS can layer on later.

type Row = Record<string, unknown>

function parseTags(v: unknown): string[] {
  if (typeof v !== 'string') return []
  try {
    const p = JSON.parse(v)
    return Array.isArray(p) ? p.map(String) : []
  } catch {
    return []
  }
}

function rowToMemory(r: Row): CompanionMemory {
  return {
    id: String(r.id),
    companionId: String(r.companion_id),
    type: String(r.type) as CompanionMemoryType,
    title: String(r.title),
    content: String(r.content),
    importance: Number(r.importance) || 3,
    confidence: typeof r.confidence === 'number' ? r.confidence : 0.6,
    sourceSessionId: typeof r.source_session_id === 'string' ? r.source_session_id : undefined,
    pinned: Number(r.pinned) === 1,
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0,
    lastUsedAt: r.last_used_at == null ? undefined : Number(r.last_used_at),
    archivedAt: r.archived_at == null ? undefined : Number(r.archived_at),
    tags: parseTags(r.tags)
  }
}

function logMemoryEvent(companionId: string, kind: CompanionMemoryEventKind, memoryId?: string, detail?: string): void {
  getDb()
    .prepare('INSERT INTO companion_memory_events (id, companion_id, memory_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), companionId, memoryId ?? null, kind, detail ?? null, Date.now())
}

export interface CreateMemoryInput {
  companionId: string
  type: CompanionMemoryType
  title: string
  content: string
  importance?: number
  confidence?: number
  sourceSessionId?: string
  tags?: string[]
}

export function createMemory(input: CreateMemoryInput): CompanionMemory {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO companion_memories (id, companion_id, type, title, content, importance, confidence, source_session_id, pinned, created_at, updated_at, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .run(
      id,
      input.companionId,
      input.type,
      input.title.slice(0, 200),
      input.content.slice(0, 2000),
      Math.max(1, Math.min(5, input.importance ?? 3)),
      Math.max(0, Math.min(1, input.confidence ?? 0.6)),
      input.sourceSessionId ?? null,
      now,
      now,
      JSON.stringify(input.tags ?? [])
    )
  logMemoryEvent(input.companionId, 'extracted', id, input.title)
  return getMemory(id)!
}

export function getMemory(id: string): CompanionMemory | null {
  const row = getDb().prepare('SELECT * FROM companion_memories WHERE id = ?').get(id) as Row | undefined
  return row ? rowToMemory(row) : null
}

export interface MemoryFilters {
  includeArchived?: boolean
  pinnedOnly?: boolean
}

export function listMemories(companionId: string, filters: MemoryFilters = {}): CompanionMemory[] {
  let sql = 'SELECT * FROM companion_memories WHERE companion_id = ?'
  if (!filters.includeArchived) sql += ' AND archived_at IS NULL'
  if (filters.pinnedOnly) sql += ' AND pinned = 1'
  sql += ' ORDER BY pinned DESC, importance DESC, updated_at DESC'
  const rows = getDb().prepare(sql).all(companionId) as Row[]
  return rows.map(rowToMemory)
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((t, i, a) => a.indexOf(t) === i)
}

/**
 * Lightweight stemming-free partial match: two tokens count as a partial hit
 * when they share a common prefix that is (a) at least 4 chars and (b) covers
 * all but the last ~2 chars of the shorter token. This lets "testing"↔"tests"
 * and "commits"↔"commit" match (shared stem) without matching merely-similar
 * words like "integrity"↔"interfaces" (common prefix "inte" is only 4 of 9).
 * Short tokens (< 4) still require exact match to avoid cross-word noise.
 */
function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

function partialMatch(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length < 4 || b.length < 4) return false
  const cp = commonPrefixLen(a, b)
  return cp >= 4 && cp >= Math.min(a.length, b.length) - 2
}

/** Score memories by token overlap with the query; boost pinned + importance. */
export function searchMemories(companionId: string, query: string, limit = 8): CompanionMemory[] {
  const memories = listMemories(companionId)
  const qTokens = new Set(tokenize(query))
  if (qTokens.size === 0) {
    return memories.filter((m) => m.pinned).slice(0, limit)
  }
  const scored = memories.map((m) => {
    const mTokens = tokenize(`${m.title} ${m.content} ${m.tags.join(' ')}`)
    let overlap = 0
    for (const t of mTokens) {
      if (qTokens.has(t)) {
        overlap += 1 // exact token match
      } else {
        // partial (shared-prefix) match, weighted lower so exact matches rank higher
        for (const q of qTokens) {
          if (partialMatch(t, q)) {
            overlap += 0.5
            break
          }
        }
      }
    }
    const score = overlap + (m.pinned ? 3 : 0) + m.importance * 0.4
    return { m, score, overlap }
  })
  return scored
    .filter((s) => s.overlap > 0 || s.m.pinned)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.m)
}

export function markMemoriesUsed(ids: string[]): void {
  if (ids.length === 0) return
  const now = Date.now()
  const stmt = getDb().prepare('UPDATE companion_memories SET last_used_at = ? WHERE id = ?')
  for (const id of ids) stmt.run(now, id)
}

export function pinMemory(id: string, pinned: boolean): CompanionMemory | null {
  getDb().prepare('UPDATE companion_memories SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned ? 1 : 0, Date.now(), id)
  const m = getMemory(id)
  if (m) logMemoryEvent(m.companionId, 'pinned', id, pinned ? 'pinned' : 'unpinned')
  return m
}

export function updateMemory(id: string, patch: { title?: string; content?: string; importance?: number; type?: CompanionMemoryType }): CompanionMemory | null {
  const existing = getMemory(id)
  if (!existing) return null
  getDb()
    .prepare('UPDATE companion_memories SET title = ?, content = ?, importance = ?, type = ?, updated_at = ? WHERE id = ?')
    .run(
      (patch.title ?? existing.title).slice(0, 200),
      (patch.content ?? existing.content).slice(0, 2000),
      Math.max(1, Math.min(5, patch.importance ?? existing.importance)),
      patch.type ?? existing.type,
      Date.now(),
      id
    )
  logMemoryEvent(existing.companionId, 'updated', id)
  return getMemory(id)
}

export function archiveMemory(id: string): CompanionMemory | null {
  getDb().prepare('UPDATE companion_memories SET archived_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), id)
  const m = getMemory(id)
  if (m) logMemoryEvent(m.companionId, 'archived', id)
  return m
}

export function forgetMemory(id: string): void {
  const m = getMemory(id)
  getDb().prepare('DELETE FROM companion_memories WHERE id = ?').run(id)
  if (m) logMemoryEvent(m.companionId, 'forgotten', id, m.title)
}

export function countMemories(companionId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM companion_memories WHERE companion_id = ? AND archived_at IS NULL')
    .get(companionId) as { c: number } | undefined
  return row?.c ?? 0
}
