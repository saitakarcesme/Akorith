import { randomUUID } from 'crypto'
import { getDb } from '../db'
import type { LoopMemoryKind, ProjectLoopMemory } from './types'

// Phase 48: per-loop project memory — durable decisions/facts/risks the planner
// reads so the loop stays coherent across many runs.

type Row = Record<string, unknown>

function rowToMemory(r: Row): ProjectLoopMemory {
  return {
    id: String(r.id),
    loopId: String(r.loop_id),
    kind: String(r.kind) as LoopMemoryKind,
    content: String(r.content),
    importance: typeof r.importance === 'number' ? r.importance : 1,
    createdAt: typeof r.created_at === 'number' ? r.created_at : 0,
    updatedAt: typeof r.updated_at === 'number' ? r.updated_at : 0
  }
}

export function addLoopMemory(loopId: string, kind: LoopMemoryKind, content: string, importance = 1): ProjectLoopMemory {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO project_loop_memories (id, loop_id, kind, content, importance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, loopId, kind, content.slice(0, 2000), importance, now, now)
  return rowToMemory(getDb().prepare('SELECT * FROM project_loop_memories WHERE id = ?').get(id) as Row)
}

export function listLoopMemories(loopId: string, limit = 50): ProjectLoopMemory[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_loop_memories WHERE loop_id = ? ORDER BY importance DESC, updated_at DESC LIMIT ?')
    .all(loopId, limit) as Row[]
  return rows.map(rowToMemory)
}

/** A compact memory block to prepend to planner prompts. */
export function memoryContextBlock(loopId: string, max = 12): string {
  const memories = listLoopMemories(loopId, max)
  if (memories.length === 0) return ''
  return memories.map((m) => `- [${m.kind}] ${m.content}`).join('\n')
}
