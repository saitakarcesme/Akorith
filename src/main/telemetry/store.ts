import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import {
  TELEMETRY_EVENT_KINDS,
  type TelemetryEventInput,
  type TelemetryEventKind,
  type TelemetryEventRecord,
  type TelemetryMetadata,
  type TelemetryOutcome
} from './types'
import { validateTelemetryEventInput, validateTelemetryMetadata } from './validation'

interface EventRow {
  id: string
  ts: number
  created_at: number
  kind: string
  outcome: string
  correlation_id: string | null
  source_key: string | null
  provider_id: string | null
  model: string | null
  execution_location: TelemetryEventRecord['location']
  node_id: string | null
  task_type: TelemetryEventRecord['taskType']
  reasoning_mode: TelemetryEventRecord['reasoningMode']
  duration_ms: number | null
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  cost_usd: number
  estimated: number
  plugin_id: string | null
  loop_id: string | null
  benchmark_run_id: string | null
  repository_id: string | null
  entity_id: string | null
  metadata_json: string
}

interface PersistedEvent {
  id: string
  ts: number
  created_at: number
  kind: TelemetryEventKind
  outcome: TelemetryOutcome
  correlation_id: string | null
  source_key: string | null
  provider_id: string | null
  model: string | null
  execution_location: TelemetryEventRecord['location']
  node_id: string | null
  task_type: TelemetryEventRecord['taskType']
  reasoning_mode: TelemetryEventRecord['reasoningMode']
  duration_ms: number | null
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  cost_usd: number
  estimated: number
  plugin_id: string | null
  loop_id: string | null
  benchmark_run_id: string | null
  repository_id: string | null
  entity_id: string | null
  metadata_json: string
}

export interface TelemetryListFilter {
  since?: number
  until?: number
  kinds?: TelemetryEventKind[]
  correlationId?: string
  limit?: number
}

const eventKinds = new Set<string>(TELEMETRY_EVENT_KINDS)
const outcomes = new Set<TelemetryOutcome>(['started', 'completed', 'failed', 'cancelled', 'reverted'])

function addDefined(metadata: TelemetryMetadata, values: Record<string, string | number | boolean | null | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) metadata[key] = value
  }
}

function eventDetails(input: TelemetryEventInput): TelemetryMetadata {
  const metadata: TelemetryMetadata = { ...(input.metadata ?? {}) }
  switch (input.kind) {
    case 'model_request_failed':
      addDefined(metadata, { errorCode: input.errorCode })
      break
    case 'loop_cycle':
      addDefined(metadata, { cycleIndex: input.cycleIndex })
      break
    case 'benchmark_task':
      addDefined(metadata, {
        benchmarkTaskId: input.benchmarkTaskId,
        suiteId: input.suiteId,
        suiteVersion: input.suiteVersion
      })
      break
    case 'git_commit':
      addDefined(metadata, { commitSha: input.commitSha })
      break
    case 'git_push':
      addDefined(metadata, { remoteName: input.remoteName, branch: input.branch })
      break
    case 'gpu_sample_aggregate':
      addDefined(metadata, {
        deviceId: input.deviceId,
        bucketStart: input.bucketStart,
        bucketEnd: input.bucketEnd,
        sampleCount: input.sampleCount,
        averageUtilizationPercent: input.averageUtilizationPercent,
        peakUtilizationPercent: input.peakUtilizationPercent,
        averageVramUsedMb: input.averageVramUsedMb,
        peakVramUsedMb: input.peakVramUsedMb,
        memoryTotalMb: input.memoryTotalMb,
        averageTemperatureC: input.averageTemperatureC,
        peakTemperatureC: input.peakTemperatureC,
        averagePowerWatts: input.averagePowerWatts,
        peakPowerWatts: input.peakPowerWatts
      })
      break
    default:
      break
  }
  return metadata
}

function outcomeFor(input: TelemetryEventInput): TelemetryOutcome {
  switch (input.kind) {
    case 'model_request_started':
      return 'started'
    case 'model_request_completed':
    case 'token_usage':
    case 'gpu_sample_aggregate':
      return 'completed'
    case 'model_request_failed':
      return 'failed'
    default:
      return input.outcome
  }
}

function correlationFor(input: TelemetryEventInput): string | null {
  if (input.correlationId) return input.correlationId
  if (input.kind === 'model_request_started' || input.kind === 'model_request_completed' || input.kind === 'model_request_failed') {
    return input.requestId
  }
  if (input.kind === 'token_usage') return input.requestId ?? null
  return null
}

function toPersistedEvent(input: TelemetryEventInput): PersistedEvent {
  validateTelemetryEventInput(input)
  const metadata = validateTelemetryMetadata(eventDetails(input))
  if (!metadata.ok) throw new Error(metadata.error)

  let pluginId: string | null = null
  let loopId: string | null = null
  let benchmarkRunId: string | null = null
  let repositoryId: string | null = null
  let entityId: string | null = null
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0
  let costUsd = 0
  let estimated = 0

  switch (input.kind) {
    case 'token_usage':
      promptTokens = input.promptTokens
      completionTokens = input.completionTokens
      cachedTokens = input.cachedTokens ?? 0
      costUsd = input.costUsd ?? 0
      estimated = input.estimated ? 1 : 0
      entityId = input.requestId ?? null
      break
    case 'model_request_started':
    case 'model_request_completed':
    case 'model_request_failed':
      entityId = input.requestId
      break
    case 'plugin_invocation':
      pluginId = input.pluginId
      entityId = input.pluginId
      break
    case 'loop_cycle':
      loopId = input.loopId
      entityId = input.loopId
      break
    case 'benchmark_task':
      benchmarkRunId = input.benchmarkRunId
      entityId = input.benchmarkTaskId ?? input.benchmarkRunId
      break
    case 'git_commit':
    case 'git_push':
      repositoryId = input.repositoryId
      entityId = input.repositoryId
      break
    case 'gpu_sample_aggregate':
      entityId = input.deviceId
      break
  }

  return {
    id: randomUUID(),
    ts: input.occurredAt ?? Date.now(),
    created_at: Date.now(),
    kind: input.kind,
    outcome: outcomeFor(input),
    correlation_id: correlationFor(input),
    source_key: input.sourceKey ?? null,
    provider_id: input.providerId ?? null,
    model: input.model ?? null,
    execution_location: input.location ?? null,
    node_id: input.nodeId ?? null,
    task_type: input.taskType ?? null,
    reasoning_mode: input.reasoningMode ?? null,
    duration_ms: input.durationMs ?? null,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cached_tokens: cachedTokens,
    cost_usd: costUsd,
    estimated,
    plugin_id: pluginId,
    loop_id: loopId,
    benchmark_run_id: benchmarkRunId,
    repository_id: repositoryId,
    entity_id: entityId,
    metadata_json: metadata.json
  }
}

function rowToEvent(row: EventRow): TelemetryEventRecord {
  if (!eventKinds.has(row.kind)) throw new Error(`unknown telemetry event kind in database: ${row.kind}`)
  if (!outcomes.has(row.outcome as TelemetryOutcome)) throw new Error(`unknown telemetry outcome in database: ${row.outcome}`)
  let rawMetadata: unknown = {}
  try {
    rawMetadata = JSON.parse(row.metadata_json)
  } catch {
    rawMetadata = {}
  }
  const metadata = validateTelemetryMetadata(rawMetadata)
  return {
    id: row.id,
    occurredAt: row.ts,
    createdAt: row.created_at,
    kind: row.kind as TelemetryEventKind,
    outcome: row.outcome as TelemetryOutcome,
    correlationId: row.correlation_id,
    sourceKey: row.source_key,
    providerId: row.provider_id,
    model: row.model,
    location: row.execution_location,
    nodeId: row.node_id,
    taskType: row.task_type,
    reasoningMode: row.reasoning_mode,
    durationMs: row.duration_ms,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cachedTokens: row.cached_tokens,
    costUsd: row.cost_usd,
    estimated: row.estimated === 1,
    pluginId: row.plugin_id,
    loopId: row.loop_id,
    benchmarkRunId: row.benchmark_run_id,
    repositoryId: row.repository_id,
    entityId: row.entity_id,
    metadata: metadata.ok ? metadata.value : {}
  }
}

export class TelemetryStore {
  constructor(private readonly database: Database.Database) {}

  record(input: TelemetryEventInput): TelemetryEventRecord {
    const event = toPersistedEvent(input)
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO telemetry_events (
          id, ts, created_at, kind, outcome, correlation_id, source_key,
          provider_id, model, execution_location, node_id, task_type, reasoning_mode,
          duration_ms, prompt_tokens, completion_tokens, cached_tokens, cost_usd,
          estimated, plugin_id, loop_id, benchmark_run_id, repository_id, entity_id, metadata_json
        ) VALUES (
          @id, @ts, @created_at, @kind, @outcome, @correlation_id, @source_key,
          @provider_id, @model, @execution_location, @node_id, @task_type, @reasoning_mode,
          @duration_ms, @prompt_tokens, @completion_tokens, @cached_tokens, @cost_usd,
          @estimated, @plugin_id, @loop_id, @benchmark_run_id, @repository_id, @entity_id, @metadata_json
        )`
      )
      .run(event)
    const row = result.changes === 0 && event.source_key
      ? this.database.prepare('SELECT * FROM telemetry_events WHERE source_key = ?').get(event.source_key)
      : this.database.prepare('SELECT * FROM telemetry_events WHERE id = ?').get(event.id)
    if (!row) throw new Error('telemetry event could not be persisted')
    return rowToEvent(row as EventRow)
  }

  recordMany(inputs: readonly TelemetryEventInput[]): TelemetryEventRecord[] {
    return this.database.transaction(() => inputs.map((input) => this.record(input)))()
  }

  list(filter: TelemetryListFilter = {}): TelemetryEventRecord[] {
    const clauses: string[] = []
    const params: Record<string, unknown> = {}
    if (filter.since !== undefined) {
      clauses.push('ts >= @since')
      params.since = filter.since
    }
    if (filter.until !== undefined) {
      clauses.push('ts <= @until')
      params.until = filter.until
    }
    if (filter.correlationId !== undefined) {
      clauses.push('correlation_id = @correlationId')
      params.correlationId = filter.correlationId
    }
    if (filter.kinds?.length) {
      const validKinds = filter.kinds.filter((kind) => eventKinds.has(kind))
      if (validKinds.length !== filter.kinds.length) throw new Error('telemetry event filter contains an invalid kind')
      const placeholders = validKinds.map((_, index) => `@kind${index}`)
      validKinds.forEach((kind, index) => (params[`kind${index}`] = kind))
      clauses.push(`kind IN (${placeholders.join(', ')})`)
    }
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 500), 1), 5_000)
    params.limit = limit
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.database
      .prepare(`SELECT * FROM telemetry_events ${where} ORDER BY ts DESC, created_at DESC LIMIT @limit`)
      .all(params) as EventRow[]
    return rows.map(rowToEvent)
  }
}

