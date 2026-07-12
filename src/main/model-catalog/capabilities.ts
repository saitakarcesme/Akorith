import {
  MODEL_CAPABILITIES,
  type CapabilityAssessment,
  type CapabilityAssessmentMap,
  type CapabilityDeclaration,
  type CapabilitySupport,
  type ModelCapability,
  type ModelCapabilityProbeRecord
} from './types'

function unknownAssessment(): CapabilityAssessment {
  return { support: 'unknown', source: 'unknown', verifiedAt: null }
}

export function emptyCapabilityAssessments(): CapabilityAssessmentMap {
  return Object.fromEntries(MODEL_CAPABILITIES.map((capability) => [capability, unknownAssessment()])) as CapabilityAssessmentMap
}

function normalizeSupport(value: CapabilitySupport | boolean | undefined): CapabilitySupport | null {
  if (value === true) return 'supported'
  if (value === false) return 'unsupported'
  if (value === 'supported' || value === 'unsupported' || value === 'unknown') return value
  return null
}

function applyDeclaration(
  target: CapabilityAssessmentMap,
  declaration: CapabilityDeclaration | undefined,
  source: 'provider' | 'model'
): void {
  if (!declaration) return
  for (const capability of MODEL_CAPABILITIES) {
    const support = normalizeSupport(declaration[capability])
    if (support === null) continue
    target[capability] = { support, source, verifiedAt: null }
  }
}

/** Model declarations override provider defaults, including an explicit unknown. */
export function mergeCapabilityDeclarations(
  provider: CapabilityDeclaration | undefined,
  model: CapabilityDeclaration | undefined
): CapabilityAssessmentMap {
  const merged = emptyCapabilityAssessments()
  applyDeclaration(merged, provider, 'provider')
  applyDeclaration(merged, model, 'model')
  return merged
}

/**
 * A successful probe overrides only capabilities it actually tested. Failed,
 * unavailable, cancelled, and running probes never create capability support.
 */
export function mergeProbeCapabilities(
  declared: CapabilityAssessmentMap,
  probe: ModelCapabilityProbeRecord | null
): CapabilityAssessmentMap {
  const merged = Object.fromEntries(
    MODEL_CAPABILITIES.map((capability) => [capability, { ...declared[capability] }])
  ) as CapabilityAssessmentMap
  if (!probe || probe.status !== 'succeeded' || probe.completedAt === null) return merged
  for (const capability of MODEL_CAPABILITIES) {
    const observation = probe.capabilities[capability]
    if (!observation || observation.outcome === 'not_tested') continue
    merged[capability] = {
      support: observation.outcome === 'confirmed' ? 'supported' : 'unsupported',
      source: 'probe',
      verifiedAt: probe.completedAt
    }
  }
  return merged
}

export function capabilitiesConfirmedByProbe(
  probe: ModelCapabilityProbeRecord,
  required: readonly ModelCapability[]
): { confirmed: boolean; missing: ModelCapability[] } {
  const missing = required.filter((capability) => probe.capabilities[capability]?.outcome !== 'confirmed')
  return { confirmed: missing.length === 0, missing }
}

