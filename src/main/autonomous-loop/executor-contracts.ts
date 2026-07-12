import type { LoopExecutorSelection, LoopPlannedTask, LoopTokenUsage, LoopValidationResult } from './types'

export type LoopExecutorEventKind = 'status' | 'file' | 'tool' | 'summary'

export interface LoopExecutorEvent {
  kind: LoopExecutorEventKind
  occurredAt: number
  summary: string
  details?: Record<string, string | number | boolean | null>
}

export interface LoopRepairContext {
  attempt: number
  priorSummary: string
  validation: LoopValidationResult
}

export interface LoopExecutorRequest {
  workspacePath: string
  selection: LoopExecutorSelection
  task: LoopPlannedTask
  repositoryContext: string
  repair?: LoopRepairContext
  timeoutMs: number
  signal?: AbortSignal
  onEvent?: (event: LoopExecutorEvent) => void
}

export type LoopExecutorOutcome = 'completed' | 'failed' | 'cancelled' | 'unavailable'

export interface LoopExecutorResult {
  outcome: LoopExecutorOutcome
  summary: string
  changedFiles: string[]
  usage: LoopTokenUsage
  estimatedUsage: boolean
  durationMs: number
  rawOutput: string
  errorCode: string | null
  retryable: boolean
}

export interface LoopExecutorAdapter {
  readonly id: string
  supports(selection: LoopExecutorSelection): boolean
  execute(request: LoopExecutorRequest): Promise<LoopExecutorResult>
}

export const EMPTY_LOOP_USAGE: Readonly<LoopTokenUsage> = Object.freeze({
  input: 0,
  output: 0,
  cached: 0,
  costUsd: 0
})
