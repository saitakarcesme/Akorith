import { createHash } from 'node:crypto'
import {
  type RemoteNodeModel,
  type RemoteRuntimeAdapter,
  type RemoteRuntimeDiscoveryAdapter,
  type RemoteRuntimeKind,
  type RemoteRuntimeStatus,
  type RuntimeModelDescription
} from './types'
import { validateRuntimeModel } from './validation'

export interface RuntimeDiscoverySeam {
  kind: RemoteRuntimeKind
  label: string
  commonBaseUrls: readonly string[]
  discoveryContract: string
  generationContract: string
}

export const RUNTIME_DISCOVERY_SEAMS: readonly RuntimeDiscoverySeam[] = Object.freeze([
  {
    kind: 'ollama',
    label: 'Ollama',
    commonBaseUrls: ['http://127.0.0.1:11434'],
    discoveryContract: 'GET /api/tags',
    generationContract: 'POST /api/chat with stream=true'
  },
  {
    kind: 'lm_studio',
    label: 'LM Studio',
    commonBaseUrls: ['http://127.0.0.1:1234'],
    discoveryContract: 'GET /v1/models',
    generationContract: 'POST /v1/chat/completions with stream=true'
  },
  {
    kind: 'vllm',
    label: 'vLLM',
    commonBaseUrls: ['http://127.0.0.1:8000'],
    discoveryContract: 'GET /v1/models',
    generationContract: 'POST /v1/chat/completions with stream=true'
  },
  {
    kind: 'openai_compatible',
    label: 'OpenAI-compatible local endpoint',
    commonBaseUrls: [],
    discoveryContract: 'GET /v1/models',
    generationContract: 'POST /v1/chat/completions with stream=true'
  }
])

export interface DiscoveredRuntimeCatalog {
  runtimes: RemoteRuntimeStatus[]
  models: RemoteNodeModel[]
  warnings: string[]
}

export interface ModelBinding {
  adapter: RemoteRuntimeAdapter
  model: RuntimeModelDescription
}

const SAFE_RUNTIME_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 400) || 'runtime discovery failed'
}

function validPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

function modelKey(runtimeId: string, modelId: string): string {
  const digest = createHash('sha256').update(modelId).digest('hex').slice(0, 20)
  return `${runtimeId}:${digest}`
}

function cleanRuntimeStatus(adapter: RemoteRuntimeAdapter, available: boolean, reason: string | undefined, latencyMs: number, load: unknown): RemoteRuntimeStatus {
  const input = load && typeof load === 'object' ? (load as Record<string, unknown>) : undefined
  const cleanedLoad = input
    ? {
        ...(typeof input.activeRequests === 'number' && Number.isFinite(input.activeRequests) && input.activeRequests >= 0
          ? { activeRequests: Math.trunc(input.activeRequests) }
          : {}),
        ...(typeof input.queuedRequests === 'number' && Number.isFinite(input.queuedRequests) && input.queuedRequests >= 0
          ? { queuedRequests: Math.trunc(input.queuedRequests) }
          : {}),
        ...(validPercent(input.utilizationPercent) ? { utilizationPercent: input.utilizationPercent } : {})
      }
    : undefined
  return {
    id: adapter.id,
    kind: adapter.kind,
    label: adapter.label.trim().slice(0, 120),
    available,
    ...(reason ? { reason: reason.slice(0, 400) } : {}),
    latencyMs: Math.max(0, Math.trunc(latencyMs)),
    ...(cleanedLoad && Object.keys(cleanedLoad).length > 0 ? { load: cleanedLoad } : {})
  }
}

export class RuntimeDiscoveryRegistry {
  private readonly bindings = new Map<string, ModelBinding>()

  constructor(
    private readonly discoverers: readonly RemoteRuntimeDiscoveryAdapter[],
    private readonly limits: { maxRuntimes: number; maxModels: number } = { maxRuntimes: 32, maxModels: 512 }
  ) {}

  resolve(modelKeyValue: string): ModelBinding | null {
    return this.bindings.get(modelKeyValue) ?? null
  }

  async discover(signal: AbortSignal): Promise<DiscoveredRuntimeCatalog> {
    this.bindings.clear()
    const runtimes: RemoteRuntimeStatus[] = []
    const models: RemoteNodeModel[] = []
    const warnings: string[] = []
    const runtimeIds = new Set<string>()

    for (const discoverer of this.discoverers) {
      if (runtimes.length >= this.limits.maxRuntimes) break
      let adapters: readonly RemoteRuntimeAdapter[]
      try {
        adapters = await discoverer.discover(signal)
      } catch (error) {
        warnings.push(`${discoverer.kind} discovery failed: ${safeError(error)}`)
        continue
      }
      if (!Array.isArray(adapters)) {
        warnings.push(`${discoverer.kind} discovery returned an invalid adapter list.`)
        continue
      }

      for (const adapter of adapters) {
        if (runtimes.length >= this.limits.maxRuntimes || models.length >= this.limits.maxModels) break
        if (
          !adapter ||
          adapter.kind !== discoverer.kind ||
          typeof adapter.id !== 'string' ||
          !SAFE_RUNTIME_ID.test(adapter.id) ||
          typeof adapter.label !== 'string' ||
          !adapter.label.trim() ||
          runtimeIds.has(adapter.id)
        ) {
          warnings.push(`${discoverer.kind} discovery returned an invalid or duplicate runtime adapter.`)
          continue
        }
        runtimeIds.add(adapter.id)
        const startedAt = Date.now()
        let probe
        try {
          probe = await adapter.probe(signal)
        } catch (error) {
          runtimes.push(cleanRuntimeStatus(adapter, false, safeError(error), Date.now() - startedAt, undefined))
          continue
        }
        const latencyMs = Date.now() - startedAt
        if (!probe || typeof probe.available !== 'boolean') {
          runtimes.push(cleanRuntimeStatus(adapter, false, 'Runtime probe returned invalid data.', latencyMs, undefined))
          continue
        }
        const runtimeStatus = cleanRuntimeStatus(
          adapter,
          probe.available,
          probe.available ? undefined : probe.reason || 'Runtime is unavailable.',
          latencyMs,
          probe.load
        )
        runtimes.push(runtimeStatus)
        if (!probe.available) continue

        let descriptions: readonly RuntimeModelDescription[]
        try {
          descriptions = await adapter.listModels(signal)
        } catch (error) {
          runtimeStatus.available = false
          runtimeStatus.reason = `Model enumeration failed: ${safeError(error)}`
          continue
        }
        if (!Array.isArray(descriptions)) {
          runtimeStatus.available = false
          runtimeStatus.reason = 'Model enumeration returned invalid data.'
          continue
        }
        for (const description of descriptions) {
          if (models.length >= this.limits.maxModels) break
          const validated = validateRuntimeModel(description)
          if (!validated.ok || !validated.value) {
            warnings.push(`${adapter.label} omitted an invalid model: ${validated.error}`)
            continue
          }
          const key = modelKey(adapter.id, validated.value.id)
          if (this.bindings.has(key)) {
            warnings.push(`${adapter.label} returned a duplicate model id.`)
            continue
          }
          const model: RemoteNodeModel = {
            key,
            runtimeId: adapter.id,
            runtimeKind: adapter.kind,
            id: validated.value.id,
            name: validated.value.name.trim().slice(0, 300),
            available: validated.value.available !== false,
            ...(validated.value.unavailableReason ? { unavailableReason: validated.value.unavailableReason.slice(0, 500) } : {}),
            ...(validated.value.contextLength !== undefined ? { contextLength: validated.value.contextLength } : {}),
            ...(validated.value.quantization ? { quantization: validated.value.quantization.slice(0, 80) } : {}),
            ...(validated.value.requiredVramBytes !== undefined ? { requiredVramBytes: validated.value.requiredVramBytes } : {}),
            capabilities: { ...validated.value.capabilities }
          }
          models.push(model)
          this.bindings.set(key, { adapter, model: validated.value })
        }
      }
    }
    if (runtimes.length >= this.limits.maxRuntimes) warnings.push('Runtime catalog reached its configured runtime cap.')
    if (models.length >= this.limits.maxModels) warnings.push('Model catalog reached its configured model cap.')
    return { runtimes, models, warnings }
  }
}

export class StaticRuntimeDiscovery implements RemoteRuntimeDiscoveryAdapter {
  constructor(readonly kind: RemoteRuntimeKind, private readonly adapters: readonly RemoteRuntimeAdapter[]) {}

  async discover(signal: AbortSignal): Promise<readonly RemoteRuntimeAdapter[]> {
    if (signal.aborted) return []
    return this.adapters
  }
}
