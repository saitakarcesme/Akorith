import { CliLoopExecutorAdapter } from './executor-cli'
import type { LoopExecutorAdapter, LoopExecutorRequest, LoopExecutorResult } from './executor-contracts'
import { StructuredPatchLoopExecutorAdapter, type StructuredExecutorClient } from './executor-structured'

export class AutonomousExecutorRouter {
  constructor(private readonly adapters: readonly LoopExecutorAdapter[]) {
    if (adapters.length === 0) throw new Error('At least one Loop executor adapter is required.')
  }

  execute(request: LoopExecutorRequest): Promise<LoopExecutorResult> {
    const adapter = this.adapters.find((candidate) => candidate.supports(request.selection))
    if (!adapter) {
      return Promise.resolve({
        outcome: 'unavailable',
        summary: 'No executor adapter supports the selected provider and location.',
        changedFiles: [], usage: { input: 0, output: 0, cached: 0, costUsd: 0 },
        estimatedUsage: false, durationMs: 0, rawOutput: '',
        errorCode: 'executor-unavailable', retryable: false
      })
    }
    return adapter.execute(request)
  }
}

export function createAutonomousExecutorRouter(structuredClient?: StructuredExecutorClient): AutonomousExecutorRouter {
  return new AutonomousExecutorRouter([
    new CliLoopExecutorAdapter(),
    new StructuredPatchLoopExecutorAdapter(structuredClient)
  ])
}

export type { LoopExecutorAdapter, LoopExecutorRequest, LoopExecutorResult } from './executor-contracts'
export type { StructuredExecutorClient, StructuredExecutorGeneration } from './executor-structured'

