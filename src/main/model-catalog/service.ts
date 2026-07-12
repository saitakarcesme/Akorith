import { randomUUID } from 'node:crypto'
import { buildModelCatalog } from './normalize'
import {
  createRunningProbeRecord,
  runCapabilityProbe,
  unavailableProbeRecord,
  type ProbeModelTransport,
  type ProbeTransportResolver
} from './probe-runner'
import type { ModelCatalogStore } from './store'
import type {
  CatalogModel,
  ModelCapabilityProbeRecord,
  ModelCatalog,
  ProbeKind
} from './types'
import type { ProviderCatalogSource, RemoteCatalogSource } from './discovery'

export interface CatalogDiscoveryResult {
  catalog: ModelCatalog
  warnings: string[]
}

export interface ModelCatalogServiceOptions {
  store: Pick<ModelCatalogStore, 'listProbes' | 'saveProbe'>
  providers: ProviderCatalogSource
  remoteNodes?: RemoteCatalogSource
  resolveTransport: ProbeTransportResolver
  now?: () => number
  createId?: () => string
  probeTimeoutMs?: number
  probeFreshForMs?: number
  tempRoot?: string
}

export interface RunCatalogProbeOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return value.replace(/[\r\n]+/g, ' ').slice(0, 500) || 'Unknown discovery error.'
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('Catalog discovery cancelled.')
  error.name = 'AbortError'
  throw error
}

/**
 * Live catalog coordinator. It never caches a permanent model list: every
 * refresh asks the injected provider registry and remote-node sources again.
 */
export class ModelCatalogService {
  private readonly now: () => number
  private readonly createId: () => string

  constructor(private readonly options: ModelCatalogServiceOptions) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => `probe-${randomUUID()}`)
  }

  async discover(signal: AbortSignal = new AbortController().signal): Promise<CatalogDiscoveryResult> {
    throwIfAborted(signal)
    const warnings: string[] = []
    const [providers, remoteNodes] = await Promise.all([
      this.options.providers(signal).catch((error) => {
        throwIfAborted(signal)
        warnings.push(`Provider discovery failed: ${safeMessage(error)}`)
        return []
      }),
      this.options.remoteNodes
        ? this.options.remoteNodes(signal).catch((error) => {
            throwIfAborted(signal)
            warnings.push(`Remote-node discovery failed: ${safeMessage(error)}`)
            return []
          })
        : Promise.resolve([])
    ])
    throwIfAborted(signal)
    const probes = this.options.store.listProbes(undefined, 5_000)
    return {
      catalog: buildModelCatalog({
        providers,
        remoteNodes,
        probes,
        generatedAt: this.now()
      }),
      warnings
    }
  }

  async runProbe(
    catalogModelId: string,
    probeKind: ProbeKind,
    runOptions: RunCatalogProbeOptions = {}
  ): Promise<ModelCapabilityProbeRecord> {
    const discovery = await this.discover(runOptions.signal)
    const model = discovery.catalog.models.find((candidate) => candidate.id === catalogModelId)
    if (!model) throw new Error(`Catalog model not found: ${catalogModelId}`)
    const startedAt = this.now()
    const id = this.createId()
    const running = createRunningProbeRecord(model, probeKind, startedAt, id)
    this.options.store.saveProbe(running)
    if (model.availability.status !== 'available') {
      return this.options.store.saveProbe(unavailableProbeRecord(
        running,
        this.now(),
        model.availability.reason ?? 'Model is not currently available.'
      ))
    }
    let transport: ProbeModelTransport | null = null
    try {
      transport = await this.options.resolveTransport(model, runOptions.signal ?? new AbortController().signal)
    } catch (error) {
      if (runOptions.signal?.aborted) {
        const cancelled = {
          ...running,
          status: 'cancelled' as const,
          completedAt: this.now(),
          freshUntil: null,
          failureCode: 'probe_cancelled',
          failureMessage: 'Capability probe was cancelled before transport resolution.',
          durationMs: Math.max(0, this.now() - startedAt)
        }
        return this.options.store.saveProbe(cancelled)
      }
      const unavailable = unavailableProbeRecord(
        running,
        this.now(),
        `Probe transport could not be resolved: ${safeMessage(error)}`
      )
      return this.options.store.saveProbe(unavailable)
    }
    if (!transport) {
      const unavailable = unavailableProbeRecord(
        running,
        this.now(),
        'No executable probe transport is connected for this model.'
      )
      return this.options.store.saveProbe(unavailable)
    }
    const result = await runCapabilityProbe({
      id,
      model,
      probeKind,
      transport,
      signal: runOptions.signal,
      timeoutMs: runOptions.timeoutMs ?? this.options.probeTimeoutMs,
      freshForMs: this.options.probeFreshForMs,
      tempRoot: this.options.tempRoot,
      now: this.now
    })
    return this.options.store.saveProbe(result)
  }

  async model(
    catalogModelId: string,
    signal?: AbortSignal
  ): Promise<{ model: CatalogModel | null; warnings: string[] }> {
    const discovery = await this.discover(signal)
    return {
      model: discovery.catalog.models.find((candidate) => candidate.id === catalogModelId) ?? null,
      warnings: discovery.warnings
    }
  }
}
