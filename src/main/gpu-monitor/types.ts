import type { GpuDetailSampleInput, GpuRetentionResult } from '../telemetry/types'

export type GpuMonitorLocation = 'local' | 'remote'
export type GpuObservationStatus = 'observed' | 'unsupported' | 'disconnected' | 'unavailable'

export interface NormalizedGpuDevice {
  id: string
  name: string
  utilizationPercent?: number
  memoryUsedMb?: number
  memoryTotalMb?: number
  temperatureC?: number
  powerWatts?: number
  processName?: string
  activeModel?: string
}

export type GpuObservation =
  | {
      status: 'observed'
      observedAt: number
      devices: NormalizedGpuDevice[]
      warnings: string[]
    }
  | {
      status: Exclude<GpuObservationStatus, 'observed'>
      observedAt: number
      devices: []
      reason: string
      warnings: string[]
    }

/**
 * A source observes GPU state only. It cannot write telemetry or execute an
 * arbitrary command. Implementations must abort promptly when `signal` fires.
 */
export interface GpuSampleSource {
  readonly id: string
  readonly nodeId: string
  readonly location: GpuMonitorLocation
  sample(signal: AbortSignal): Promise<GpuObservation>
}

/** Structurally matches the durable telemetry GPU detail/rollup functions. */
export interface GpuTelemetrySink {
  writeSample(sample: GpuDetailSampleInput): Promise<void> | void
  maintain?(now: number): Promise<GpuRetentionResult | void> | GpuRetentionResult | void
}

export interface GpuMonitorPolicy {
  pollIntervalMs: number
  sourceTimeoutMs: number
  initialBackoffMs: number
  maxBackoffMs: number
  backoffMultiplier: number
  maintenanceIntervalMs: number
}

export interface GpuSourceState {
  sourceId: string
  nodeId: string
  location: GpuMonitorLocation
  consecutiveFailures: number
  nextPollAt: number
  lastObservation?: GpuObservation
}

export interface GpuPollResult {
  sourceId: string
  skipped: boolean
  samplesWritten: number
  duplicateSamplesSkipped: number
  state: GpuSourceState
}

export interface GpuMonitorSnapshot {
  running: boolean
  startedAt?: number
  sources: GpuSourceState[]
}

export type GpuMonitorErrorPhase = 'source' | 'sink' | 'maintenance' | 'lifecycle'

export interface GpuMonitorError {
  phase: GpuMonitorErrorPhase
  sourceId?: string
  message: string
}

export interface GpuMonitorTimer {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface GpuMonitorOptions {
  sources: readonly GpuSampleSource[]
  sink: GpuTelemetrySink
  policy?: Partial<GpuMonitorPolicy>
  timer?: GpuMonitorTimer
  onError?: (error: GpuMonitorError) => void
}
