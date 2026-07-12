import { createHash } from 'node:crypto'
import type { BenchmarkModelTarget, BenchmarkParameterValue, BenchmarkRunConfiguration } from './types'

export const BENCHMARK_HARNESS_VERSION = '1.0.0'

function sortRecord<T extends BenchmarkParameterValue | string>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)))
}

/**
 * Hardware and model identity are intentionally not part of this key: comparing
 * those is the purpose of a benchmark. Every workload-affecting harness setting is.
 */
export function benchmarkCompatibilityKey(configuration: BenchmarkRunConfiguration): string {
  const comparable = {
    schemaVersion: configuration.schemaVersion,
    harnessVersion: configuration.harnessVersion,
    instructionProfileId: configuration.instructionProfileId,
    maxAttempts: configuration.maxAttempts,
    temperature: configuration.temperature,
    providerParameters: sortRecord(configuration.providerParameters),
    unsupportedParameters: [...configuration.unsupportedParameters].sort(),
    repetitionCount: configuration.repetitionCount,
    dependencyVersions: sortRecord(configuration.dependencyVersions),
    environmentImage: configuration.environmentImage
  }
  return createHash('sha256').update(JSON.stringify(comparable), 'utf8').digest('hex')
}

export function defaultBenchmarkRunConfiguration(target: BenchmarkModelTarget): BenchmarkRunConfiguration {
  return {
    schemaVersion: 1,
    harnessVersion: BENCHMARK_HARNESS_VERSION,
    instructionProfileId: 'akorith-production-benchmark-v1',
    maxAttempts: 1,
    temperature: { support: 'unknown', requested: null, applied: null },
    providerParameters: {},
    unsupportedParameters: [],
    repetitionIndex: 1,
    repetitionCount: 1,
    hardware: {
      source: 'unavailable',
      platform: null,
      architecture: null,
      cpuModel: null,
      cpuLogicalCores: null,
      ramMb: null,
      gpuModel: null,
      vramMb: null,
      nodeId: target.nodeId
    },
    dependencyVersions: {},
    environmentImage: null
  }
}
