import { getDb } from '../db'
import { BUILTIN_COMPANIONS } from './prompts'
import type { Companion } from './types'

// Phase 50: companion records + seeding of the built-in personalities.

type Row = Record<string, unknown>

function parseTags(v: unknown): string[] {
  if (typeof v !== 'string') return []
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export function rowToCompanion(r: Row): Companion {
  return {
    id: String(r.id),
    name: String(r.name),
    tagline: String(r.tagline ?? ''),
    tags: parseTags(r.tags),
    builtin: Number(r.builtin) === 1,
    model: typeof r.model === 'string' && r.model ? r.model : undefined,
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0
  }
}

/** Insert the built-in companions if they don't already exist. Idempotent. */
export function seedBuiltinCompanions(): void {
  const now = Date.now()
  const insert = getDb().prepare(
    `INSERT OR IGNORE INTO companions (id, name, tagline, tags, builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  )
  for (const c of BUILTIN_COMPANIONS) {
    insert.run(c.id, c.name, c.tagline, JSON.stringify(c.tags), now, now)
  }
}

export function listCompanions(): Companion[] {
  seedBuiltinCompanions()
  const rows = getDb().prepare('SELECT * FROM companions ORDER BY builtin DESC, name').all() as Row[]
  return rows.map(rowToCompanion)
}

export function getCompanion(id: string): Companion | null {
  const row = getDb().prepare('SELECT * FROM companions WHERE id = ?').get(id) as Row | undefined
  return row ? rowToCompanion(row) : null
}

export function setCompanionModel(id: string, model: string | null): Companion | null {
  getDb().prepare('UPDATE companions SET model = ?, updated_at = ? WHERE id = ?').run(model, Date.now(), id)
  return getCompanion(id)
}
