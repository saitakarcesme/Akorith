import { normalizeGpuDevice, type RawGpuDevice } from './normalization'
import type { GpuMonitorPolicy, GpuObservation, GpuSampleSource, NormalizedGpuDevice } from './types'

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/

export const DEFAULT_GPU_MONITOR_POLICY: Readonly<GpuMonitorPolicy> = Object.freeze({
  pollIntervalMs: 5_000,
  sourceTimeoutMs: 4_000,
  initialBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  backoffMultiplier: 2,
  maintenanceIntervalMs: 15 * 60_000
})

function integerInRange(label: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

export function normalizeGpuMonitorPolicy(input: Partial<GpuMonitorPolicy> = {}): GpuMonitorPolicy {
  const policy = { ...DEFAULT_GPU_MONITOR_POLICY, ...input }
  integerInRange('GPU poll interval', policy.pollIntervalMs, 250, 10 * 60_000)
  integerInRange('GPU source timeout', policy.sourceTimeoutMs, 100, 2 * 60_000)
  integerInRange('GPU initial backoff', policy.initialBackoffMs, 100, 10 * 60_000)
  integerInRange('GPU maximum backoff', policy.maxBackoffMs, policy.initialBackoffMs, 24 * 60 * 60_000)
  integerInRange('GPU maintenance interval', policy.maintenanceIntervalMs, 60_000, 24 * 60 * 60_000)
  if (!Number.isFinite(policy.backoffMultiplier) || policy.backoffMultiplier < 1 || policy.backoffMultiplier > 10) {
    throw new Error('GPU backoff multiplier must be between 1 and 10')
  }
  return policy
}

export function validateGpuSourceIdentity(source: GpuSampleSource): void {
  if (!SOURCE_ID_PATTERN.test(source.id)) throw new Error('GPU source id is invalid')
  if (!SOURCE_ID_PATTERN.test(source.nodeId)) throw new Error(`GPU source ${source.id} has an invalid node id`)
  if (source.location !== 'local' && source.location !== 'remote') throw new Error(`GPU source ${source.id} has an invalid location`)
}

function boundedReason(value: unknown, max = 500): string | undefined {
  if (typeof value !== 'string') return undefined
  const reason = value.replace(/[\0\r\n]+/g, ' ').trim()
  return reason && reason.length <= max ? reason : undefined
}

export type GpuObservationValidation =
  | { ok: true; value: GpuObservation }
  | { ok: false; error: string }

export function validateGpuObservation(input: unknown): GpuObservationValidation {
  if (!input || typeof input !== 'object') return { ok: false, error: 'GPU observation must be an object.' }
  const raw = input as Record<string, unknown>
  if (!Number.isSafeInteger(raw.observedAt) || (raw.observedAt as number) < 0) {
    return { ok: false, error: 'GPU observation timestamp is invalid.' }
  }
  if (!Array.isArray(raw.warnings) || raw.warnings.length > 64) {
    return { ok: false, error: 'GPU observation warnings are invalid.' }
  }
  const warnings: string[] = []
  for (const warning of raw.warnings) {
    const clean = boundedReason(warning)
    if (!clean) return { ok: false, error: 'GPU observation contains an invalid warning.' }
    warnings.push(clean)
  }
  if (raw.status === 'observed') {
    if (!Array.isArray(raw.devices) || raw.devices.length === 0 || raw.devices.length > 32) {
      return { ok: false, error: 'Observed GPU telemetry requires one to 32 devices.' }
    }
    const devices: NormalizedGpuDevice[] = []
    for (const rawDevice of raw.devices) {
      if (!rawDevice || typeof rawDevice !== 'object') return { ok: false, error: 'GPU device observation is invalid.' }
      const normalized = normalizeGpuDevice(rawDevice as RawGpuDevice)
      if (!normalized.ok) return { ok: false, error: normalized.reason }
      devices.push(normalized.device)
    }
    return { ok: true, value: { status: 'observed', observedAt: raw.observedAt as number, devices, warnings } }
  }
  if (raw.status !== 'unsupported' && raw.status !== 'disconnected' && raw.status !== 'unavailable') {
    return { ok: false, error: 'GPU observation status is invalid.' }
  }
  if (!Array.isArray(raw.devices) || raw.devices.length !== 0) {
    return { ok: false, error: `${raw.status} GPU telemetry cannot include device measurements.` }
  }
  const reason = boundedReason(raw.reason)
  if (!reason) return { ok: false, error: `${raw.status} GPU telemetry requires an honest reason.` }
  return {
    ok: true,
    value: { status: raw.status, observedAt: raw.observedAt as number, devices: [], reason, warnings }
  }
}
