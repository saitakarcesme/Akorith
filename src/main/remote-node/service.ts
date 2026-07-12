import { availableParallelism, cpus, freemem, platform, arch, totalmem } from 'node:os'
import { randomUUID } from 'node:crypto'
import { PairingAuthority, type ApprovedDeviceView } from './auth'
import { RuntimeDiscoveryRegistry } from './adapters'
import {
  REMOTE_NODE_PROTOCOL_VERSION,
  REMOTE_NODE_SCHEMA_VERSION,
  REMOTE_NODE_SAFETY_POLICY,
  type AdapterGenerationChunk,
  type CancelRequestEnvelope,
  type CatalogRequestEnvelope,
  type GenerateRequestEnvelope,
  type HealthRequestEnvelope,
  type RemoteGenerationEvent,
  type RemoteGenerationStreamResponse,
  type RemoteHardwareSnapshot,
  type RemoteNodeCatalog,
  type RemoteNodeHealth,
  type RemoteNodeIdentity,
  type RemoteNodeLoad,
  type RemoteNodeRequest,
  type RemoteNodeResponse,
  type RemoteRuntimeDiscoveryAdapter
} from './types'
import {
  unavailableHardware,
  validateAdapterChunk,
  validateGenerationRequest,
  validateHardwareSnapshot,
  validateRequestEnvelope
} from './validation'

export type RemoteNodeProtocolErrorCode =
  | 'invalid_request'
  | 'unsupported_version'
  | 'request_too_large'
  | 'unauthorized'
  | 'request_replayed'
  | 'rate_limited'
  | 'model_not_found'
  | 'model_unavailable'
  | 'generation_limit'
  | 'generation_not_found'
  | 'generation_forbidden'

export class RemoteNodeProtocolError extends Error {
  constructor(readonly code: RemoteNodeProtocolErrorCode, message: string, readonly status: number) {
    super(message)
    this.name = 'RemoteNodeProtocolError'
  }
}

export interface RemoteNodeServiceCaps {
  maxRequestBodyBytes: number
  maxRequestsPerWindow: number
  rateWindowMs: number
  maxPromptChars: number
  maxStreamChunkChars: number
  maxOutputChars: number
  maxConcurrentGenerations: number
  maxGenerationMs: number
  catalogCacheMs: number
}

export const DEFAULT_REMOTE_NODE_CAPS: Readonly<RemoteNodeServiceCaps> = Object.freeze({
  maxRequestBodyBytes: 512 * 1024,
  maxRequestsPerWindow: 120,
  rateWindowMs: 60_000,
  maxPromptChars: 200_000,
  maxStreamChunkChars: 32_000,
  maxOutputChars: 2_000_000,
  maxConcurrentGenerations: 2,
  maxGenerationMs: 10 * 60_000,
  catalogCacheMs: 5_000
})

export interface RemoteNodeServiceOptions {
  nodeId: string
  nodeName: string
  pairingAuthority: PairingAuthority
  runtimeDiscoverers: readonly RemoteRuntimeDiscoveryAdapter[]
  hardwareProvider?: () => Promise<unknown> | unknown
  caps?: Partial<RemoteNodeServiceCaps>
  now?: () => number
}

interface ActiveGeneration {
  ownerDeviceId: string
  controller: AbortController
  timeout: NodeJS.Timeout
}

interface CatalogCache {
  catalog: RemoteNodeCatalog
  expiresAt: number
}

class SlidingWindowRateLimiter {
  private readonly attempts = new Map<string, number[]>()

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  consume(key: string, now: number): boolean {
    const cutoff = now - this.windowMs
    const recent = (this.attempts.get(key) ?? []).filter((timestamp) => timestamp > cutoff)
    if (recent.length >= this.limit) {
      this.attempts.set(key, recent)
      return false
    }
    recent.push(now)
    this.attempts.set(key, recent)
    return true
  }
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), min), max) : fallback
}

function safeName(value: string, fallback: string): string {
  const clean = value.trim().replace(/[\0\r\n]/g, '').slice(0, 100)
  return clean || fallback
}

function protocolErrorFromValidation(error: string): RemoteNodeProtocolError {
  if (/version/i.test(error)) return new RemoteNodeProtocolError('unsupported_version', error, 426)
  if (/size cap|exceeds/i.test(error)) return new RemoteNodeProtocolError('request_too_large', error, 413)
  return new RemoteNodeProtocolError('invalid_request', error, 400)
}

function safeStreamError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 400) || 'generation failed'
}

export class RemoteNodeService {
  readonly identity: RemoteNodeIdentity
  readonly caps: RemoteNodeServiceCaps
  private readonly discovery: RuntimeDiscoveryRegistry
  private readonly rateLimiter: SlidingWindowRateLimiter
  private readonly activeGenerations = new Map<string, ActiveGeneration>()
  private readonly seenRequestIds = new Map<string, Map<string, number>>()
  private readonly now: () => number
  private catalogCache: CatalogCache | null = null

  constructor(private readonly options: RemoteNodeServiceOptions) {
    const normalizedNodeId = safeName(options.nodeId, 'remote-node').replace(/[^a-zA-Z0-9._:-]/g, '-')
    this.identity = {
      id: normalizedNodeId || 'remote-node',
      name: safeName(options.nodeName, 'Akorith Node'),
      protocolVersion: REMOTE_NODE_PROTOCOL_VERSION
    }
    this.caps = {
      maxRequestBodyBytes: clampInteger(options.caps?.maxRequestBodyBytes, DEFAULT_REMOTE_NODE_CAPS.maxRequestBodyBytes, 1_024, 4 * 1024 * 1024),
      maxRequestsPerWindow: clampInteger(options.caps?.maxRequestsPerWindow, DEFAULT_REMOTE_NODE_CAPS.maxRequestsPerWindow, 1, 10_000),
      rateWindowMs: clampInteger(options.caps?.rateWindowMs, DEFAULT_REMOTE_NODE_CAPS.rateWindowMs, 1_000, 60 * 60_000),
      maxPromptChars: clampInteger(options.caps?.maxPromptChars, DEFAULT_REMOTE_NODE_CAPS.maxPromptChars, 1_000, 2_000_000),
      maxStreamChunkChars: clampInteger(options.caps?.maxStreamChunkChars, DEFAULT_REMOTE_NODE_CAPS.maxStreamChunkChars, 256, 256_000),
      maxOutputChars: clampInteger(options.caps?.maxOutputChars, DEFAULT_REMOTE_NODE_CAPS.maxOutputChars, 1_000, 20_000_000),
      maxConcurrentGenerations: clampInteger(
        options.caps?.maxConcurrentGenerations,
        DEFAULT_REMOTE_NODE_CAPS.maxConcurrentGenerations,
        1,
        64
      ),
      maxGenerationMs: clampInteger(options.caps?.maxGenerationMs, DEFAULT_REMOTE_NODE_CAPS.maxGenerationMs, 1_000, 60 * 60_000),
      catalogCacheMs: clampInteger(options.caps?.catalogCacheMs, DEFAULT_REMOTE_NODE_CAPS.catalogCacheMs, 0, 5 * 60_000)
    }
    this.discovery = new RuntimeDiscoveryRegistry(options.runtimeDiscoverers)
    this.rateLimiter = new SlidingWindowRateLimiter(this.caps.maxRequestsPerWindow, this.caps.rateWindowMs)
    this.now = options.now ?? Date.now
  }

  async handle(request: unknown): Promise<RemoteNodeResponse> {
    const validated = validateRequestEnvelope(request, this.caps.maxRequestBodyBytes)
    if (!validated.ok || !validated.value) throw protocolErrorFromValidation(validated.error ?? 'invalid request')
    const envelope = validated.value
    const device = this.authorize(envelope)
    switch (envelope.kind) {
      case 'health':
        return this.health(envelope, device)
      case 'catalog':
        return this.catalog(envelope, device)
      case 'generate':
        return this.generate(envelope, device)
      case 'cancel':
        return this.cancel(envelope, device)
    }
  }

  private authorize(request: RemoteNodeRequest): ApprovedDeviceView {
    const now = this.now()
    const device = this.options.pairingAuthority.authenticate(request.bearerToken, now)
    if (!device) throw new RemoteNodeProtocolError('unauthorized', 'Device token is invalid or revoked.', 401)
    if (!this.rateLimiter.consume(device.id, now)) throw new RemoteNodeProtocolError('rate_limited', 'Remote-node request rate exceeded.', 429)
    if (!this.rememberRequestId(device.id, request.requestId, now)) {
      throw new RemoteNodeProtocolError('request_replayed', 'Request id was already used in the active replay-protection window.', 409)
    }
    return device
  }

  private rememberRequestId(deviceId: string, requestId: string, now: number): boolean {
    const cutoff = now - this.caps.rateWindowMs
    const recent = this.seenRequestIds.get(deviceId) ?? new Map<string, number>()
    for (const [seenId, timestamp] of recent) {
      if (timestamp <= cutoff) recent.delete(seenId)
    }
    if (recent.has(requestId)) return false
    recent.set(requestId, now)
    this.seenRequestIds.set(deviceId, recent)
    return true
  }

  private async health(request: HealthRequestEnvelope, _device: ApprovedDeviceView): Promise<RemoteNodeResponse> {
    const catalog = await this.getCatalog(false)
    const health: RemoteNodeHealth = {
      schemaVersion: REMOTE_NODE_SCHEMA_VERSION,
      checkedAt: this.now(),
      node: { ...this.identity },
      hardware: await this.hardware(),
      load: this.load(),
      runtimeCount: catalog.runtimes.filter((runtime) => runtime.available).length,
      modelCount: catalog.models.filter((model) => model.available).length,
      safety: { ...REMOTE_NODE_SAFETY_POLICY }
    }
    return { protocolVersion: REMOTE_NODE_PROTOCOL_VERSION, requestId: request.requestId, kind: 'health', health }
  }

  private async catalog(request: CatalogRequestEnvelope, _device: ApprovedDeviceView): Promise<RemoteNodeResponse> {
    const catalog = await this.getCatalog(request.body.refresh === true)
    return { protocolVersion: REMOTE_NODE_PROTOCOL_VERSION, requestId: request.requestId, kind: 'catalog', catalog }
  }

  private async generate(request: GenerateRequestEnvelope, device: ApprovedDeviceView): Promise<RemoteGenerationStreamResponse> {
    const checked = validateGenerationRequest(request.body, this.caps.maxPromptChars)
    if (!checked.ok || !checked.value) throw new RemoteNodeProtocolError('invalid_request', checked.error ?? 'invalid generation request', 400)
    if (this.activeGenerations.size >= this.caps.maxConcurrentGenerations) {
      throw new RemoteNodeProtocolError('generation_limit', 'Remote node is at its concurrent generation limit.', 429)
    }
    let binding = this.discovery.resolve(checked.value.modelKey)
    if (!binding) {
      await this.getCatalog(true)
      binding = this.discovery.resolve(checked.value.modelKey)
    }
    if (!binding) throw new RemoteNodeProtocolError('model_not_found', 'Requested remote model was not found.', 404)
    if (binding.model.available === false) throw new RemoteNodeProtocolError('model_unavailable', 'Requested remote model is unavailable.', 409)

    const generationId = randomUUID()
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort('generation timeout')
      this.activeGenerations.delete(generationId)
    }, this.caps.maxGenerationMs)
    this.activeGenerations.set(generationId, { ownerDeviceId: device.id, controller, timeout })
    let source: AsyncIterable<AdapterGenerationChunk>
    try {
      source = binding.adapter.generate(
        {
          generationId,
          modelId: binding.model.id,
          messages: checked.value.messages,
          ...(checked.value.maxOutputTokens !== undefined ? { maxOutputTokens: checked.value.maxOutputTokens } : {}),
          ...(checked.value.temperature !== undefined ? { temperature: checked.value.temperature } : {})
        },
        controller.signal
      )
    } catch (error) {
      clearTimeout(timeout)
      this.activeGenerations.delete(generationId)
      throw new RemoteNodeProtocolError('model_unavailable', safeStreamError(error), 503)
    }

    return {
      protocolVersion: REMOTE_NODE_PROTOCOL_VERSION,
      requestId: request.requestId,
      kind: 'generation_stream',
      generationId,
      stream: this.streamGeneration(generationId, checked.value.modelKey, source, controller)
    }
  }

  private async cancel(request: CancelRequestEnvelope, device: ApprovedDeviceView): Promise<RemoteNodeResponse> {
    const active = this.activeGenerations.get(request.body.generationId)
    if (!active) {
      return {
        protocolVersion: REMOTE_NODE_PROTOCOL_VERSION,
        requestId: request.requestId,
        kind: 'cancel',
        generationId: request.body.generationId,
        cancelled: false
      }
    }
    if (active.ownerDeviceId !== device.id) {
      throw new RemoteNodeProtocolError('generation_forbidden', 'A device may cancel only its own generation.', 403)
    }
    active.controller.abort('cancelled by client')
    clearTimeout(active.timeout)
    this.activeGenerations.delete(request.body.generationId)
    return {
      protocolVersion: REMOTE_NODE_PROTOCOL_VERSION,
      requestId: request.requestId,
      kind: 'cancel',
      generationId: request.body.generationId,
      cancelled: true
    }
  }

  private async *streamGeneration(
    generationId: string,
    modelKey: string,
    source: AsyncIterable<AdapterGenerationChunk>,
    controller: AbortController
  ): AsyncGenerator<RemoteGenerationEvent> {
    let index = 0
    let outputChars = 0
    yield { type: 'started', generationId, modelKey, at: this.now() }
    try {
      for await (const raw of source) {
        if (controller.signal.aborted) break
        const chunk = validateAdapterChunk(raw, this.caps.maxStreamChunkChars)
        if (!chunk.ok || !chunk.value) {
          controller.abort('invalid stream chunk')
          yield { type: 'error', generationId, at: this.now(), code: 'invalid_stream_chunk', message: chunk.error ?? 'invalid stream chunk' }
          return
        }
        if (chunk.value.type === 'delta') {
          outputChars += chunk.value.text.length
          if (outputChars > this.caps.maxOutputChars) {
            controller.abort('output cap exceeded')
            yield { type: 'error', generationId, at: this.now(), code: 'output_too_large', message: 'Remote output exceeded its size cap.' }
            return
          }
          yield { type: 'delta', generationId, text: chunk.value.text, index: index++ }
        } else {
          const { promptTokens, completionTokens, cachedTokens } = chunk.value
          yield { type: 'usage', generationId, promptTokens, completionTokens, cachedTokens }
        }
      }
      if (controller.signal.aborted) yield { type: 'cancelled', generationId, at: this.now() }
      else yield { type: 'completed', generationId, at: this.now() }
    } catch (error) {
      if (controller.signal.aborted) yield { type: 'cancelled', generationId, at: this.now() }
      else yield { type: 'error', generationId, at: this.now(), code: 'generation_failed', message: safeStreamError(error) }
    } finally {
      const active = this.activeGenerations.get(generationId)
      if (active) clearTimeout(active.timeout)
      this.activeGenerations.delete(generationId)
    }
  }

  private async getCatalog(forceRefresh: boolean): Promise<RemoteNodeCatalog> {
    const now = this.now()
    if (!forceRefresh && this.catalogCache && this.catalogCache.expiresAt >= now) {
      return { ...this.catalogCache.catalog, load: this.load() }
    }
    const discovered = await this.discovery.discover(new AbortController().signal)
    const catalog: RemoteNodeCatalog = {
      schemaVersion: REMOTE_NODE_SCHEMA_VERSION,
      generatedAt: now,
      node: { ...this.identity },
      hardware: await this.hardware(),
      load: this.load(),
      runtimes: discovered.runtimes,
      models: discovered.models,
      safety: { ...REMOTE_NODE_SAFETY_POLICY },
      warnings: discovered.warnings
    }
    this.catalogCache = { catalog, expiresAt: now + this.caps.catalogCacheMs }
    return catalog
  }

  private load(): RemoteNodeLoad {
    return {
      activeGenerations: this.activeGenerations.size,
      queuedGenerations: 0,
      maxConcurrentGenerations: this.caps.maxConcurrentGenerations,
      utilizationPercent: (this.activeGenerations.size / this.caps.maxConcurrentGenerations) * 100
    }
  }

  private async hardware(): Promise<RemoteHardwareSnapshot> {
    let candidate: unknown
    try {
      candidate = this.options.hardwareProvider ? await this.options.hardwareProvider() : this.defaultHardware()
    } catch (error) {
      return unavailableHardware(platform(), arch(), availableParallelism(), `Hardware telemetry failed: ${safeStreamError(error)}`, this.now())
    }
    const validated = validateHardwareSnapshot(candidate)
    if (validated.ok && validated.value) return validated.value
    return unavailableHardware(
      platform(),
      arch(),
      availableParallelism(),
      `Hardware telemetry unavailable: ${validated.error ?? 'invalid observation'}`,
      this.now()
    )
  }

  private defaultHardware(): RemoteHardwareSnapshot {
    const cpu = cpus()[0]
    return {
      observedAt: this.now(),
      platform: platform(),
      architecture: arch(),
      cpu: { logicalCores: availableParallelism(), ...(cpu?.model ? { model: cpu.model.slice(0, 300) } : {}) },
      memory: { totalBytes: totalmem(), freeBytes: freemem() },
      gpu: {
        status: 'unavailable',
        devices: [],
        reason: 'No GPU telemetry adapter was configured for this remote-node service.'
      }
    }
  }
}
