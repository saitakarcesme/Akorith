import { ipcMain } from 'electron'
import { getBenchmarkLabRuntime } from './production-runtime'
import type { BenchmarkServiceSetup } from './service-types'

function setup(value: unknown): BenchmarkServiceSetup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Benchmark setup is required.')
  const input = value as Record<string, unknown>
  if (typeof input.suiteId !== 'string' || !Array.isArray(input.modelIds) || !input.modelIds.every((id) => typeof id === 'string')) {
    throw new Error('Benchmark suite and model selections are invalid.')
  }
  return { suiteId: input.suiteId, modelIds: input.modelIds, seed: Number(input.seed), repetitions: Number(input.repetitions) }
}

function runId(value: unknown): string {
  if (typeof value !== 'string' || !/^bench-[A-Za-z0-9-]{8,80}$/.test(value)) throw new Error('A valid benchmark run id is required.')
  return value
}

export function registerBenchmarkLabIpc(): void {
  ipcMain.handle('benchmarkLab:catalog', () => getBenchmarkLabRuntime().getCatalog())
  ipcMain.handle('benchmarkLab:list', (_event, limit: unknown) => getBenchmarkLabRuntime().listRuns(typeof limit === 'number' ? limit : 20))
  ipcMain.handle('benchmarkLab:get', (_event, id: unknown) => getBenchmarkLabRuntime().getRun(runId(id)))
  ipcMain.handle('benchmarkLab:start', (_event, value: unknown) => getBenchmarkLabRuntime().start(setup(value)))
  ipcMain.handle('benchmarkLab:cancel', (_event, id: unknown) => getBenchmarkLabRuntime().cancel(runId(id)))
}
