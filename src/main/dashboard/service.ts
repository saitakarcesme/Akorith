import type Database from 'better-sqlite3'
import { getMarketplacePlugin } from '../plugin-marketplace'
import { TelemetryAggregator, type HeatmapTelemetryCell } from '../telemetry'
import type { GpuMonitorSnapshot, GpuObservation } from '../gpu-monitor'

export type DashboardHeatmapMode = 'daily' | 'weekly' | 'cumulative'

export interface DashboardTelemetryServiceOptions {
  database: Database.Database
  gpuSnapshot(): GpuMonitorSnapshot
  now?: () => number
}

interface ScalarRow {
  first_ts: number | null
  longest_duration: number | null
  completed_tasks: number
  failed_tasks: number
  total_duration: number
}

function dayAdd(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  const offset = (date.getUTCDay() + 6) % 7
  return dayAdd(day, -offset)
}

function intensity(values: readonly number[], value: number): 0 | 1 | 2 | 3 | 4 {
  const peak = Math.max(0, ...values)
  if (value <= 0 || peak <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((value / peak) * 4))) as 1 | 2 | 3 | 4
}

function heatCell(cell: HeatmapTelemetryCell): Record<string, unknown> {
  return {
    key: cell.day,
    label: cell.day,
    startDay: cell.day,
    endDay: cell.day,
    tokens: cell.totalTokens,
    tasks: cell.completedTasks + cell.failedTasks,
    primaryModel: cell.primaryModel,
    intensity: cell.intensity
  }
}

function gpuView(snapshot: GpuMonitorSnapshot): Record<string, unknown> {
  const observations = snapshot.sources
    .map((source) => ({ source, observation: source.lastObservation }))
    .filter((entry): entry is { source: (typeof snapshot.sources)[number]; observation: GpuObservation } => Boolean(entry.observation))
  const observedAt = Math.max(0, ...observations.map((entry) => entry.observation.observedAt))
  const observed = observations.filter((entry) => entry.observation.status === 'observed')
  if (observed.length > 0) {
    return {
      status: 'observed',
      observedAt,
      devices: observed.flatMap(({ source, observation }) => observation.status === 'observed'
        ? observation.devices.map((device) => ({
            ...device,
            nodeId: source.nodeId,
            nodeLabel: source.nodeId === 'local' ? 'This device' : source.nodeId,
            location: source.location
          }))
        : []),
      warnings: observed.flatMap(({ observation }) => observation.warnings)
    }
  }
  const last = observations.sort((left, right) => right.observation.observedAt - left.observation.observedAt)[0]
  return {
    status: last?.observation.status ?? 'unavailable',
    observedAt: last?.observation.observedAt ?? Date.now(),
    reason: last?.observation.status === 'observed' ? undefined : last?.observation.reason ?? 'GPU telemetry has not completed its first poll.',
    devices: [],
    warnings: last?.observation.warnings ?? []
  }
}

export class DashboardTelemetryService {
  private readonly database: Database.Database
  private readonly aggregator: TelemetryAggregator
  private readonly getGpu: () => GpuMonitorSnapshot
  private readonly now: () => number

  constructor(options: DashboardTelemetryServiceOptions) {
    this.database = options.database
    this.aggregator = new TelemetryAggregator(options.database)
    this.getGpu = options.gpuSnapshot
    this.now = options.now ?? Date.now
  }

  overview(): Record<string, unknown> {
    const daily = this.aggregator.daily()
    const streaks = this.aggregator.streaks(this.now())
    const scalar = this.database.prepare(
      `SELECT MIN(ts) AS first_ts,
              MAX(CASE WHEN kind = 'model_request_completed' THEN duration_ms END) AS longest_duration,
              SUM(CASE WHEN kind = 'model_request_completed' THEN 1 ELSE 0 END) AS completed_tasks,
              SUM(CASE WHEN kind = 'model_request_failed' THEN 1 ELSE 0 END) AS failed_tasks,
              SUM(CASE WHEN kind IN ('model_request_completed', 'model_request_failed') THEN COALESCE(duration_ms, 0) ELSE 0 END) AS total_duration
         FROM telemetry_events`
    ).get() as ScalarRow
    const reasoning = this.database.prepare(
      `SELECT reasoning_mode AS mode, COUNT(*) AS uses
         FROM telemetry_events
        WHERE kind = 'model_request_completed' AND reasoning_mode IS NOT NULL AND reasoning_mode NOT IN ('none', 'unknown')
        GROUP BY reasoning_mode ORDER BY uses DESC, mode LIMIT 1`
    ).get() as { mode?: string; uses?: number } | undefined
    let skillInvocations = 0
    let skillsExplored = 0
    let fastRuns = 0
    const completedTasks = Number(scalar.completed_tasks) || 0
    try {
      const skill = this.database.prepare(
        `SELECT COUNT(*) AS invocations, COUNT(DISTINCT json_extract(metadata_json, '$.skillId')) AS explored
           FROM telemetry_events WHERE json_type(metadata_json, '$.skillId') = 'text'`
      ).get() as { invocations: number; explored: number }
      const fast = this.database.prepare(
        `SELECT COUNT(*) AS runs FROM telemetry_events
          WHERE kind = 'model_request_completed' AND json_extract(metadata_json, '$.fastMode') = 1`
      ).get() as { runs: number }
      skillInvocations = Number(skill.invocations) || 0
      skillsExplored = Number(skill.explored) || 0
      fastRuns = Number(fast.runs) || 0
    } catch {
      // Old SQLite builds without JSON1 retain all other measured telemetry.
    }
    const models = this.aggregator.byModel()
    const plugins = this.aggregator.byPlugin()
    const tasks = this.aggregator.byTask()
    return {
      summary: {
        lifetimeTokens: daily.reduce((sum, day) => sum + day.totalTokens, 0),
        peakDailyTokens: Math.max(0, ...daily.map((day) => day.totalTokens)),
        longestTaskDurationMs: scalar.longest_duration === null ? null : Number(scalar.longest_duration),
        currentStreakDays: streaks.currentStreak,
        longestStreakDays: streaks.longestStreak,
        recordedSince: scalar.first_ts === null ? null : Number(scalar.first_ts)
      },
      activity: {
        fastModeUsagePercent: completedTasks > 0 ? (fastRuns / completedTasks) * 100 : null,
        mostUsedReasoningMode: reasoning?.mode ?? null,
        skillsExplored,
        totalSkillInvocations: skillInvocations,
        totalTasks: completedTasks + (Number(scalar.failed_tasks) || 0),
        successfulTasks: completedTasks,
        failedTasks: Number(scalar.failed_tasks) || 0,
        averageTaskDurationMs: completedTasks + (Number(scalar.failed_tasks) || 0) > 0
          ? (Number(scalar.total_duration) || 0) / (completedTasks + (Number(scalar.failed_tasks) || 0))
          : null
      },
      models: models.map((model) => ({ ...model, nodeLabel: model.nodeId === 'local' ? 'This device' : model.nodeId })),
      plugins: plugins.map((plugin) => ({
        ...plugin,
        label: getMarketplacePlugin(plugin.pluginId)?.name ?? plugin.pluginId,
        icon: getMarketplacePlugin(plugin.pluginId)?.icon.value ?? null
      })),
      tasks
    }
  }

  heatmap(mode: DashboardHeatmapMode): Record<string, unknown> {
    if (!['daily', 'weekly', 'cumulative'].includes(mode)) throw new Error('Unknown dashboard heatmap mode.')
    const daily = this.aggregator.heatmap(365, this.now())
    const startDay = daily[0]?.day ?? ''
    const endDay = daily.at(-1)?.day ?? ''
    if (mode === 'daily') return { mode, startDay, endDay, cells: daily.map(heatCell) }
    if (mode === 'cumulative') {
      let tokens = 0
      let tasks = 0
      const cumulative = daily.map((cell) => {
        tokens += cell.totalTokens
        tasks += cell.completedTasks + cell.failedTasks
        return { cell, tokens, tasks }
      })
      const values = cumulative.map((item) => item.tokens)
      return {
        mode,
        startDay,
        endDay,
        cells: cumulative.map(({ cell, tokens: total, tasks: taskCount }) => ({
          key: cell.day,
          label: `Through ${cell.day}`,
          startDay,
          endDay: cell.day,
          tokens: total,
          tasks: taskCount,
          primaryModel: cell.primaryModel,
          intensity: intensity(values, total)
        }))
      }
    }
    const groups = new Map<string, { endDay: string; tokens: number; tasks: number; models: Map<string, number> }>()
    for (const cell of daily) {
      const start = weekStart(cell.day)
      const group = groups.get(start) ?? { endDay: cell.day, tokens: 0, tasks: 0, models: new Map<string, number>() }
      group.endDay = cell.day
      group.tokens += cell.totalTokens
      group.tasks += cell.completedTasks + cell.failedTasks
      if (cell.primaryModel) group.models.set(cell.primaryModel, (group.models.get(cell.primaryModel) ?? 0) + 1)
      groups.set(start, group)
    }
    const weekly = [...groups.entries()]
    const values = weekly.map(([, group]) => group.tokens)
    return {
      mode,
      startDay,
      endDay,
      cells: weekly.map(([start, group]) => ({
        key: start,
        label: `Week of ${start}`,
        startDay: start,
        endDay: group.endDay,
        tokens: group.tokens,
        tasks: group.tasks,
        primaryModel: [...group.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        intensity: intensity(values, group.tokens)
      }))
    }
  }

  gpu(): Record<string, unknown> {
    return gpuView(this.getGpu())
  }
}
