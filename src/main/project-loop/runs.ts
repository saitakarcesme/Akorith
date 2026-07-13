import { randomUUID } from 'crypto'
import { getDb } from '../db'
import type { ProjectLoopRun, ProjectLoopRunStatus } from './types'

// Phase 48: the run ledger — one row per loop cycle.

type Row = Record<string, unknown>

function rowToRun(r: Row): ProjectLoopRun {
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  return {
    id: String(r.id),
    loopId: String(r.loop_id),
    runIndex: num(r.run_index),
    status: String(r.status) as ProjectLoopRunStatus,
    startedAt: num(r.started_at),
    endedAt: r.ended_at == null ? undefined : num(r.ended_at),
    model: str(r.model),
    objective: str(r.objective),
    summary: str(r.summary),
    filesChanged: num(r.files_changed),
    commandsRun: num(r.commands_run),
    testsRun: num(r.tests_run),
    commitsCreated: num(r.commits_created),
    validationResult: str(r.validation_result),
    nextStep: str(r.next_step),
    error: str(r.error)
  }
}

export function startRun(loopId: string, objective?: string, model?: string): ProjectLoopRun {
  const id = randomUUID()
  const nextIndex =
    (getDb().prepare('SELECT MAX(run_index) AS m FROM project_loop_runs WHERE loop_id = ?').get(loopId) as
      | { m: number | null }
      | undefined)?.m ?? 0
  getDb()
    .prepare(
      `INSERT INTO project_loop_runs (id, loop_id, run_index, status, started_at, model, objective)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`
    )
    .run(id, loopId, Number(nextIndex) + 1, Date.now(), model ?? null, objective ?? null)
  return getRun(id)!
}

export function finishRun(id: string, patch: Partial<ProjectLoopRun> & { status: ProjectLoopRunStatus }): ProjectLoopRun | null {
  getDb()
    .prepare(
      `UPDATE project_loop_runs SET
        status = @status, ended_at = @ended_at, summary = @summary,
        files_changed = @files_changed, commands_run = @commands_run, tests_run = @tests_run,
        commits_created = @commits_created, validation_result = @validation_result,
        next_step = @next_step, error = @error
       WHERE id = @id`
    )
    .run({
      id,
      status: patch.status,
      ended_at: patch.endedAt ?? Date.now(),
      summary: patch.summary ?? null,
      files_changed: patch.filesChanged ?? 0,
      commands_run: patch.commandsRun ?? 0,
      tests_run: patch.testsRun ?? 0,
      commits_created: patch.commitsCreated ?? 0,
      validation_result: patch.validationResult ?? null,
      next_step: patch.nextStep ?? null,
      error: patch.error ?? null
    })
  return getRun(id)
}

export function getRun(id: string): ProjectLoopRun | null {
  const row = getDb().prepare('SELECT * FROM project_loop_runs WHERE id = ?').get(id) as Row | undefined
  return row ? rowToRun(row) : null
}

export function listRuns(loopId: string, limit = 50): ProjectLoopRun[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_loop_runs WHERE loop_id = ? ORDER BY run_index DESC LIMIT ?')
    .all(loopId, limit) as Row[]
  return rows.map(rowToRun)
}
