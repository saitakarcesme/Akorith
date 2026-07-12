import { capabilitiesConfirmedByProbe } from './capabilities'
import { probeFreshness, validateProbeRecord } from './probes'
import {
  LOOP_EXECUTOR_MANDATORY_CAPABILITIES,
  type CatalogModel,
  type ModelEligibility,
  type ModelEligibilityCode,
  type ProbeStatus
} from './types'

function unavailable(model: CatalogModel): ModelEligibility {
  return {
    selectable: false,
    code: 'model_unavailable',
    reason: model.availability.reason ?? 'The model is not currently available.',
    missingCapabilities: [],
    probeFreshness: null
  }
}
function probeFailureCode(status: ProbeStatus): ModelEligibilityCode {
  switch (status) {
    case 'running':
      return 'probe_running'
    case 'failed':
      return 'probe_failed'
    case 'unavailable':
      return 'probe_unavailable'
    case 'cancelled':
      return 'probe_cancelled'
    case 'error':
      return 'probe_error'
    default:
      return 'probe_invalid'
  }
}

export function evaluateLoopExecutorEligibility(model: CatalogModel, now = Date.now()): ModelEligibility {
  if (model.availability.status !== 'available') return unavailable(model)
  const probe = model.latestProbe
  if (!probe) {
    return {
      selectable: false,
      code: 'probe_missing',
      reason: 'A successful code-execution capability probe has not been recorded for this model.',
      missingCapabilities: [...LOOP_EXECUTOR_MANDATORY_CAPABILITIES],
      probeFreshness: null
    }
  }
  const validation = validateProbeRecord(probe)
  if (!validation.ok || probe.probeKind !== 'code_execution' || probe.catalogModelId !== model.id || probe.providerId !== model.providerId || probe.modelName !== model.modelName || probe.source !== model.source || probe.nodeId !== model.nodeId) {
    return {
      selectable: false,
      code: 'probe_invalid',
      reason: validation.ok ? 'The capability probe does not match this catalog model.' : `The capability probe is invalid: ${validation.errors[0]}`,
      missingCapabilities: [...LOOP_EXECUTOR_MANDATORY_CAPABILITIES],
      probeFreshness: { state: 'invalid', ageMs: null }
    }
  }
  if (probe.status !== 'succeeded') {
    return {
      selectable: false,
      code: probeFailureCode(probe.status),
      reason: probe.failureMessage ?? `The latest code-execution probe is ${probe.status}.`,
      missingCapabilities: [...LOOP_EXECUTOR_MANDATORY_CAPABILITIES],
      probeFreshness: probe.status === 'running' ? { state: 'incomplete', ageMs: null } : null
    }
  }
  const freshness = probeFreshness(probe, now)
  if (freshness.state !== 'fresh') {
    const code: ModelEligibilityCode =
      freshness.state === 'stale' ? 'probe_stale' : freshness.state === 'future' ? 'probe_future' : 'probe_invalid'
    return {
      selectable: false,
      code,
      reason:
        freshness.state === 'stale'
          ? 'The code-execution capability probe has expired and must be run again.'
          : freshness.state === 'future'
            ? 'The capability probe timestamp is in the future.'
            : 'The capability probe freshness window is invalid.',
      missingCapabilities: [...LOOP_EXECUTOR_MANDATORY_CAPABILITIES],
      probeFreshness: freshness
    }
  }
  const confirmation = capabilitiesConfirmedByProbe(probe, LOOP_EXECUTOR_MANDATORY_CAPABILITIES)
  if (!confirmation.confirmed) {
    return {
      selectable: false,
      code: 'mandatory_capability_missing',
      reason: `The probe did not confirm: ${confirmation.missing.join(', ')}.`,
      missingCapabilities: confirmation.missing,
      probeFreshness: freshness
    }
  }
  return {
    selectable: true,
    code: 'eligible',
    reason: 'A fresh successful code-execution probe confirmed every mandatory Loop capability.',
    missingCapabilities: [],
    probeFreshness: freshness
  }
}

export function evaluatePlannerEligibility(model: CatalogModel, now = Date.now()): ModelEligibility {
  if (model.availability.status !== 'available') return unavailable(model)
  const reasoning = model.effectiveCapabilities.reasoning
  if (reasoning.support !== 'supported') {
    return {
      selectable: false,
      code: 'reasoning_not_supported',
      reason: 'The provider adapter has not confirmed reasoning capability for this model.',
      missingCapabilities: ['reasoning'],
      probeFreshness: null
    }
  }
  if (reasoning.source === 'probe') {
    const probe = model.latestReasoningProbe
    if (!probe || probe.status !== 'succeeded') {
      return {
        selectable: false,
        code: 'probe_invalid',
        reason: 'The reasoning capability is not backed by a valid successful probe.',
        missingCapabilities: ['reasoning'],
        probeFreshness: { state: 'invalid', ageMs: null }
      }
    }
    const freshness = probeFreshness(probe, now)
    if (freshness.state !== 'fresh') {
      return {
        selectable: false,
        code: freshness.state === 'stale' ? 'probe_stale' : freshness.state === 'future' ? 'probe_future' : 'probe_invalid',
        reason: 'The reasoning capability probe is not fresh.',
        missingCapabilities: ['reasoning'],
        probeFreshness: freshness
      }
    }
    return {
      selectable: true,
      code: 'eligible',
      reason: 'A fresh probe confirmed reasoning capability.',
      missingCapabilities: [],
      probeFreshness: freshness
    }
  }
  return {
    selectable: true,
    code: 'eligible',
    reason: 'The available provider adapter declares this model reasoning-capable.',
    missingCapabilities: [],
    probeFreshness: null
  }
}
