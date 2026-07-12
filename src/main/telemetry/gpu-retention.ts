import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { TelemetryStore } from './store'
import type {
  GpuDetailSampleInput,
  GpuRetentionPolicy,
  GpuRetentionResult,
  GpuRollupRecord
} from './types'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

export const DEFAULT_GPU_RETENTION_POLICY: Readonly<GpuRetentionPolicy> = Object.freeze({
  detailRetentionMs: 48 * 60 * 60_000,
  rollupRetentionMs: 365 * DAY_MS,
  bucketMs: 15 * MINUTE_MS
})

interface GpuRollupRow {
  bucket_start: number
  bucket_ms: number
  node_id: string
  device_id: string
  device_name: string
  sample_count: number
  average_utilization_percent: number | null
  peak_utilization_percent: number | null
  average_memory_used_mb: number | null
  peak_memory_used_mb: number | null
  memory_total_mb: number | null
  average_temperature_c: number | null
  peak_temperature_c: number | null
  average_power_watts: number | null
  peak_power_watts: number | null
  first_sample_at: number
  last_sample_at: number
}

function boundedId(label: string, value: string, max = 160): string {
  const clean = value.trim()
  if (!clean || clean.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(clean)) {
    throw new Error(`${label} is invalid`)
  }
  return clean
}

function boundedText(label: string, value: string, max = 240): string {
  const clean = value.trim()
  if (!clean || clean.length > max || /[\0\r\n]/.test(clean)) throw new Error(`${label} is invalid`)
  return clean
}

function optionalText(label: string, value: string | undefined, max = 240): string | null {
  return value === undefined ? null : boundedText(label, value, max)
}

function metric(label: string, value: number | undefined, min: number, max: number): number | null {
  if (value === undefined) return null
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} is outside its supported range`)
  return value
}

function validatePolicy(input: GpuRetentionPolicy): GpuRetentionPolicy {
  const policy = {
    detailRetentionMs: Math.trunc(input.detailRetentionMs),
    rollupRetentionMs: Math.trunc(input.rollupRetentionMs),
    bucketMs: Math.trunc(input.bucketMs)
  }
  if (policy.detailRetentionMs < policy.bucketMs || policy.detailRetentionMs > 30 * DAY_MS) {
    throw new Error('GPU detail retention must be between one bucket and 30 days')
  }
  if (policy.rollupRetentionMs < policy.detailRetentionMs || policy.rollupRetentionMs > 5 * 365 * DAY_MS) {
    throw new Error('GPU rollup retention must be between detail retention and five years')
  }
  if (policy.bucketMs < MINUTE_MS || policy.bucketMs > DAY_MS) {
    throw new Error('GPU rollup bucket must be between one minute and one day')
  }
  return policy
}

function toRollup(row: GpuRollupRow): GpuRollupRecord {
  return {
    bucketStart: row.bucket_start,
    bucketMs: row.bucket_ms,
    nodeId: row.node_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    sampleCount: row.sample_count,
    averageUtilizationPercent: row.average_utilization_percent,
    peakUtilizationPercent: row.peak_utilization_percent,
    averageMemoryUsedMb: row.average_memory_used_mb,
    peakMemoryUsedMb: row.peak_memory_used_mb,
    memoryTotalMb: row.memory_total_mb,
    averageTemperatureC: row.average_temperature_c,
    peakTemperatureC: row.peak_temperature_c,
    averagePowerWatts: row.average_power_watts,
    peakPowerWatts: row.peak_power_watts,
    firstSampleAt: row.first_sample_at,
    lastSampleAt: row.last_sample_at
  }
}

export function recordGpuDetailSample(database: Database.Database, input: GpuDetailSampleInput): string {
  const occurredAt = input.occurredAt ?? Date.now()
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) throw new Error('GPU sample timestamp is invalid')
  const nodeId = boundedId('nodeId', input.nodeId)
  const deviceId = boundedId('deviceId', input.deviceId)
  const deviceName = boundedText('deviceName', input.deviceName)
  const utilization = metric('utilizationPercent', input.utilizationPercent, 0, 100)
  const memoryUsed = metric('memoryUsedMb', input.memoryUsedMb, 0, 10_000_000)
  const memoryTotal = metric('memoryTotalMb', input.memoryTotalMb, 0, 10_000_000)
  const temperature = metric('temperatureC', input.temperatureC, -100, 250)
  const power = metric('powerWatts', input.powerWatts, 0, 100_000)
  if (memoryUsed !== null && memoryTotal !== null && memoryUsed > memoryTotal) {
    throw new Error('GPU memory used cannot exceed total memory')
  }
  if ([utilization, memoryUsed, memoryTotal, temperature, power].every((value) => value === null)) {
    throw new Error('GPU sample must contain at least one measured value')
  }
  const id = randomUUID()
  database
    .prepare(
      `INSERT INTO telemetry_gpu_samples (
        id, ts, node_id, device_id, device_name, utilization_percent,
        memory_used_mb, memory_total_mb, temperature_c, power_watts, model, process_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      occurredAt,
      nodeId,
      deviceId,
      deviceName,
      utilization,
      memoryUsed,
      memoryTotal,
      temperature,
      power,
      optionalText('model', input.model),
      optionalText('processName', input.processName)
    )
  return id
}

/**
 * Roll full, expired detail buckets into compact summaries, then prune detail
 * and old rollups. A partial boundary bucket remains detailed until the next
 * pass, so a normal sample is aggregated exactly once.
 */
export function rollupAndPruneGpuSamples(
  database: Database.Database,
  now = Date.now(),
  requestedPolicy: GpuRetentionPolicy = DEFAULT_GPU_RETENTION_POLICY
): GpuRetentionResult {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('GPU retention timestamp is invalid')
  const policy = validatePolicy(requestedPolicy)
  const detailCutoff = now - policy.detailRetentionMs
  const completedBucketCutoff = Math.floor(detailCutoff / policy.bucketMs) * policy.bucketMs
  const rollupCutoff = now - policy.rollupRetentionMs
  const grouped = database
    .prepare(
      `SELECT CAST(ts / @bucket_ms AS INTEGER) * @bucket_ms AS bucket_start,
              @bucket_ms AS bucket_ms,
              node_id, device_id, MAX(device_name) AS device_name,
              COUNT(*) AS sample_count,
              AVG(utilization_percent) AS average_utilization_percent,
              MAX(utilization_percent) AS peak_utilization_percent,
              AVG(memory_used_mb) AS average_memory_used_mb,
              MAX(memory_used_mb) AS peak_memory_used_mb,
              MAX(memory_total_mb) AS memory_total_mb,
              AVG(temperature_c) AS average_temperature_c,
              MAX(temperature_c) AS peak_temperature_c,
              AVG(power_watts) AS average_power_watts,
              MAX(power_watts) AS peak_power_watts,
              MIN(ts) AS first_sample_at,
              MAX(ts) AS last_sample_at
         FROM telemetry_gpu_samples
        WHERE ts >= @rollup_cutoff AND ts < @completed_bucket_cutoff
        GROUP BY bucket_start, node_id, device_id
        ORDER BY bucket_start, node_id, device_id`
    )
    .all({
      bucket_ms: policy.bucketMs,
      rollup_cutoff: rollupCutoff,
      completed_bucket_cutoff: completedBucketCutoff
    }) as GpuRollupRow[]
  const insertRollup = database.prepare(
    `INSERT OR IGNORE INTO telemetry_gpu_rollups (
      bucket_start, bucket_ms, node_id, device_id, device_name, sample_count,
      average_utilization_percent, peak_utilization_percent,
      average_memory_used_mb, peak_memory_used_mb, memory_total_mb,
      average_temperature_c, peak_temperature_c,
      average_power_watts, peak_power_watts,
      first_sample_at, last_sample_at, created_at
    ) VALUES (
      @bucket_start, @bucket_ms, @node_id, @device_id, @device_name, @sample_count,
      @average_utilization_percent, @peak_utilization_percent,
      @average_memory_used_mb, @peak_memory_used_mb, @memory_total_mb,
      @average_temperature_c, @peak_temperature_c,
      @average_power_watts, @peak_power_watts,
      @first_sample_at, @last_sample_at, @created_at
    )`
  )
  const telemetry = new TelemetryStore(database)
  let samplesRolledUp = 0
  let aggregateEventsAdded = 0
  database.transaction(() => {
    for (const row of grouped) {
      const result = insertRollup.run({ ...row, created_at: now })
      if (result.changes === 0) continue
      samplesRolledUp += row.sample_count
      const deviceKey = createHash('sha256')
        .update(row.node_id)
        .update('\0')
        .update(row.device_id)
        .digest('hex')
        .slice(0, 32)
      const sourceKey = `gpu-rollup:${deviceKey}:${row.bucket_start}:${policy.bucketMs}`
      const existed = database.prepare('SELECT 1 FROM telemetry_events WHERE source_key = ?').get(sourceKey)
      telemetry.record({
        kind: 'gpu_sample_aggregate',
        occurredAt: row.bucket_start,
        sourceKey,
        nodeId: row.node_id,
        deviceId: row.device_id,
        location: row.node_id === 'local' ? 'local' : 'remote',
        taskType: 'other',
        bucketStart: row.bucket_start,
        bucketEnd: row.bucket_start + policy.bucketMs,
        sampleCount: row.sample_count,
        averageUtilizationPercent: row.average_utilization_percent ?? undefined,
        peakUtilizationPercent: row.peak_utilization_percent ?? undefined,
        averageVramUsedMb: row.average_memory_used_mb ?? undefined,
        peakVramUsedMb: row.peak_memory_used_mb ?? undefined,
        memoryTotalMb: row.memory_total_mb ?? undefined,
        averageTemperatureC: row.average_temperature_c ?? undefined,
        peakTemperatureC: row.peak_temperature_c ?? undefined,
        averagePowerWatts: row.average_power_watts ?? undefined,
        peakPowerWatts: row.peak_power_watts ?? undefined,
        metadata: { deviceName: row.device_name }
      })
      if (!existed) aggregateEventsAdded += 1
    }
  })()
  const detailSamplesDeleted = Number(
    database.prepare('DELETE FROM telemetry_gpu_samples WHERE ts < ?').run(completedBucketCutoff).changes
  )
  const rollupsDeleted = Number(
    database.prepare('DELETE FROM telemetry_gpu_rollups WHERE bucket_start < ?').run(rollupCutoff).changes
  )
  return { samplesRolledUp, detailSamplesDeleted, rollupsDeleted, aggregateEventsAdded }
}

export function listGpuRollups(database: Database.Database, since = 0, limit = 2_000): GpuRollupRecord[] {
  if (!Number.isSafeInteger(since) || since < 0) throw new Error('GPU rollup start is invalid')
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 10_000)
  const rows = database
    .prepare('SELECT * FROM telemetry_gpu_rollups WHERE bucket_start >= ? ORDER BY bucket_start, node_id, device_id LIMIT ?')
    .all(since, safeLimit) as GpuRollupRow[]
  return rows.map(toRollup)
}
