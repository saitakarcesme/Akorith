import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { TelemetryStore } from '../telemetry/store'
import {
  type AutonomousLoopRecord,
  type AutonomousLoopStage,
  type AutonomousLoopStatus,
  type LoopActivityEvent,
  type LoopCommandEvidence,
  type LoopCycleRecord,
  type LoopRepositoryLease,
  type LoopReviewResult,
  type LoopTokenUsage,
  type LoopValidationResult,
  type ProjectFeatureInventory,
  type RepositorySnapshot
} from './types'

type Row = Record<string, unknown>

const EMPTY_USAGE: LoopTokenUsage = { input: 0, output: 0, cached: 0, costUsd: 0 }

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function loopFromRow(row: Row): AutonomousLoopRecord {
  return {
    id: String(row.id),
    projectName: String(row.project_name),
    status: String(row.status) as AutonomousLoopStatus,
    stage: String(row.stage) as AutonomousLoopStage,
    repositoryId: String(row.repository_id),
    workspacePath: String(row.workspace_path),
    remoteUrl: String(row.remote_url),
    branch: String(row.branch),
    executor: json(row.executor_json, {
      catalogId: '', providerId: '', model: '', location: 'local', capabilityProbeId: ''
    } as AutonomousLoopRecord['executor']),
    planner: json(row.planner_json, {
      catalogId: '', providerId: '', model: '', location: 'local'
    } as AutonomousLoopRecord['planner']),
    limits: json(row.limits_json, {
      maxRepairAttempts: 3,
      maxConsecutiveInfrastructureFailures: 5,
      tokenLimit: null,
      costLimitUsd: null,
      validationTimeoutMs: 600_000
    }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: nullableNumber(row.started_at),
    pausedAt: nullableNumber(row.paused_at),
    stoppedAt: nullableNumber(row.stopped_at),
    completedAt: nullableNumber(row.completed_at),
    lastActivityAt: nullableNumber(row.last_activity_at),
    nextCycleAt: nullableNumber(row.next_cycle_at),
    activeCycleId: nullableString(row.active_cycle_id),
    consecutiveInfrastructureFailures: Number(row.consecutive_infrastructure_failures),
    tokenUsage: json(row.token_usage_json, EMPTY_USAGE),
    commitCount: Number(row.commit_count),
    pushCount: Number(row.push_count),
    successfulTasks: Number(row.successful_tasks),
    failedTasks: Number(row.failed_tasks),
    stopReason: nullableString(row.stop_reason),
    error: nullableString(row.error)
  }
}

function cycleFromRow(row: Row): LoopCycleRecord {
  return {
    id: String(row.id),
    loopId: String(row.loop_id),
    index: Number(row.cycle_index),
    status: String(row.status) as LoopCycleRecord['status'],
    stage: String(row.stage) as AutonomousLoopStage,
    plannedTask: row.planned_task_json ? json(row.planned_task_json, null) : null,
    executorCatalogId: String(row.executor_catalog_id),
    executorProviderId: String(row.executor_provider_id),
    executorModel: String(row.executor_model),
    plannerCatalogId: String(row.planner_catalog_id),
    plannerProviderId: String(row.planner_provider_id),
    plannerModel: String(row.planner_model),
    reviewerCatalogId: nullableString(row.reviewer_catalog_id),
    reviewerProviderId: nullableString(row.reviewer_provider_id),
    reviewerModel: nullableString(row.reviewer_model),
    repairAttempts: Number(row.repair_attempts),
    startedAt: nullableNumber(row.started_at),
    finishedAt: nullableNumber(row.finished_at),
    durationMs: nullableNumber(row.duration_ms),
    validation: row.validation_json ? json<LoopValidationResult | null>(row.validation_json, null) : null,
    review: row.review_json ? json<LoopReviewResult | null>(row.review_json, null) : null,
    changedFiles: json(row.changed_files_json, []),
    commitSha: nullableString(row.commit_sha),
    commitMessage: nullableString(row.commit_message),
    pushed: Number(row.pushed) === 1,
    tokenUsage: json(row.token_usage_json, EMPTY_USAGE),
    summary: nullableString(row.summary),
    error: nullableString(row.error)
  }
}

export interface LoopModelCallInput {
  loopId: string
  cycleId?: string | null
  occurredAt?: number
  role: 'planner' | 'executor' | 'repair' | 'reviewer'
  attemptIndex?: number
  providerId: string
  model: string
  catalogId: string
  location: 'local' | 'remote' | 'cloud'
  nodeId?: string
  durationMs: number
  tokenUsage: LoopTokenUsage
  estimated: boolean
  outcome: 'completed' | 'failed' | 'cancelled'
  errorCode?: string
}

export class AutonomousLoopStore {
  constructor(private readonly database: Database.Database) {}

  createLoop(record: AutonomousLoopRecord): AutonomousLoopRecord {
    this.database.prepare(`
      INSERT INTO autonomous_loops (
        id, project_name, status, stage, repository_id, workspace_path, remote_url, branch,
        executor_json, planner_json, limits_json, created_at, updated_at, started_at, paused_at,
        stopped_at, completed_at, last_activity_at, next_cycle_at, active_cycle_id,
        consecutive_infrastructure_failures, token_usage_json, commit_count, push_count,
        successful_tasks, failed_tasks, stop_reason, error
      ) VALUES (
        @id, @projectName, @status, @stage, @repositoryId, @workspacePath, @remoteUrl, @branch,
        @executorJson, @plannerJson, @limitsJson, @createdAt, @updatedAt, @startedAt, @pausedAt,
        @stoppedAt, @completedAt, @lastActivityAt, @nextCycleAt, @activeCycleId,
        @consecutiveInfrastructureFailures, @tokenUsageJson, @commitCount, @pushCount,
        @successfulTasks, @failedTasks, @stopReason, @error
      )
    `).run({
      ...record,
      executorJson: JSON.stringify(record.executor),
      plannerJson: JSON.stringify(record.planner),
      limitsJson: JSON.stringify(record.limits),
      tokenUsageJson: JSON.stringify(record.tokenUsage)
    })
    return record
  }

  getLoop(id: string): AutonomousLoopRecord | null {
    const row = this.database.prepare('SELECT * FROM autonomous_loops WHERE id = ?').get(id) as Row | undefined
    return row ? loopFromRow(row) : null
  }

  listLoops(limit = 200): AutonomousLoopRecord[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 1_000))
    return (this.database.prepare('SELECT * FROM autonomous_loops ORDER BY updated_at DESC LIMIT ?').all(bounded) as Row[])
      .map(loopFromRow)
  }

  setLoopState(
    id: string,
    patch: {
      status?: AutonomousLoopStatus
      stage?: AutonomousLoopStage
      activeCycleId?: string | null
      nextCycleAt?: number | null
      lastActivityAt?: number | null
      startedAt?: number | null
      pausedAt?: number | null
      stoppedAt?: number | null
      completedAt?: number | null
      stopReason?: string | null
      error?: string | null
      consecutiveInfrastructureFailures?: number
    }
  ): AutonomousLoopRecord | null {
    const columns: Record<keyof typeof patch, string> = {
      status: 'status', stage: 'stage', activeCycleId: 'active_cycle_id', nextCycleAt: 'next_cycle_at',
      lastActivityAt: 'last_activity_at', startedAt: 'started_at', pausedAt: 'paused_at',
      stoppedAt: 'stopped_at', completedAt: 'completed_at', stopReason: 'stop_reason', error: 'error',
      consecutiveInfrastructureFailures: 'consecutive_infrastructure_failures'
    }
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return this.getLoop(id)
    const params: Record<string, unknown> = { id, updatedAt: Date.now() }
    const assignments = entries.map(([key, value], index) => {
      const name = `value${index}`
      params[name] = value
      return `${columns[key as keyof typeof patch]} = @${name}`
    })
    this.database.prepare(
      `UPDATE autonomous_loops SET ${assignments.join(', ')}, updated_at = @updatedAt WHERE id = @id`
    ).run(params)
    return this.getLoop(id)
  }

  applyLoopCounters(
    id: string,
    delta: Partial<Pick<AutonomousLoopRecord, 'commitCount' | 'pushCount' | 'successfulTasks' | 'failedTasks'>>,
    tokenUsage?: LoopTokenUsage
  ): AutonomousLoopRecord | null {
    const current = this.getLoop(id)
    if (!current) return null
    const usage = tokenUsage
      ? {
          input: current.tokenUsage.input + tokenUsage.input,
          output: current.tokenUsage.output + tokenUsage.output,
          cached: current.tokenUsage.cached + tokenUsage.cached,
          costUsd: current.tokenUsage.costUsd + tokenUsage.costUsd
        }
      : current.tokenUsage
    this.database.prepare(`
      UPDATE autonomous_loops SET
        commit_count = commit_count + @commitCount,
        push_count = push_count + @pushCount,
        successful_tasks = successful_tasks + @successfulTasks,
        failed_tasks = failed_tasks + @failedTasks,
        token_usage_json = @tokenUsage,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id,
      commitCount: delta.commitCount ?? 0,
      pushCount: delta.pushCount ?? 0,
      successfulTasks: delta.successfulTasks ?? 0,
      failedTasks: delta.failedTasks ?? 0,
      tokenUsage: JSON.stringify(usage),
      updatedAt: Date.now()
    })
    return this.getLoop(id)
  }

  nextCycleIndex(loopId: string): number {
    const row = this.database.prepare(
      'SELECT COALESCE(MAX(cycle_index), 0) AS current FROM autonomous_loop_cycles WHERE loop_id = ?'
    ).get(loopId) as { current: number }
    return Number(row.current) + 1
  }

  createCycle(record: LoopCycleRecord): LoopCycleRecord {
    this.database.prepare(`
      INSERT INTO autonomous_loop_cycles (
        id, loop_id, cycle_index, status, stage, planned_task_json,
        executor_catalog_id, executor_provider_id, executor_model,
        planner_catalog_id, planner_provider_id, planner_model,
        reviewer_catalog_id, reviewer_provider_id, reviewer_model,
        repair_attempts, started_at, finished_at, duration_ms, validation_json, review_json,
        changed_files_json, commit_sha, commit_message, pushed, token_usage_json, summary, error
      ) VALUES (
        @id, @loopId, @cycleIndex, @status, @stage, @plannedTask,
        @executorCatalogId, @executorProviderId, @executorModel,
        @plannerCatalogId, @plannerProviderId, @plannerModel,
        @reviewerCatalogId, @reviewerProviderId, @reviewerModel,
        @repairAttempts, @startedAt, @finishedAt, @durationMs, @validation, @review,
        @changedFiles, @commitSha, @commitMessage, @pushed, @tokenUsage, @summary, @error
      )
    `).run({
      ...record,
      cycleIndex: record.index,
      plannedTask: record.plannedTask ? JSON.stringify(record.plannedTask) : null,
      validation: record.validation ? JSON.stringify(record.validation) : null,
      review: record.review ? JSON.stringify(record.review) : null,
      changedFiles: JSON.stringify(record.changedFiles),
      pushed: record.pushed ? 1 : 0,
      tokenUsage: JSON.stringify(record.tokenUsage)
    })
    return record
  }

  getCycle(id: string): LoopCycleRecord | null {
    const row = this.database.prepare('SELECT * FROM autonomous_loop_cycles WHERE id = ?').get(id) as Row | undefined
    return row ? cycleFromRow(row) : null
  }

  listCycles(loopId: string, limit = 100): LoopCycleRecord[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 1_000))
    return (this.database.prepare(
      'SELECT * FROM autonomous_loop_cycles WHERE loop_id = ? ORDER BY cycle_index DESC LIMIT ?'
    ).all(loopId, bounded) as Row[]).map(cycleFromRow)
  }

  updateCycle(record: LoopCycleRecord): LoopCycleRecord {
    this.database.prepare(`
      UPDATE autonomous_loop_cycles SET
        status=@status, stage=@stage, planned_task_json=@plannedTask,
        reviewer_catalog_id=@reviewerCatalogId, reviewer_provider_id=@reviewerProviderId,
        reviewer_model=@reviewerModel, repair_attempts=@repairAttempts, started_at=@startedAt,
        finished_at=@finishedAt, duration_ms=@durationMs, validation_json=@validation,
        review_json=@review, changed_files_json=@changedFiles, commit_sha=@commitSha,
        commit_message=@commitMessage, pushed=@pushed, token_usage_json=@tokenUsage,
        summary=@summary, error=@error
      WHERE id=@id
    `).run({
      ...record,
      plannedTask: record.plannedTask ? JSON.stringify(record.plannedTask) : null,
      validation: record.validation ? JSON.stringify(record.validation) : null,
      review: record.review ? JSON.stringify(record.review) : null,
      changedFiles: JSON.stringify(record.changedFiles),
      pushed: record.pushed ? 1 : 0,
      tokenUsage: JSON.stringify(record.tokenUsage)
    })
    return this.getCycle(record.id) ?? record
  }

  saveSnapshot(loopId: string, cycleId: string | null, snapshot: RepositorySnapshot): string {
    const id = randomUUID()
    this.database.prepare(
      'INSERT INTO autonomous_loop_snapshots (id, loop_id, cycle_id, captured_at, snapshot_json) VALUES (?, ?, ?, ?, ?)'
    ).run(id, loopId, cycleId, snapshot.capturedAt, JSON.stringify(snapshot))
    return id
  }

  latestSnapshot(loopId: string): RepositorySnapshot | null {
    const row = this.database.prepare(
      'SELECT snapshot_json FROM autonomous_loop_snapshots WHERE loop_id = ? ORDER BY captured_at DESC LIMIT 1'
    ).get(loopId) as { snapshot_json: string } | undefined
    return row ? json<RepositorySnapshot | null>(row.snapshot_json, null) : null
  }

  saveInventory(loopId: string, cycleId: string | null, inventory: ProjectFeatureInventory): string {
    const id = randomUUID()
    this.database.prepare(
      'INSERT INTO autonomous_loop_inventories (id, loop_id, cycle_id, generated_at, inventory_json) VALUES (?, ?, ?, ?, ?)'
    ).run(id, loopId, cycleId, inventory.generatedAt, JSON.stringify(inventory))
    return id
  }

  latestInventory(loopId: string): ProjectFeatureInventory | null {
    const row = this.database.prepare(
      'SELECT inventory_json FROM autonomous_loop_inventories WHERE loop_id = ? ORDER BY generated_at DESC LIMIT 1'
    ).get(loopId) as { inventory_json: string } | undefined
    return row ? json<ProjectFeatureInventory | null>(row.inventory_json, null) : null
  }

  appendEvent(input: Omit<LoopActivityEvent, 'id'> & { id?: string }): LoopActivityEvent {
    const event: LoopActivityEvent = { ...input, id: input.id ?? randomUUID() }
    this.database.prepare(`
      INSERT INTO autonomous_loop_events
        (id, loop_id, cycle_id, occurred_at, stage, level, kind, title, summary, details_json)
      VALUES (@id, @loopId, @cycleId, @occurredAt, @stage, @level, @kind, @title, @summary, @details)
    `).run({ ...event, details: JSON.stringify(event.details) })
    return event
  }

  listEvents(loopId: string, limit = 500): LoopActivityEvent[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 2_000))
    return (this.database.prepare(
      'SELECT * FROM autonomous_loop_events WHERE loop_id = ? ORDER BY occurred_at DESC LIMIT ?'
    ).all(loopId, bounded) as Row[]).map((row) => ({
      id: String(row.id), loopId: String(row.loop_id), cycleId: nullableString(row.cycle_id),
      occurredAt: Number(row.occurred_at), stage: String(row.stage) as AutonomousLoopStage,
      level: String(row.level) as LoopActivityEvent['level'], kind: String(row.kind), title: String(row.title),
      summary: String(row.summary), details: json(row.details_json, {})
    }))
  }

  recordCommand(loopId: string, cycleId: string, attemptIndex: number, commandIndex: number, evidence: LoopCommandEvidence): string {
    const id = randomUUID()
    this.database.prepare(`
      INSERT INTO autonomous_loop_commands
        (id, loop_id, cycle_id, attempt_index, command_index, kind, command, started_at,
         duration_ms, exit_code, timed_out, stdout, stderr)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, loopId, cycleId, attemptIndex, commandIndex, evidence.kind, evidence.command, evidence.startedAt,
      evidence.durationMs, evidence.exitCode, evidence.timedOut ? 1 : 0, evidence.stdout, evidence.stderr
    )
    return id
  }

  recordModelCall(input: LoopModelCallInput): string {
    const id = randomUUID()
    const occurredAt = input.occurredAt ?? Date.now()
    this.database.prepare(`
      INSERT INTO autonomous_loop_model_calls (
        id, loop_id, cycle_id, occurred_at, role, attempt_index, provider_id, model, catalog_id,
        location, node_id, duration_ms, input_tokens, output_tokens, cached_tokens, cost_usd,
        estimated, outcome, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.loopId, input.cycleId ?? null, occurredAt, input.role,
      input.attemptIndex ?? 0, input.providerId, input.model, input.catalogId, input.location,
      input.nodeId ?? null, input.durationMs, input.tokenUsage.input, input.tokenUsage.output,
      input.tokenUsage.cached, input.tokenUsage.costUsd, input.estimated ? 1 : 0, input.outcome,
      input.errorCode ?? null
    )
    const hasTelemetry = Boolean(this.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_events'"
    ).get())
    if (!hasTelemetry) return id
    const telemetry = new TelemetryStore(this.database)
    const requestId = `loop:${id}`
    const taskType = input.role === 'planner' ? 'planning' : input.role === 'reviewer' ? 'review' : 'code_edit'
    const common = {
      providerId: input.providerId,
      model: input.model,
      location: input.location,
      nodeId: input.nodeId,
      taskType,
      correlationId: input.cycleId ?? input.loopId,
      metadata: { loopRole: input.role, attemptIndex: input.attemptIndex ?? 0 }
    } as const
    try {
      telemetry.recordMany([
        { kind: 'model_request_started', requestId, occurredAt: Math.max(0, occurredAt - input.durationMs), ...common },
        input.outcome === 'completed'
          ? { kind: 'model_request_completed', requestId, occurredAt, durationMs: input.durationMs, ...common }
          : { kind: 'model_request_failed', requestId, occurredAt, durationMs: input.durationMs, errorCode: input.errorCode, ...common },
        {
          kind: 'token_usage', requestId, occurredAt, promptTokens: input.tokenUsage.input,
          completionTokens: input.tokenUsage.output, cachedTokens: input.tokenUsage.cached,
          costUsd: input.tokenUsage.costUsd, estimated: input.estimated, ...common
        }
      ])
    } catch (error) {
      console.warn('[telemetry] loop model-call mirror failed:', error instanceof Error ? error.message : String(error))
    }
    return id
  }

  acquireLease(lease: LoopRepositoryLease, now = Date.now()): boolean {
    return this.database.transaction(() => {
      this.database.prepare('DELETE FROM autonomous_loop_repository_leases WHERE expires_at <= ?').run(now)
      const existing = this.database.prepare(
        'SELECT loop_id FROM autonomous_loop_repository_leases WHERE repository_id = ?'
      ).get(lease.repositoryId) as { loop_id: string } | undefined
      if (existing && existing.loop_id !== lease.loopId) return false
      this.database.prepare(`
        INSERT INTO autonomous_loop_repository_leases
          (repository_id, loop_id, acquired_at, heartbeat_at, expires_at, process_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(repository_id) DO UPDATE SET
          heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at, process_id=excluded.process_id
      `).run(lease.repositoryId, lease.loopId, lease.acquiredAt, lease.heartbeatAt, lease.expiresAt, lease.processId)
      return true
    })()
  }

  heartbeatLease(repositoryId: string, loopId: string, heartbeatAt: number, expiresAt: number): boolean {
    const result = this.database.prepare(`
      UPDATE autonomous_loop_repository_leases SET heartbeat_at = ?, expires_at = ?
      WHERE repository_id = ? AND loop_id = ?
    `).run(heartbeatAt, expiresAt, repositoryId, loopId)
    return result.changes === 1
  }

  releaseLease(repositoryId: string, loopId: string): boolean {
    return this.database.prepare(
      'DELETE FROM autonomous_loop_repository_leases WHERE repository_id = ? AND loop_id = ?'
    ).run(repositoryId, loopId).changes === 1
  }
}
