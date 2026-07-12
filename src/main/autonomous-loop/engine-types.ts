import type { RepositoryCheckpoint } from '../repository'
import type { LoopExecutorRequest, LoopExecutorResult } from './executor'
import type {
  AutonomousLoopRecord,
  LoopCycleRecord,
  LoopPlannedTask,
  LoopReviewResult,
  LoopTokenUsage,
  LoopValidationResult,
  ProjectFeatureInventory,
  RepositorySnapshot
} from './types'

export interface LoopModelDecision<T> {
  value: T
  usage: LoopTokenUsage
  estimated: boolean
  durationMs: number
  rawSummary: string
}

export interface LoopRepositorySession {
  checkpoint(): Promise<RepositoryCheckpoint>
  restore(checkpoint: RepositoryCheckpoint, paths: readonly string[]): Promise<string[]>
  commit(paths: readonly string[], message: string): Promise<{ sha: string; paths: string[] }>
  push(branch: string): Promise<void>
  heartbeat(): Promise<void>
  release(): Promise<void>
}

export interface AutonomousLoopEngineDependencies {
  acquireRepository(loop: AutonomousLoopRecord, signal?: AbortSignal): Promise<LoopRepositorySession>
  observe(loop: AutonomousLoopRecord, signal?: AbortSignal): Promise<RepositorySnapshot>
  buildInventory(snapshot: RepositorySnapshot): ProjectFeatureInventory
  plan(input: {
    loop: AutonomousLoopRecord
    snapshot: RepositorySnapshot
    inventory: ProjectFeatureInventory
    priorCycles: LoopCycleRecord[]
    signal?: AbortSignal
  }): Promise<LoopModelDecision<LoopPlannedTask>>
  execute(request: LoopExecutorRequest): Promise<LoopExecutorResult>
  validate(input: {
    loop: AutonomousLoopRecord
    snapshot: RepositorySnapshot
    task: LoopPlannedTask
    changedFiles: readonly string[]
    signal?: AbortSignal
  }): Promise<LoopValidationResult>
  review(input: {
    loop: AutonomousLoopRecord
    task: LoopPlannedTask
    validation: LoopValidationResult
    signal?: AbortSignal
  }): Promise<LoopModelDecision<LoopReviewResult>>
  delayMs: number
  now(): number
}

export interface LoopCycleRunResult {
  loopId: string
  cycleId: string | null
  outcome: 'pushed' | 'reverted' | 'paused' | 'stopped' | 'cancelled' | 'infrastructure-failure'
  nextCycleAt: number | null
  error: string | null
}
