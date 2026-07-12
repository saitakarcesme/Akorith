import type Database from 'better-sqlite3'
import {
  TELEMETRY_TASK_TYPES,
  type DailyTelemetryAggregate,
  type HeatmapTelemetryCell,
  type ModelTelemetryAggregate,
  type PluginTelemetryAggregate,
  type StreakTelemetryAggregate,
  type TaskTelemetryAggregate,
  type TelemetryExecutionLocation,
  type TelemetryTaskType
} from './types'

interface DailyRow {
  day: string
  completed_tasks: number
  failed_tasks: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  total_duration_ms: number
}

interface PrimaryModelRow {
  day: string
  model: string
  uses: number
}

export interface TelemetryTimeRange {
  since?: number
  until?: number
}

function assertRange(range: TelemetryTimeRange): void {
  for (const [label, value] of Object.entries(range)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${label} is invalid`)
  }
  if (range.since !== undefined && range.until !== undefined && range.since > range.until) {
    throw new Error('telemetry range start must not be after its end')
  }
}

function rangeSql(range: TelemetryTimeRange): { clause: string; params: Record<string, number> } {
  assertRange(range)
  const conditions: string[] = []
  const params: Record<string, number> = {}
  if (range.since !== undefined) {
    conditions.push('ts >= @since')
    params.since = range.since
  }
  if (range.until !== undefined) {
    conditions.push('ts <= @until')
    params.until = range.until
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params }
}

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localDayStart(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function addLocalDays(timestamp: number, days: number): number {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

function dayOrdinal(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const value = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(value) ? Math.floor(value / 86_400_000) : null
}

/** Strict current streak: if the as-of day has no completed task it is zero. */
export function calculateStreaks(activeDays: readonly string[], asOfDay: string): StreakTelemetryAggregate {
  const ordinals = [...new Set(activeDays.map(dayOrdinal).filter((value): value is number => value !== null))].sort((a, b) => a - b)
  if (ordinals.length === 0) return { currentStreak: 0, longestStreak: 0 }
  let longestStreak = 1
  let run = 1
  for (let index = 1; index < ordinals.length; index += 1) {
    run = ordinals[index] === ordinals[index - 1] + 1 ? run + 1 : 1
    longestStreak = Math.max(longestStreak, run)
  }
  const asOf = dayOrdinal(asOfDay)
  if (asOf === null || !ordinals.includes(asOf)) return { currentStreak: 0, longestStreak }
  const set = new Set(ordinals)
  let currentStreak = 0
  for (let cursor = asOf; set.has(cursor); cursor -= 1) currentStreak += 1
  return { currentStreak, longestStreak }
}

export class TelemetryAggregator {
  constructor(private readonly database: Database.Database) {}

  daily(range: TelemetryTimeRange = {}): DailyTelemetryAggregate[] {
    const { clause, params } = rangeSql(range)
    const rows = this.database
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
                SUM(CASE WHEN kind = 'model_request_completed' THEN 1 ELSE 0 END) AS completed_tasks,
                SUM(CASE WHEN kind = 'model_request_failed' THEN 1 ELSE 0 END) AS failed_tasks,
                SUM(CASE WHEN kind = 'token_usage' THEN prompt_tokens ELSE 0 END) AS input_tokens,
                SUM(CASE WHEN kind = 'token_usage' THEN completion_tokens ELSE 0 END) AS output_tokens,
                SUM(CASE WHEN kind = 'token_usage' THEN cached_tokens ELSE 0 END) AS cached_tokens,
                SUM(CASE WHEN kind IN ('model_request_completed', 'model_request_failed')
                         THEN COALESCE(duration_ms, 0) ELSE 0 END) AS total_duration_ms
           FROM telemetry_events
           ${clause}
          GROUP BY day
          ORDER BY day`
      )
      .all(params) as DailyRow[]
    const modelWhere = clause ? `${clause} AND kind = 'model_request_completed' AND model IS NOT NULL` : "WHERE kind = 'model_request_completed' AND model IS NOT NULL"
    const modelRows = this.database
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, model, COUNT(*) AS uses
           FROM telemetry_events
           ${modelWhere}
          GROUP BY day, model
          ORDER BY day, uses DESC, model COLLATE NOCASE`
      )
      .all(params) as PrimaryModelRow[]
    const primaryModels = new Map<string, string>()
    for (const row of modelRows) if (!primaryModels.has(row.day)) primaryModels.set(row.day, row.model)
    return rows.map((row) => {
      const inputTokens = Number(row.input_tokens) || 0
      const outputTokens = Number(row.output_tokens) || 0
      const cachedTokens = Number(row.cached_tokens) || 0
      return {
        day: row.day,
        completedTasks: Number(row.completed_tasks) || 0,
        failedTasks: Number(row.failed_tasks) || 0,
        inputTokens,
        outputTokens,
        cachedTokens,
        totalTokens: inputTokens + outputTokens,
        totalDurationMs: Number(row.total_duration_ms) || 0,
        primaryModel: primaryModels.get(row.day) ?? null
      }
    })
  }

  byModel(range: TelemetryTimeRange = {}): ModelTelemetryAggregate[] {
    const { clause, params } = rangeSql(range)
    const where = clause ? `${clause} AND model IS NOT NULL` : 'WHERE model IS NOT NULL'
    const rows = this.database
      .prepare(
        `SELECT provider_id, model, execution_location, node_id,
                SUM(CASE WHEN kind IN ('model_request_completed', 'model_request_failed') THEN 1 ELSE 0 END) AS runs,
                SUM(CASE WHEN kind = 'model_request_completed' THEN 1 ELSE 0 END) AS successful_runs,
                SUM(CASE WHEN kind = 'model_request_failed' THEN 1 ELSE 0 END) AS failed_runs,
                SUM(CASE WHEN kind = 'token_usage' THEN prompt_tokens ELSE 0 END) AS input_tokens,
                SUM(CASE WHEN kind = 'token_usage' THEN completion_tokens ELSE 0 END) AS output_tokens,
                SUM(CASE WHEN kind = 'token_usage' THEN cached_tokens ELSE 0 END) AS cached_tokens,
                SUM(CASE WHEN kind IN ('model_request_completed', 'model_request_failed')
                         THEN COALESCE(duration_ms, 0) ELSE 0 END) AS total_duration_ms
           FROM telemetry_events
           ${where}
          GROUP BY provider_id, model, execution_location, node_id
          ORDER BY runs DESC, input_tokens + output_tokens DESC, model COLLATE NOCASE`
      )
      .all(params) as Record<string, unknown>[]
    return rows.map((row) => {
      const inputTokens = Number(row.input_tokens) || 0
      const outputTokens = Number(row.output_tokens) || 0
      const cachedTokens = Number(row.cached_tokens) || 0
      return {
        providerId: typeof row.provider_id === 'string' ? row.provider_id : null,
        model: String(row.model),
        location: (row.execution_location as TelemetryExecutionLocation | null) ?? null,
        nodeId: typeof row.node_id === 'string' ? row.node_id : null,
        runs: Number(row.runs) || 0,
        successfulRuns: Number(row.successful_runs) || 0,
        failedRuns: Number(row.failed_runs) || 0,
        inputTokens,
        outputTokens,
        cachedTokens,
        totalTokens: inputTokens + outputTokens,
        totalDurationMs: Number(row.total_duration_ms) || 0
      }
    })
  }

  byPlugin(range: TelemetryTimeRange = {}): PluginTelemetryAggregate[] {
    const { clause, params } = rangeSql(range)
    const where = clause ? `${clause} AND kind = 'plugin_invocation' AND plugin_id IS NOT NULL` : "WHERE kind = 'plugin_invocation' AND plugin_id IS NOT NULL"
    const rows = this.database
      .prepare(
        `SELECT plugin_id,
                SUM(CASE WHEN outcome <> 'started' THEN 1 ELSE 0 END) AS runs,
                SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS successful_runs,
                SUM(CASE WHEN outcome IN ('failed', 'cancelled', 'reverted') THEN 1 ELSE 0 END) AS failed_runs,
                SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
           FROM telemetry_events
           ${where}
          GROUP BY plugin_id
          ORDER BY runs DESC, plugin_id COLLATE NOCASE`
      )
      .all(params) as Record<string, unknown>[]
    return rows.map((row) => ({
      pluginId: String(row.plugin_id),
      runs: Number(row.runs) || 0,
      successfulRuns: Number(row.successful_runs) || 0,
      failedRuns: Number(row.failed_runs) || 0,
      totalDurationMs: Number(row.total_duration_ms) || 0
    }))
  }

  byTask(range: TelemetryTimeRange = {}): TaskTelemetryAggregate[] {
    const { clause, params } = rangeSql(range)
    const lifecycle = "kind IN ('model_request_completed', 'model_request_failed', 'token_usage')"
    const where = clause ? `${clause} AND ${lifecycle}` : `WHERE ${lifecycle}`
    const rows = this.database
      .prepare(
        `SELECT COALESCE(task_type, 'other') AS task_type,
                SUM(CASE WHEN kind IN ('model_request_completed', 'model_request_failed') THEN 1 ELSE 0 END) AS runs,
                SUM(CASE WHEN kind = 'model_request_completed' THEN 1 ELSE 0 END) AS successful_runs,
                SUM(CASE WHEN kind = 'model_request_failed' THEN 1 ELSE 0 END) AS failed_runs,
                SUM(CASE WHEN kind = 'token_usage' THEN prompt_tokens ELSE 0 END) AS input_tokens,
                SUM(CASE WHEN kind = 'token_usage' THEN completion_tokens ELSE 0 END) AS output_tokens,
                SUM(CASE WHEN kind = 'token_usage' THEN cached_tokens ELSE 0 END) AS cached_tokens,
                SUM(CASE WHEN kind IN ('model_request_completed', 'model_request_failed')
                         THEN COALESCE(duration_ms, 0) ELSE 0 END) AS total_duration_ms
           FROM telemetry_events
           ${where}
          GROUP BY COALESCE(task_type, 'other')
          ORDER BY runs DESC, task_type`
      )
      .all(params) as Record<string, unknown>[]
    const taskTypes = new Set<string>(TELEMETRY_TASK_TYPES)
    return rows.map((row) => {
      const taskType = taskTypes.has(String(row.task_type)) ? (String(row.task_type) as TelemetryTaskType) : 'other'
      const inputTokens = Number(row.input_tokens) || 0
      const outputTokens = Number(row.output_tokens) || 0
      const cachedTokens = Number(row.cached_tokens) || 0
      return {
        taskType,
        runs: Number(row.runs) || 0,
        successfulRuns: Number(row.successful_runs) || 0,
        failedRuns: Number(row.failed_runs) || 0,
        inputTokens,
        outputTokens,
        cachedTokens,
        totalTokens: inputTokens + outputTokens,
        totalDurationMs: Number(row.total_duration_ms) || 0
      }
    })
  }

  streaks(asOf = Date.now()): StreakTelemetryAggregate {
    if (!Number.isSafeInteger(asOf) || asOf < 0) throw new Error('asOf is invalid')
    const daily = this.daily({ until: asOf })
    return calculateStreaks(
      daily.filter((row) => row.completedTasks > 0).map((row) => row.day),
      localDayKey(asOf)
    )
  }

  heatmap(days = 365, asOf = Date.now()): HeatmapTelemetryCell[] {
    const safeDays = Math.min(Math.max(Math.trunc(days), 1), 732)
    if (!Number.isSafeInteger(asOf) || asOf < 0) throw new Error('asOf is invalid')
    const end = localDayStart(asOf)
    const start = addLocalDays(end, -(safeDays - 1))
    const rows = new Map(this.daily({ since: start, until: addLocalDays(end, 1) - 1 }).map((row) => [row.day, row]))
    const cells: DailyTelemetryAggregate[] = []
    for (let index = 0; index < safeDays; index += 1) {
      const dayTimestamp = addLocalDays(start, index)
      const day = localDayKey(dayTimestamp)
      cells.push(
        rows.get(day) ?? {
          day,
          completedTasks: 0,
          failedTasks: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: 0,
          totalDurationMs: 0,
          primaryModel: null
        }
      )
    }
    const activity = cells.map((cell) => cell.totalTokens || cell.completedTasks + cell.failedTasks)
    const peak = Math.max(0, ...activity)
    return cells.map((cell, index): HeatmapTelemetryCell => {
      const value = activity[index]
      const intensity = value <= 0 || peak <= 0 ? 0 : (Math.min(4, Math.max(1, Math.ceil((value / peak) * 4))) as 1 | 2 | 3 | 4)
      return { ...cell, intensity }
    })
  }
}
