import type Database from 'better-sqlite3'
import { GpuMonitor } from './monitor'
import { NvidiaSmiGpuSource } from './nvidia-smi'
import { SqliteGpuTelemetrySink } from './telemetry-sink'
import type { GpuMonitorSnapshot, GpuSampleSource } from './types'

let monitor: GpuMonitor | null = null

export function startGpuMonitor(database: Database.Database, remoteSources: readonly GpuSampleSource[] = []): GpuMonitor {
  if (monitor) return monitor
  monitor = new GpuMonitor({
    sources: [new NvidiaSmiGpuSource(), ...remoteSources],
    sink: new SqliteGpuTelemetrySink(database),
    onError: (error) => console.warn('[gpu-monitor]', error.phase, error.sourceId ?? 'runtime', error.message)
  })
  monitor.start()
  return monitor
}

export function getGpuMonitorSnapshot(): GpuMonitorSnapshot {
  return monitor?.getSnapshot() ?? { running: false, sources: [] }
}

export async function stopGpuMonitor(): Promise<void> {
  const current = monitor
  monitor = null
  await current?.stop()
}
