/**
 * Shared main-process telemetry contracts.
 *
 * Telemetry is operational metadata only. Prompt text, model output, terminal
 * output, file contents, credentials, and raw command output do not belong in
 * this event stream. Callers may attach small JSON metadata after it passes the
 * bounded validator in validation.ts.
 */

export const TELEMETRY_EVENT_KINDS = [
  'model_request_started',
  'model_request_completed',
  'model_request_failed',
  'token_usage',
  'plugin_invocation',
  'loop_cycle',
  'benchmark_task',
  'git_commit',
  'git_push',
  'gpu_sample_aggregate'
] as const

export type TelemetryEventKind = (typeof TELEMETRY_EVENT_KINDS)[number]

export const TELEMETRY_EXECUTION_LOCATIONS = ['local', 'remote', 'cloud'] as const
export type TelemetryExecutionLocation = (typeof TELEMETRY_EXECUTION_LOCATIONS)[number]

export const TELEMETRY_TASK_TYPES = [
  'chat',
  'planning',
  'code_generation',
  'code_edit',
  'debugging',
  'review',
  'validation',
  'benchmark',
  'loop',
  'plugin',
  'git',
  'other'
] as const
export type TelemetryTaskType = (typeof TELEMETRY_TASK_TYPES)[number]

export const TELEMETRY_REASONING_MODES = [
  'none',
  'low',
  'medium',
  'high',
  'extra_high',
  'adaptive',
  'unknown'
] as const
export type TelemetryReasoningMode = (typeof TELEMETRY_REASONING_MODES)[number]

export type TelemetryOutcome = 'started' | 'completed' | 'failed' | 'cancelled' | 'reverted'

export type TelemetryMetadataScalar = string | number | boolean | null
export type TelemetryMetadataValue =
  | TelemetryMetadataScalar
  | TelemetryMetadataValue[]
  | { [key: string]: TelemetryMetadataValue }
export type TelemetryMetadata = Record<string, TelemetryMetadataValue>

export interface TelemetryEventCommon {
  /** Defaults to Date.now(). */
  occurredAt?: number
  /** Connects request lifecycle, token, task, and tool events. */
  correlationId?: string
  /** Optional unique source key for idempotent ingestion/backfills. */
  sourceKey?: string
  providerId?: string
  model?: string
  location?: TelemetryExecutionLocation
  nodeId?: string
  taskType?: TelemetryTaskType
  reasoningMode?: TelemetryReasoningMode
  durationMs?: number
  metadata?: TelemetryMetadata
}

export interface ModelRequestStartedEvent extends TelemetryEventCommon {
  kind: 'model_request_started'
  requestId: string
}

export interface ModelRequestCompletedEvent extends TelemetryEventCommon {
  kind: 'model_request_completed'
  requestId: string
  durationMs: number
}

export interface ModelRequestFailedEvent extends TelemetryEventCommon {
  kind: 'model_request_failed'
  requestId: string
  errorCode?: string
}

/**
 * Canonical token accounting event. Request-completion events intentionally do
 * not carry token totals, preventing derived metrics from double counting.
 */
export interface TokenUsageEvent extends TelemetryEventCommon {
  kind: 'token_usage'
  requestId?: string
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
  costUsd?: number
  estimated?: boolean
}

export interface PluginInvocationEvent extends TelemetryEventCommon {
  kind: 'plugin_invocation'
  pluginId: string
  outcome: TelemetryOutcome
}

export interface LoopCycleEvent extends TelemetryEventCommon {
  kind: 'loop_cycle'
  loopId: string
  outcome: TelemetryOutcome
  cycleIndex?: number
}

export interface BenchmarkTaskEvent extends TelemetryEventCommon {
  kind: 'benchmark_task'
  benchmarkRunId: string
  benchmarkTaskId?: string
  suiteId?: string
  suiteVersion?: string
  outcome: TelemetryOutcome
}

export interface GitCommitEvent extends TelemetryEventCommon {
  kind: 'git_commit'
  repositoryId: string
  outcome: Exclude<TelemetryOutcome, 'started'>
  commitSha?: string
}

export interface GitPushEvent extends TelemetryEventCommon {
  kind: 'git_push'
  repositoryId: string
  outcome: Exclude<TelemetryOutcome, 'started'>
  remoteName?: string
  branch?: string
}

export interface GpuSampleAggregateEvent extends TelemetryEventCommon {
  kind: 'gpu_sample_aggregate'
  nodeId: string
  deviceId: string
  bucketStart: number
  bucketEnd: number
  sampleCount: number
  averageUtilizationPercent?: number
  peakUtilizationPercent?: number
  averageVramUsedMb?: number
  peakVramUsedMb?: number
  memoryTotalMb?: number
  averageTemperatureC?: number
  peakTemperatureC?: number
  averagePowerWatts?: number
  peakPowerWatts?: number
}

export type TelemetryEventInput =
  | ModelRequestStartedEvent
  | ModelRequestCompletedEvent
  | ModelRequestFailedEvent
  | TokenUsageEvent
  | PluginInvocationEvent
  | LoopCycleEvent
  | BenchmarkTaskEvent
  | GitCommitEvent
  | GitPushEvent
  | GpuSampleAggregateEvent

export interface TelemetryEventRecord {
  id: string
  occurredAt: number
  createdAt: number
  kind: TelemetryEventKind
  outcome: TelemetryOutcome
  correlationId: string | null
  sourceKey: string | null
  providerId: string | null
  model: string | null
  location: TelemetryExecutionLocation | null
  nodeId: string | null
  taskType: TelemetryTaskType | null
  reasoningMode: TelemetryReasoningMode | null
  durationMs: number | null
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  costUsd: number
  estimated: boolean
  pluginId: string | null
  loopId: string | null
  benchmarkRunId: string | null
  repositoryId: string | null
  entityId: string | null
  metadata: TelemetryMetadata
}

export interface DailyTelemetryAggregate {
  day: string
  completedTasks: number
  failedTasks: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalTokens: number
  totalDurationMs: number
  primaryModel: string | null
}

export interface ModelTelemetryAggregate {
  providerId: string | null
  model: string
  location: TelemetryExecutionLocation | null
  nodeId: string | null
  runs: number
  successfulRuns: number
  failedRuns: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalTokens: number
  totalDurationMs: number
}

export interface PluginTelemetryAggregate {
  pluginId: string
  runs: number
  successfulRuns: number
  failedRuns: number
  totalDurationMs: number
}

export interface TaskTelemetryAggregate {
  taskType: TelemetryTaskType
  runs: number
  successfulRuns: number
  failedRuns: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalTokens: number
  totalDurationMs: number
}

export interface StreakTelemetryAggregate {
  currentStreak: number
  longestStreak: number
}

export interface HeatmapTelemetryCell extends DailyTelemetryAggregate {
  intensity: 0 | 1 | 2 | 3 | 4
}

export interface GpuDetailSampleInput {
  occurredAt?: number
  nodeId: string
  deviceId: string
  deviceName: string
  utilizationPercent?: number
  memoryUsedMb?: number
  memoryTotalMb?: number
  temperatureC?: number
  powerWatts?: number
  model?: string
  processName?: string
}

export interface GpuRetentionPolicy {
  /** Detailed samples newer than this are retained. */
  detailRetentionMs: number
  /** Aggregated buckets newer than this are retained. */
  rollupRetentionMs: number
  /** Width of each aggregate bucket. */
  bucketMs: number
}

export interface GpuRetentionResult {
  samplesRolledUp: number
  detailSamplesDeleted: number
  rollupsDeleted: number
  aggregateEventsAdded: number
}

export interface GpuRollupRecord {
  bucketStart: number
  bucketMs: number
  nodeId: string
  deviceId: string
  deviceName: string
  sampleCount: number
  averageUtilizationPercent: number | null
  peakUtilizationPercent: number | null
  averageMemoryUsedMb: number | null
  peakMemoryUsedMb: number | null
  memoryTotalMb: number | null
  averageTemperatureC: number | null
  peakTemperatureC: number | null
  averagePowerWatts: number | null
  peakPowerWatts: number | null
  firstSampleAt: number
  lastSampleAt: number
}

export interface TelemetryBackfillResult {
  source: 'usage_events'
  processed: number
  remaining: number
}
