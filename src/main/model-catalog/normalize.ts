import { mergeCapabilityDeclarations, mergeProbeCapabilities } from './capabilities'
import { catalogDisplayLabel, normalizeCatalogIdentifier, stableCatalogModelId } from './identity'
import { latestProbeForModel, validateProbeRecord } from './probes'
import { MODEL_PROVIDER_FAMILIES, MODEL_SOURCES } from './types'
import type {
  BuildModelCatalogInput,
  CapabilityDeclaration,
  CatalogAvailability,
  CatalogModel,
  ModelCatalog,
  ModelCapabilityProbeRecord,
  ModelProviderFamily,
  ModelSource,
  ProviderCatalogSnapshot,
  ProviderModelSnapshot,
  RemoteNodeCatalogSnapshot,
  RemoteNodeModelSnapshot,
  RegistryProviderSnapshot,
  SnapshotAvailability
} from './types'

const providerFamilies = new Set<string>(MODEL_PROVIDER_FAMILIES)
const modelSources = new Set<string>(MODEL_SOURCES)

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim()
  return clean && clean.length <= max && !/[\0\r\n]/.test(clean) ? clean : null
}

function boundedNumber(value: unknown, min: number, max: number, integer = false): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return null
  if (integer && !Number.isSafeInteger(value)) return null
  return value
}

export function inferProviderFamily(providerId: string, providerLabel = ''): ModelProviderFamily {
  const value = `${providerId} ${providerLabel}`.toLowerCase()
  if (/claude|anthropic/.test(value)) return 'anthropic'
  if (/opencode/.test(value)) return 'opencode'
  if (/ollama|\blocal\b/.test(value)) return 'ollama'
  if (/codex|openai|chatgpt|\bgpt\b/.test(value)) return 'openai'
  if (/lm[ _-]?studio|vllm|openai[ _-]?compatible/.test(value)) return 'openai_compatible'
  return 'other'
}

function inferSource(snapshot: ProviderCatalogSnapshot, family: ModelProviderFamily): ModelSource {
  if (snapshot.source && modelSources.has(snapshot.source)) return snapshot.source
  if (family === 'ollama' || /(^|[-_.])local($|[-_.])|ollama/i.test(snapshot.providerId)) return 'local'
  return 'cloud'
}

export function normalizeAvailability(value: SnapshotAvailability | unknown): CatalogAvailability {
  if (typeof value === 'boolean') {
    return { status: value ? 'available' : 'unavailable', reason: value ? null : 'Provider reported unavailable.', checkedAt: null }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'unknown', reason: 'Availability has not been checked.', checkedAt: null }
  }
  const raw = value as Record<string, unknown>
  const checkedAt = boundedNumber(raw.checkedAt, 0, Number.MAX_SAFE_INTEGER, true)
  const reason = boundedText(raw.reason, 500)
  const status = raw.status === 'available' || raw.status === 'unavailable' || raw.status === 'unknown'
    ? raw.status
    : raw.ok === true
      ? 'available'
      : raw.ok === false
        ? 'unavailable'
        : 'unknown'
  return {
    status,
    reason: reason ?? (status === 'unavailable' ? 'Provider reported unavailable.' : status === 'unknown' ? 'Availability has not been checked.' : null),
    checkedAt
  }
}

function mergeAvailability(layers: readonly CatalogAvailability[]): CatalogAvailability {
  const unavailable = layers.find((layer) => layer.status === 'unavailable')
  if (unavailable) return unavailable
  const unknown = layers.find((layer) => layer.status === 'unknown')
  if (unknown) return unknown
  const latest = [...layers].sort((a, b) => (b.checkedAt ?? 0) - (a.checkedAt ?? 0))[0]
  return latest ?? { status: 'unknown', reason: 'Availability has not been checked.', checkedAt: null }
}

function normalizeMetadata(value: ProviderModelSnapshot['metadata']): Record<string, string | number | boolean | null> {
  if (!value) return {}
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, entry] of Object.entries(value).slice(0, 32)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key)) continue
    if (entry === null || typeof entry === 'boolean') out[key] = entry
    else if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry
    else {
      const clean = boundedText(entry, 500)
      if (clean !== null) out[key] = clean
    }
  }
  return out
}

function normalizedProbeRecords(records: readonly ModelCapabilityProbeRecord[]): ModelCapabilityProbeRecord[] {
  const valid: ModelCapabilityProbeRecord[] = []
  for (const record of records) {
    const checked = validateProbeRecord(record)
    if (checked.ok) valid.push(checked.record)
  }
  return valid
}

interface NormalizeModelInput {
  providerId: string
  providerLabel: string
  family: ModelProviderFamily
  source: ModelSource
  nodeId: string | null
  nodeName: string | null
  providerAvailability: CatalogAvailability
  nodeAvailability?: CatalogAvailability
  providerCapabilities?: CapabilityDeclaration
  model: ProviderModelSnapshot
  inheritedLoad?: number
  inheritedPing?: number
  probes: readonly ModelCapabilityProbeRecord[]
}

function normalizeModel(input: NormalizeModelInput): CatalogModel | null {
  const modelName = boundedText(input.model.name, 240)
  if (!modelName) return null
  const modelKey = boundedText(input.model.id, 240) ?? modelName
  const label = boundedText(input.model.label, 240) ?? modelName
  const id = stableCatalogModelId({
    source: input.source,
    providerId: input.providerId,
    nodeId: input.nodeId,
    modelId: modelKey
  })
  const availabilityLayers = [input.providerAvailability]
  if (input.nodeAvailability) availabilityLayers.push(input.nodeAvailability)
  if (input.model.available !== undefined) availabilityLayers.push(normalizeAvailability(input.model.available))
  const declaredCapabilities = mergeCapabilityDeclarations(input.providerCapabilities, input.model.capabilities)
  const latestCodeProbe = latestProbeForModel(input.probes, id, 'code_execution')
  const latestReasoningProbe = latestProbeForModel(input.probes, id, 'reasoning')
  let effectiveCapabilities = declaredCapabilities
  const successfulLatest = [latestCodeProbe, latestReasoningProbe]
    .filter((probe): probe is ModelCapabilityProbeRecord => probe?.status === 'succeeded')
    .sort((a, b) => (a.completedAt ?? a.startedAt) - (b.completedAt ?? b.startedAt))
  for (const probe of successfulLatest) effectiveCapabilities = mergeProbeCapabilities(effectiveCapabilities, probe)
  return {
    id,
    providerId: normalizeCatalogIdentifier(input.providerId, 'provider'),
    providerLabel: boundedText(input.providerLabel, 160) ?? input.providerId,
    family: input.family,
    source: input.source,
    modelName,
    label,
    displayLabel: catalogDisplayLabel({
      source: input.source,
      providerLabel: input.providerLabel,
      nodeName: input.nodeName,
      modelLabel: label
    }),
    nodeId: input.nodeId,
    nodeName: input.nodeName,
    availability: mergeAvailability(availabilityLayers),
    contextWindowTokens: boundedNumber(input.model.contextWindowTokens, 1, 10_000_000_000, true),
    quantization: boundedText(input.model.quantization, 80),
    vramRequirementMb: boundedNumber(input.model.vramRequirementMb, 0, 10_000_000),
    currentLoadPercent: boundedNumber(input.model.currentLoadPercent ?? input.inheritedLoad, 0, 100),
    pingMs: boundedNumber(input.model.pingMs ?? input.inheritedPing, 0, 3_600_000),
    declaredCapabilities,
    effectiveCapabilities,
    latestProbe: latestCodeProbe,
    latestReasoningProbe,
    metadata: normalizeMetadata(input.model.metadata)
  }
}

function providerModels(snapshot: ProviderCatalogSnapshot, probes: readonly ModelCapabilityProbeRecord[]): CatalogModel[] {
  const providerId = normalizeCatalogIdentifier(snapshot.providerId, 'provider')
  const providerLabel = boundedText(snapshot.providerLabel, 160) ?? snapshot.providerId
  const family = snapshot.family && providerFamilies.has(snapshot.family)
    ? snapshot.family
    : inferProviderFamily(providerId, providerLabel)
  const source = inferSource(snapshot, family)
  const nodeId = source === 'local'
    ? normalizeCatalogIdentifier(snapshot.nodeId ?? 'this-device', 'this-device')
    : snapshot.nodeId
      ? normalizeCatalogIdentifier(snapshot.nodeId, 'node')
      : null
  const nodeName = source === 'local' ? 'This device' : boundedText(snapshot.nodeName, 160)
  const availability = normalizeAvailability(snapshot.availability)
  return snapshot.models
    .map((entry): ProviderModelSnapshot => (typeof entry === 'string' ? { name: entry } : entry))
    .map((model) =>
      normalizeModel({
        providerId,
        providerLabel,
        family,
        source,
        nodeId,
        nodeName,
        providerAvailability: availability,
        providerCapabilities: snapshot.capabilities,
        model,
        probes
      })
    )
    .filter((model): model is CatalogModel => model !== null)
}

export function providerCatalogSnapshot(
  snapshot: ProviderCatalogSnapshot | RegistryProviderSnapshot
): ProviderCatalogSnapshot {
  if ('providerId' in snapshot) return snapshot
  return {
    providerId: snapshot.id,
    providerLabel: snapshot.label,
    availability: snapshot.available,
    models: snapshot.models,
    ...(snapshot.family ? { family: snapshot.family } : {}),
    ...(snapshot.source ? { source: snapshot.source } : {}),
    ...(snapshot.nodeId ? { nodeId: snapshot.nodeId } : {}),
    ...(snapshot.nodeName ? { nodeName: snapshot.nodeName } : {}),
    ...(snapshot.capabilities ? { capabilities: snapshot.capabilities } : {})
  }
}

function remoteFamily(model: RemoteNodeModelSnapshot): ModelProviderFamily {
  if (model.family && providerFamilies.has(model.family)) return model.family
  if (model.runtime === 'ollama') return 'ollama'
  if (model.runtime === 'lm_studio' || model.runtime === 'vllm' || model.runtime === 'openai_compatible') {
    return 'openai_compatible'
  }
  return inferProviderFamily(model.providerId ?? model.runtime ?? 'remote', model.providerLabel ?? '')
}

function remoteModels(snapshot: RemoteNodeCatalogSnapshot, probes: readonly ModelCapabilityProbeRecord[]): CatalogModel[] {
  const nodeId = normalizeCatalogIdentifier(snapshot.nodeId, 'remote-node')
  const nodeName = boundedText(snapshot.nodeName, 160) ?? nodeId
  const nodeAvailability = normalizeAvailability(snapshot.availability)
  return snapshot.models
    .map((model) => {
      const family = remoteFamily(model)
      const runtime = model.runtime ?? family
      const providerId = normalizeCatalogIdentifier(model.providerId ?? `remote-${runtime}`, 'remote-provider')
      const providerLabel = boundedText(model.providerLabel, 160) ?? (runtime === 'ollama' ? 'Ollama' : runtime.replace(/_/g, ' '))
      return normalizeModel({
        providerId,
        providerLabel,
        family,
        source: 'remote',
        nodeId,
        nodeName,
        providerAvailability: nodeAvailability,
        nodeAvailability,
        providerCapabilities: snapshot.capabilities,
        model,
        inheritedLoad: snapshot.currentLoadPercent,
        inheritedPing: snapshot.pingMs,
        probes
      })
    })
    .filter((model): model is CatalogModel => model !== null)
}

export function buildModelCatalog(input: BuildModelCatalogInput): ModelCatalog {
  const generatedAt = input.generatedAt ?? Date.now()
  if (!Number.isSafeInteger(generatedAt) || generatedAt < 0) throw new Error('catalog generatedAt is invalid')
  const probes = normalizedProbeRecords(input.probes ?? [])
  const candidates = [
    ...input.providers.flatMap((provider) => providerModels(providerCatalogSnapshot(provider), probes)),
    ...(input.remoteNodes ?? []).flatMap((node) => remoteModels(node, probes))
  ].sort((a, b) => a.id.localeCompare(b.id) || a.displayLabel.localeCompare(b.displayLabel))
  const models: CatalogModel[] = []
  const seen = new Set<string>()
  const collisions: string[] = []
  for (const model of candidates) {
    if (seen.has(model.id)) {
      collisions.push(model.id)
      continue
    }
    seen.add(model.id)
    models.push(model)
  }
  return { generatedAt, models, collisions: [...new Set(collisions)] }
}
