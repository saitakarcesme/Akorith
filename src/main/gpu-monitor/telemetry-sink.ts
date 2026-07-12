import type Database from 'better-sqlite3'
import {
  DEFAULT_GPU_RETENTION_POLICY,
  recordGpuDetailSample,
  rollupAndPruneGpuSamples
} from '../telemetry/gpu-retention'
import type { GpuDetailSampleInput, GpuRetentionPolicy, GpuRetentionResult } from '../telemetry/types'
import type { GpuTelemetrySink } from './types'

/** Durable sink adapter for the unified telemetry detail and rollup tables. */
export class SqliteGpuTelemetrySink implements GpuTelemetrySink {
  private readonly policy: GpuRetentionPolicy

  constructor(private readonly database: Database.Database, policy: GpuRetentionPolicy = DEFAULT_GPU_RETENTION_POLICY) {
    this.policy = { ...policy }
  }

  writeSample(sample: GpuDetailSampleInput): void {
    recordGpuDetailSample(this.database, sample)
  }

  maintain(now: number): GpuRetentionResult {
    return rollupAndPruneGpuSamples(this.database, now, this.policy)
  }
}
