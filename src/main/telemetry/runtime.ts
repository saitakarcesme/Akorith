import { getDb, isDbReady } from '../db'
import { TelemetryStore } from './store'
import type { TelemetryEventInput } from './types'

let store: TelemetryStore | null = null

export function recordTelemetryEvent(input: TelemetryEventInput): void {
  if (!isDbReady()) return
  try {
    store ??= new TelemetryStore(getDb())
    store.record(input)
  } catch (error) {
    console.warn('[telemetry] event persistence failed:', error instanceof Error ? error.message : String(error))
  }
}

export function resetTelemetryRuntime(): void {
  store = null
}
