import { randomUUID } from 'crypto'
import { getDb } from '../db'
import type { ProjectLoopCommit } from './types'

// Phase 48: the commit ledger — every commit a loop creates, with the validation
// summary that justified it.

type Row = Record<string, unknown>

function rowToCommit(r: Row): ProjectLoopCommit {
  return {
    id: String(r.id),
    loopId: String(r.loop_id),
    runId: typeof r.run_id === 'string' ? r.run_id : undefined,
    sha: String(r.sha),
    message: String(r.message),
    filesChanged: typeof r.files_changed === 'number' ? r.files_changed : 0,
    createdAt: typeof r.created_at === 'number' ? r.created_at : 0,
    validationSummary: typeof r.validation_summary === 'string' ? r.validation_summary : undefined
  }
}

export function recordCommit(input: {
  loopId: string
  runId?: string
  sha: string
  message: string
  filesChanged: number
  validationSummary?: string
}): ProjectLoopCommit {
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO project_loop_commits (id, loop_id, run_id, sha, message, files_changed, created_at, validation_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.loopId,
      input.runId ?? null,
      input.sha,
      input.message.slice(0, 500),
      input.filesChanged,
      Date.now(),
      input.validationSummary ?? null
    )
  return rowToCommit(getDb().prepare('SELECT * FROM project_loop_commits WHERE id = ?').get(id) as Row)
}

export function listCommits(loopId: string, limit = 100): ProjectLoopCommit[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_loop_commits WHERE loop_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(loopId, limit) as Row[]
  return rows.map(rowToCommit)
}
