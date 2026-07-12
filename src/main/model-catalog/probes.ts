import {
  MODEL_CAPABILITIES,
  MODEL_SOURCES,
  type ModelCapability,
  type ModelCapabilityProbeRecord,
  type ProbeCapabilityObservation,
  type ProbeFreshness
} from './types'

const capabilities = new Set<string>(MODEL_CAPABILITIES)
const sources = new Set<string>(MODEL_SOURCES)
const statuses = new Set(['running', 'succeeded', 'failed', 'unavailable', 'cancelled', 'error'])
const probeKinds = new Set(['code_execution', 'reasoning'])
const observationOutcomes = new Set(['confirmed', 'rejected', 'not_tested'])
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+%\-]*$/

export type ProbeRecordValidation =
  | { ok: true; record: ModelCapabilityProbeRecord }
  | { ok: false; errors: string[] }

function text(value: unknown, max: number, id = false): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim()
  if (!clean || clean.length > max || /[\0\r\n]/.test(clean) || (id && !ID_RE.test(clean))) return null
  return clean
}

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function nullableTimestamp(value: unknown): number | null | undefined {
  if (value === null) return null
  const parsed = timestamp(value)
  return parsed === null ? undefined : parsed
}

function parseCapabilities(value: unknown, errors: string[]): Partial<Record<ModelCapability, ProbeCapabilityObservation>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('capabilities must be an object')
    return {}
  }
  const out: Partial<Record<ModelCapability, ProbeCapabilityObservation>> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!capabilities.has(key)) {
      errors.push(`unknown capability: ${key}`)
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`capability ${key} must be an observation object`)
      continue
    }
    const observation = raw as Record<string, unknown>
    if (typeof observation.outcome !== 'string' || !observationOutcomes.has(observation.outcome)) {
      errors.push(`capability ${key} has an invalid outcome`)
      continue
    }
    const summary = observation.summary === undefined ? undefined : text(observation.summary, 300)
    if (observation.summary !== undefined && summary === null) {
      errors.push(`capability ${key} has an invalid summary`)
      continue
    }
    out[key as ModelCapability] = {
      outcome: observation.outcome as ProbeCapabilityObservation['outcome'],
      ...(summary ? { summary } : {})
    }
  }
  return out
}

/** Runtime validation for records loaded from SQLite or a remote probe worker. */
export function validateProbeRecord(value: unknown): ProbeRecordValidation {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['probe must be an object'] }
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  const id = text(raw.id, 160, true)
  const catalogModelId = text(raw.catalogModelId, 640, true)
  const probeVersion = text(raw.probeVersion, 80, true)
  const providerId = text(raw.providerId, 160, true)
  const modelName = text(raw.modelName, 240)
  const nodeId = raw.nodeId === null ? null : text(raw.nodeId, 160, true)
  const failureCode = raw.failureCode === undefined ? undefined : text(raw.failureCode, 120, true)
  const failureMessage = raw.failureMessage === undefined ? undefined : text(raw.failureMessage, 500)
  const startedAt = timestamp(raw.startedAt)
  const completedAt = nullableTimestamp(raw.completedAt)
  const freshUntil = nullableTimestamp(raw.freshUntil)
  const durationMs = raw.durationMs === undefined
    ? undefined
    : typeof raw.durationMs === 'number' && Number.isSafeInteger(raw.durationMs) && raw.durationMs >= 0
      ? raw.durationMs
      : null
  if (!id) errors.push('id is invalid')
  if (!catalogModelId) errors.push('catalogModelId is invalid')
  if (!probeVersion) errors.push('probeVersion is invalid')
  if (!providerId) errors.push('providerId is invalid')
  if (!modelName) errors.push('modelName is invalid')
  if (raw.nodeId !== null && !nodeId) errors.push('nodeId is invalid')
  if (typeof raw.source !== 'string' || !sources.has(raw.source)) errors.push('source is invalid')
  if (typeof raw.status !== 'string' || !statuses.has(raw.status)) errors.push('status is invalid')
  if (typeof raw.probeKind !== 'string' || !probeKinds.has(raw.probeKind)) errors.push('probeKind is invalid')
  if (startedAt === null) errors.push('startedAt is invalid')
  if (completedAt === undefined) errors.push('completedAt is invalid')
  if (freshUntil === undefined) errors.push('freshUntil is invalid')
  if (durationMs === null) errors.push('durationMs is invalid')
  if (raw.failureCode !== undefined && !failureCode) errors.push('failureCode is invalid')
  if (raw.failureMessage !== undefined && !failureMessage) errors.push('failureMessage is invalid')
  const parsedCapabilities = parseCapabilities(raw.capabilities, errors)

  const status = typeof raw.status === 'string' && statuses.has(raw.status) ? raw.status : null
  if (status === 'running') {
    if (completedAt !== null && completedAt !== undefined) errors.push('running probe must not have completedAt')
    if (freshUntil !== null && freshUntil !== undefined) errors.push('running probe must not have freshUntil')
  } else if (status) {
    if (completedAt === null) errors.push('finished probe requires completedAt')
    if (startedAt !== null && typeof completedAt === 'number' && completedAt < startedAt) errors.push('completedAt precedes startedAt')
  }
  if (status === 'succeeded') {
    if (freshUntil === null) errors.push('successful probe requires freshUntil')
    if (typeof completedAt === 'number' && typeof freshUntil === 'number' && freshUntil < completedAt) errors.push('freshUntil precedes completedAt')
  } else if (status && status !== 'running' && freshUntil !== null && freshUntil !== undefined) {
    errors.push('unsuccessful probe must not claim freshness')
  }
  if (raw.source === 'remote' && nodeId === null) errors.push('remote probe requires nodeId')
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    record: {
      schemaVersion: 1,
      id: id!,
      catalogModelId: catalogModelId!,
      probeKind: raw.probeKind as ModelCapabilityProbeRecord['probeKind'],
      probeVersion: probeVersion!,
      status: status as ModelCapabilityProbeRecord['status'],
      startedAt: startedAt!,
      completedAt: completedAt!,
      freshUntil: freshUntil!,
      providerId: providerId!,
      modelName: modelName!,
      source: raw.source as ModelCapabilityProbeRecord['source'],
      nodeId,
      capabilities: parsedCapabilities,
      ...(failureCode ? { failureCode } : {}),
      ...(failureMessage ? { failureMessage } : {}),
      ...(typeof durationMs === 'number' ? { durationMs } : {})
    }
  }
}

export function probeFreshness(record: ModelCapabilityProbeRecord, now = Date.now()): ProbeFreshness {
  if (!Number.isSafeInteger(now) || now < 0) return { state: 'invalid', ageMs: null }
  if (record.status === 'running' || record.completedAt === null) return { state: 'incomplete', ageMs: null }
  const ageMs = now - record.completedAt
  if (ageMs < -5 * 60_000) return { state: 'future', ageMs }
  if (record.status !== 'succeeded' || record.freshUntil === null || record.freshUntil < record.completedAt) {
    return { state: 'invalid', ageMs }
  }
  return { state: now <= record.freshUntil ? 'fresh' : 'stale', ageMs }
}

/** Newest terminal/running record wins; a newer failure supersedes old success. */
export function latestProbeForModel(
  records: readonly ModelCapabilityProbeRecord[],
  catalogModelId: string,
  probeKind?: ModelCapabilityProbeRecord['probeKind']
): ModelCapabilityProbeRecord | null {
  return (
    records
      .filter((record) => record.catalogModelId === catalogModelId && (probeKind === undefined || record.probeKind === probeKind))
      .sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt) || b.startedAt - a.startedAt)[0] ?? null
  )
}
