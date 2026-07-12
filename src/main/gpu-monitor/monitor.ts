import type { GpuDetailSampleInput } from '../telemetry/types'
import type {
  GpuMonitorError,
  GpuMonitorOptions,
  GpuMonitorPolicy,
  GpuMonitorSnapshot,
  GpuMonitorTimer,
  GpuObservation,
  GpuPollResult,
  GpuSampleSource,
  GpuSourceState
} from './types'
import { normalizeGpuMonitorPolicy, validateGpuObservation, validateGpuSourceIdentity } from './validation'

class GpuSourceTimeoutError extends Error {
  constructor(sourceId: string) {
    super(`GPU source ${sourceId} timed out.`)
    this.name = 'TimeoutError'
  }
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error(typeof reason === 'string' && reason ? reason : 'GPU monitoring was cancelled.')
  error.name = 'AbortError'
  return error
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/[\0\r\n]+/g, ' ').trim().slice(0, 400) || 'unknown GPU monitoring error'
}

export const systemGpuMonitorTimer: GpuMonitorTimer = Object.freeze({
  now: Date.now,
  setTimeout(callback: () => void, delayMs: number): unknown {
    return globalThis.setTimeout(callback, delayMs)
  },
  clearTimeout(handle: unknown): void {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  }
})

function waitFor(timer: GpuMonitorTimer, delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal.reason))
  return new Promise((resolve, reject) => {
    let handle: unknown
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      if (handle !== undefined) timer.clearTimeout(handle)
    }
    const onAbort = (): void => {
      cleanup()
      reject(abortError(signal.reason))
    }
    handle = timer.setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, Math.trunc(delayMs)))
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function cloneObservation(observation: GpuObservation): GpuObservation {
  return observation.status === 'observed'
    ? {
        ...observation,
        devices: observation.devices.map((device) => ({ ...device })),
        warnings: [...observation.warnings]
      }
    : { ...observation, devices: [], warnings: [...observation.warnings] }
}

function cloneState(state: GpuSourceState): GpuSourceState {
  return { ...state, ...(state.lastObservation ? { lastObservation: cloneObservation(state.lastObservation) } : {}) }
}

export interface GpuPollOptions {
  force?: boolean
  signal?: AbortSignal
}

export class GpuMonitor {
  readonly policy: Readonly<GpuMonitorPolicy>
  private readonly sources: readonly GpuSampleSource[]
  private readonly sink: GpuMonitorOptions['sink']
  private readonly timer: GpuMonitorTimer
  private readonly onError?: GpuMonitorOptions['onError']
  private readonly states = new Map<string, GpuSourceState>()
  private readonly lastWrittenAt = new Map<string, number>()
  private readonly listeners = new Set<(snapshot: GpuMonitorSnapshot) => void>()
  private controller?: AbortController
  private loopPromise?: Promise<void>
  private pollPromise?: Promise<GpuPollResult[]>
  private startedAt?: number
  private nextMaintenanceAt: number

  constructor(options: GpuMonitorOptions) {
    if (!options.sources.length) throw new Error('GPU monitor requires at least one source')
    this.sources = [...options.sources]
    this.sink = options.sink
    this.timer = options.timer ?? systemGpuMonitorTimer
    this.onError = options.onError
    this.policy = Object.freeze(normalizeGpuMonitorPolicy(options.policy))
    const sourceById = new Map<string, GpuSampleSource>()
    const now = this.timer.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('GPU monitor clock is invalid')
    for (const source of this.sources) {
      validateGpuSourceIdentity(source)
      if (sourceById.has(source.id)) throw new Error(`duplicate GPU source id: ${source.id}`)
      sourceById.set(source.id, source)
      this.states.set(source.id, {
        sourceId: source.id,
        nodeId: source.nodeId,
        location: source.location,
        consecutiveFailures: 0,
        nextPollAt: now
      })
    }
    this.nextMaintenanceAt = now + this.policy.maintenanceIntervalMs
  }

  getSnapshot(): GpuMonitorSnapshot {
    return {
      running: Boolean(this.loopPromise && this.controller && !this.controller.signal.aborted),
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      sources: this.sources.map((source) => cloneState(this.states.get(source.id)!))
    }
  }

  subscribe(listener: (snapshot: GpuMonitorSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (this.loopPromise) return
    const controller = new AbortController()
    this.controller = controller
    this.startedAt = this.timer.now()
    const loop = this.runLoop(controller).finally(() => {
      if (this.controller === controller) {
        this.controller = undefined
        this.loopPromise = undefined
        this.startedAt = undefined
        this.emit()
      }
    })
    this.loopPromise = loop
    this.emit()
  }

  async stop(): Promise<void> {
    const controller = this.controller
    const loop = this.loopPromise
    if (!controller || !loop) return
    controller.abort('GPU monitor stopped.')
    await loop
  }

  async pollOnce(options: GpuPollOptions = {}): Promise<GpuPollResult[]> {
    if (this.pollPromise) return this.pollPromise
    const signal = options.signal ?? new AbortController().signal
    const poll = this.pollSources(Boolean(options.force), signal)
    this.pollPromise = poll
    try {
      return await poll
    } finally {
      if (this.pollPromise === poll) this.pollPromise = undefined
    }
  }

  async maintainNow(): Promise<void> {
    await this.runMaintenance(this.timer.now())
  }

  private async runLoop(controller: AbortController): Promise<void> {
    try {
      while (!controller.signal.aborted) {
        await this.pollOnce({ signal: controller.signal })
        if (controller.signal.aborted) break
        const now = this.timer.now()
        const nextPollAt = Math.min(...[...this.states.values()].map((state) => state.nextPollAt))
        await waitFor(this.timer, Math.max(25, nextPollAt - now), controller.signal)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.reportError({ phase: 'lifecycle', message: safeMessage(error) })
      }
    }
  }

  private async pollSources(force: boolean, signal: AbortSignal): Promise<GpuPollResult[]> {
    if (signal.aborted) throw abortError(signal.reason)
    const now = this.timer.now()
    const results = await Promise.all(
      this.sources.map(async (source): Promise<GpuPollResult> => {
        const current = this.states.get(source.id)!
        if (!force && current.nextPollAt > now) {
          return { sourceId: source.id, skipped: true, samplesWritten: 0, duplicateSamplesSkipped: 0, state: cloneState(current) }
        }
        return this.pollSource(source, signal)
      })
    )
    const maintenanceNow = this.timer.now()
    if (maintenanceNow >= this.nextMaintenanceAt) await this.runMaintenance(maintenanceNow)
    return results
  }

  private async pollSource(source: GpuSampleSource, signal: AbortSignal): Promise<GpuPollResult> {
    let observation: GpuObservation
    try {
      const candidate = await this.sampleWithDeadline(source, signal)
      const validated = validateGpuObservation(candidate)
      if (!validated.ok) throw new Error(validated.error)
      observation = validated.value
    } catch (error) {
      if (signal.aborted) throw abortError(signal.reason)
      const status = source.location === 'remote' ? 'disconnected' : 'unavailable'
      const message = safeMessage(error)
      this.reportError({ phase: 'source', sourceId: source.id, message })
      observation = {
        status,
        observedAt: this.timer.now(),
        devices: [],
        reason: `${source.location === 'remote' ? 'Remote' : 'Local'} GPU source failed: ${message}`,
        warnings: []
      }
    }

    let samplesWritten = 0
    let duplicateSamplesSkipped = 0
    if (observation.status === 'observed') {
      for (const device of observation.devices) {
        const dedupeKey = `${source.id}\0${device.id}`
        const previous = this.lastWrittenAt.get(dedupeKey)
        if (previous !== undefined && previous >= observation.observedAt) {
          duplicateSamplesSkipped += 1
          continue
        }
        const sample: GpuDetailSampleInput = {
          occurredAt: observation.observedAt,
          nodeId: source.nodeId,
          deviceId: device.id,
          deviceName: device.name,
          ...(device.utilizationPercent !== undefined ? { utilizationPercent: device.utilizationPercent } : {}),
          ...(device.memoryUsedMb !== undefined ? { memoryUsedMb: device.memoryUsedMb } : {}),
          ...(device.memoryTotalMb !== undefined ? { memoryTotalMb: device.memoryTotalMb } : {}),
          ...(device.temperatureC !== undefined ? { temperatureC: device.temperatureC } : {}),
          ...(device.powerWatts !== undefined ? { powerWatts: device.powerWatts } : {}),
          ...(device.activeModel !== undefined ? { model: device.activeModel } : {}),
          ...(device.processName !== undefined ? { processName: device.processName } : {})
        }
        try {
          await this.sink.writeSample(sample)
          this.lastWrittenAt.set(dedupeKey, observation.observedAt)
          samplesWritten += 1
        } catch (error) {
          this.reportError({ phase: 'sink', sourceId: source.id, message: safeMessage(error) })
        }
      }
    }

    const previous = this.states.get(source.id)!
    const consecutiveFailures =
      observation.status === 'observed' || observation.status === 'unsupported' ? 0 : previous.consecutiveFailures + 1
    const nextPollAt = this.timer.now() + this.delayAfter(observation.status, consecutiveFailures)
    const state: GpuSourceState = {
      sourceId: source.id,
      nodeId: source.nodeId,
      location: source.location,
      consecutiveFailures,
      nextPollAt,
      lastObservation: observation
    }
    this.states.set(source.id, state)
    this.emit()
    return { sourceId: source.id, skipped: false, samplesWritten, duplicateSamplesSkipped, state: cloneState(state) }
  }

  private async sampleWithDeadline(source: GpuSampleSource, parentSignal: AbortSignal): Promise<GpuObservation> {
    const controller = new AbortController()
    const propagateAbort = (): void => controller.abort(parentSignal.reason)
    if (parentSignal.aborted) propagateAbort()
    else parentSignal.addEventListener('abort', propagateAbort, { once: true })

    let rejectAborted!: (error: Error) => void
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject
    })
    const onAbort = (): void => rejectAborted(abortError(controller.signal.reason))
    if (controller.signal.aborted) onAbort()
    else controller.signal.addEventListener('abort', onAbort, { once: true })
    const timeout = this.timer.setTimeout(
      () => controller.abort(new GpuSourceTimeoutError(source.id)),
      this.policy.sourceTimeoutMs
    )
    const sampled = Promise.resolve().then(() => source.sample(controller.signal))
    void sampled.catch(() => undefined)
    try {
      return await Promise.race([sampled, aborted])
    } finally {
      this.timer.clearTimeout(timeout)
      parentSignal.removeEventListener('abort', propagateAbort)
      controller.signal.removeEventListener('abort', onAbort)
    }
  }

  private delayAfter(status: GpuObservation['status'], consecutiveFailures: number): number {
    if (status === 'observed') return this.policy.pollIntervalMs
    if (status === 'unsupported') return this.policy.maxBackoffMs
    const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 30)
    return Math.min(
      this.policy.maxBackoffMs,
      Math.trunc(this.policy.initialBackoffMs * this.policy.backoffMultiplier ** exponent)
    )
  }

  private async runMaintenance(now: number): Promise<void> {
    this.nextMaintenanceAt = now + this.policy.maintenanceIntervalMs
    if (!this.sink.maintain) return
    try {
      await this.sink.maintain(now)
    } catch (error) {
      this.reportError({ phase: 'maintenance', message: safeMessage(error) })
    }
  }

  private emit(): void {
    if (!this.listeners.size) return
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.reportError({ phase: 'lifecycle', message: `GPU monitor listener failed: ${safeMessage(error)}` })
      }
    }
  }

  private reportError(error: GpuMonitorError): void {
    try {
      this.onError?.(error)
    } catch {
      // Diagnostic callbacks never control or stop monitoring.
    }
  }
}
