import {
  TELEMETRY_EXECUTION_LOCATIONS,
  TELEMETRY_REASONING_MODES,
  TELEMETRY_TASK_TYPES,
  type TelemetryEventInput,
  type TelemetryMetadata,
  type TelemetryMetadataValue
} from './types'

export const TELEMETRY_METADATA_LIMITS = Object.freeze({
  maxBytes: 16 * 1024,
  maxDepth: 4,
  maxObjectEntries: 64,
  maxArrayItems: 32,
  maxKeyChars: 64,
  maxStringChars: 2_048
})

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const locations = new Set<string>(TELEMETRY_EXECUTION_LOCATIONS)
const taskTypes = new Set<string>(TELEMETRY_TASK_TYPES)
const reasoningModes = new Set<string>(TELEMETRY_REASONING_MODES)

export type MetadataValidation =
  | { ok: true; value: TelemetryMetadata; json: string }
  | { ok: false; error: string }

function validateMetadataValue(value: unknown, depth: number, path: string): TelemetryMetadataValue {
  if (depth > TELEMETRY_METADATA_LIMITS.maxDepth) throw new Error(`${path} exceeds maximum depth`)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`)
    return value
  }
  if (typeof value === 'string') {
    if (value.length > TELEMETRY_METADATA_LIMITS.maxStringChars) {
      throw new Error(`${path} exceeds ${TELEMETRY_METADATA_LIMITS.maxStringChars} characters`)
    }
    if (value.includes('\0')) throw new Error(`${path} contains a null byte`)
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > TELEMETRY_METADATA_LIMITS.maxArrayItems) {
      throw new Error(`${path} exceeds ${TELEMETRY_METADATA_LIMITS.maxArrayItems} items`)
    }
    return value.map((entry, index) => validateMetadataValue(entry, depth + 1, `${path}[${index}]`))
  }
  if (typeof value !== 'object') throw new Error(`${path} contains an unsupported value`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain object`)
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > TELEMETRY_METADATA_LIMITS.maxObjectEntries) {
    throw new Error(`${path} exceeds ${TELEMETRY_METADATA_LIMITS.maxObjectEntries} entries`)
  }
  const out: Record<string, TelemetryMetadataValue> = {}
  for (const [key, entry] of entries) {
    if (!key || key.length > TELEMETRY_METADATA_LIMITS.maxKeyChars || !KEY_RE.test(key)) {
      throw new Error(`${path} contains an invalid key`)
    }
    out[key] = validateMetadataValue(entry, depth + 1, `${path}.${key}`)
  }
  return out
}

export function validateTelemetryMetadata(value: unknown): MetadataValidation {
  if (value === undefined || value === null) return { ok: true, value: {}, json: '{}' }
  try {
    const validated = validateMetadataValue(value, 0, 'metadata')
    if (!validated || Array.isArray(validated) || typeof validated !== 'object') {
      return { ok: false, error: 'metadata must be an object' }
    }
    const metadata = validated as TelemetryMetadata
    const json = JSON.stringify(metadata)
    if (Buffer.byteLength(json, 'utf8') > TELEMETRY_METADATA_LIMITS.maxBytes) {
      return { ok: false, error: `metadata exceeds ${TELEMETRY_METADATA_LIMITS.maxBytes} bytes` }
    }
    return { ok: true, value: metadata, json }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function assertBoundedId(label: string, value: string | undefined, max = 200): void {
  if (value === undefined) return
  if (!value || value.length > max || value.includes('\0') || !ID_RE.test(value)) {
    throw new Error(`${label} is invalid`)
  }
}

function assertOptionalText(label: string, value: string | undefined, max: number): void {
  if (value === undefined) return
  if (!value || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${label} is invalid`)
}

function assertTimestamp(value: number | undefined): void {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('occurredAt must be a positive integer timestamp')
}

function assertNonNegative(label: string, value: number | undefined, integer = false): void {
  if (value === undefined) return
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${label} must be a non-negative${integer ? ' integer' : ''}`)
  }
}

/** Throws before any malformed or unbounded event can reach SQLite. */
export function validateTelemetryEventInput(input: TelemetryEventInput): void {
  assertTimestamp(input.occurredAt)
  assertBoundedId('correlationId', input.correlationId, 240)
  assertBoundedId('sourceKey', input.sourceKey, 320)
  assertBoundedId('providerId', input.providerId, 80)
  assertOptionalText('model', input.model, 240)
  assertBoundedId('nodeId', input.nodeId, 160)
  assertNonNegative('durationMs', input.durationMs, true)
  if (input.location !== undefined && !locations.has(input.location)) throw new Error('location is invalid')
  if (input.taskType !== undefined && !taskTypes.has(input.taskType)) throw new Error('taskType is invalid')
  if (input.reasoningMode !== undefined && !reasoningModes.has(input.reasoningMode)) {
    throw new Error('reasoningMode is invalid')
  }
  const metadata = validateTelemetryMetadata(input.metadata)
  if (!metadata.ok) throw new Error(metadata.error)

  switch (input.kind) {
    case 'model_request_started':
      assertBoundedId('requestId', input.requestId, 240)
      break
    case 'model_request_completed':
      assertBoundedId('requestId', input.requestId, 240)
      assertNonNegative('durationMs', input.durationMs, true)
      break
    case 'model_request_failed':
      assertBoundedId('requestId', input.requestId, 240)
      assertBoundedId('errorCode', input.errorCode, 120)
      break
    case 'token_usage':
      assertBoundedId('requestId', input.requestId, 240)
      assertNonNegative('promptTokens', input.promptTokens, true)
      assertNonNegative('completionTokens', input.completionTokens, true)
      assertNonNegative('cachedTokens', input.cachedTokens, true)
      assertNonNegative('costUsd', input.costUsd)
      break
    case 'plugin_invocation':
      assertBoundedId('pluginId', input.pluginId, 160)
      break
    case 'loop_cycle':
      assertBoundedId('loopId', input.loopId, 160)
      assertNonNegative('cycleIndex', input.cycleIndex, true)
      break
    case 'benchmark_task':
      assertBoundedId('benchmarkRunId', input.benchmarkRunId, 160)
      assertBoundedId('benchmarkTaskId', input.benchmarkTaskId, 160)
      assertBoundedId('suiteId', input.suiteId, 160)
      assertOptionalText('suiteVersion', input.suiteVersion, 80)
      break
    case 'git_commit':
      assertBoundedId('repositoryId', input.repositoryId, 240)
      assertBoundedId('commitSha', input.commitSha, 80)
      break
    case 'git_push':
      assertBoundedId('repositoryId', input.repositoryId, 240)
      assertBoundedId('remoteName', input.remoteName, 120)
      assertOptionalText('branch', input.branch, 240)
      break
    case 'gpu_sample_aggregate':
      assertBoundedId('nodeId', input.nodeId, 160)
      assertBoundedId('deviceId', input.deviceId, 160)
      assertTimestamp(input.bucketStart)
      assertTimestamp(input.bucketEnd)
      if (input.bucketEnd <= input.bucketStart) throw new Error('GPU bucket end must be after its start')
      assertNonNegative('sampleCount', input.sampleCount, true)
      if (input.sampleCount < 1) throw new Error('GPU aggregate requires at least one sample')
      for (const [label, value] of Object.entries({
        averageUtilizationPercent: input.averageUtilizationPercent,
        peakUtilizationPercent: input.peakUtilizationPercent,
        averageVramUsedMb: input.averageVramUsedMb,
        peakVramUsedMb: input.peakVramUsedMb,
        memoryTotalMb: input.memoryTotalMb,
        averagePowerWatts: input.averagePowerWatts,
        peakPowerWatts: input.peakPowerWatts
      })) assertNonNegative(label, value)
      break
  }
}

