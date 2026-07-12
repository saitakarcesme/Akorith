import { BenchmarkAbortError, createBenchmarkAbortScope, raceBenchmarkAbort, throwIfBenchmarkAborted } from './cancellation'
import { deriveBenchmarkSeed, deterministicShuffle } from './random'
import { benchmarkCompatibilityKey, defaultBenchmarkRunConfiguration } from './comparability'
import type {
  BenchmarkClock,
  BenchmarkExecutorAdapter,
  BenchmarkFixture,
  BenchmarkFixtureRun,
  BenchmarkModelRun,
  BenchmarkModelRunMode,
  BenchmarkModelTarget,
  BenchmarkPlannerAdapter,
  BenchmarkRunConfiguration,
  BenchmarkSuite,
  BenchmarkValidatorAdapter,
  BenchmarkWorkspaceFactory
} from './types'
import {
  unavailableUsage,
  validateBenchmarkSuite,
  validateEvidence,
  validateExecutorOutput,
  validateBenchmarkRunConfiguration,
  validateModelTarget,
  validatePlannerOutput
} from './validation'

const DEFAULT_CLOCK: BenchmarkClock = {
  now: () => Date.now(),
  monotonic: () => performance.now()
}

export interface BenchmarkRunInput {
  runId: string
  suite: BenchmarkSuite
  target: BenchmarkModelTarget
  mode: BenchmarkModelRunMode
  planner: BenchmarkPlannerAdapter
  executor: BenchmarkExecutorAdapter
  validator: BenchmarkValidatorAdapter
  workspaceFactory: BenchmarkWorkspaceFactory
  signal?: AbortSignal
  seed?: number
  maxFixtureTimeoutMs?: number
  clock?: BenchmarkClock
  configuration?: BenchmarkRunConfiguration
  onFixtureComplete?(fixtureRun: BenchmarkFixtureRun): void | Promise<void>
}

function safeRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\0/g, '').slice(0, 4_000) || 'Unknown benchmark failure.'
}

function fixtureRunBase(
  runId: string,
  fixture: BenchmarkFixture,
  seed: number,
  timeoutMs: number,
  startedAt: number
): BenchmarkFixtureRun {
  const fixtureRunId = `${runId.slice(0, 105)}:${fixture.id.slice(0, 40)}:${seed.toString(16).padStart(8, '0')}`
  return {
    schemaVersion: 1,
    id: fixtureRunId,
    fixtureId: fixture.id,
    fixtureRevision: fixture.revision,
    category: fixture.category,
    seed,
    timeoutMs,
    status: 'queued',
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    planner: null,
    executor: null,
    plannerSummary: null,
    executorSummary: null,
    artifactReferences: [],
    evidence: null,
    errorCode: null,
    error: null
  }
}

function terminalModelStatus(fixtureRuns: readonly BenchmarkFixtureRun[], cancelled: boolean): BenchmarkModelRun['status'] {
  if (cancelled) return 'cancelled'
  const completed = fixtureRuns.filter((run) => run.status === 'completed').length
  if (completed === fixtureRuns.length && completed > 0) return 'completed'
  if (completed > 0) return 'partial'
  return 'failed'
}

function clampTimeout(fixture: BenchmarkFixture, suite: BenchmarkSuite, max: number | undefined): number {
  const fixtureTimeout = fixture.timeoutMs || suite.defaultTimeoutMs
  const maximum = Number.isSafeInteger(max) ? Math.min(Math.max(Number(max), 1_000), 3_600_000) : 3_600_000
  return Math.min(Math.max(fixtureTimeout, 1_000), maximum)
}

/**
 * Run one model against a complete suite. Correctness is established only by
 * independently validated evidence; executor prose is never treated as proof.
 */
export async function runBenchmarkModel(input: BenchmarkRunInput): Promise<BenchmarkModelRun> {
  if (!safeRunId(input.runId)) throw new Error('Benchmark run id is invalid.')
  const parsedSuite = validateBenchmarkSuite(input.suite)
  if (!parsedSuite.ok) throw new Error(`Benchmark suite is invalid: ${parsedSuite.errors.join('; ')}`)
  const parsedTarget = validateModelTarget(input.target)
  if (!parsedTarget.ok) throw new Error(`Benchmark target is invalid: ${parsedTarget.errors.join('; ')}`)
  if (input.mode !== 'production' && input.mode !== 'simulation') throw new Error('Benchmark mode is invalid.')
  const parsedConfiguration = validateBenchmarkRunConfiguration(
    input.configuration ?? defaultBenchmarkRunConfiguration(parsedTarget.value)
  )
  if (!parsedConfiguration.ok) {
    throw new Error(`Benchmark run configuration is invalid: ${parsedConfiguration.errors.join('; ')}`)
  }
  const configuration = parsedConfiguration.value
  if (!input.planner?.id || !input.executor?.id || !input.validator?.id || !input.validator.version) {
    throw new Error('Benchmark adapters must have stable identities and validator versioning.')
  }
  const seed = Number.isSafeInteger(input.seed) && Number(input.seed) >= 0 && Number(input.seed) <= 0xffffffff
    ? Number(input.seed)
    : parsedSuite.value.seed
  const clock = input.clock ?? DEFAULT_CLOCK
  const parentController = input.signal ? null : new AbortController()
  const signal = input.signal ?? parentController!.signal
  const startedAt = clock.now()
  const fixtureRuns: BenchmarkFixtureRun[] = []
  let cancelled = signal.aborted
  let modelError: string | null = null
  const orderedFixtures = deterministicShuffle(parsedSuite.value.fixtures, seed)

  for (const fixture of orderedFixtures) {
    if (signal.aborted) {
      cancelled = true
      break
    }
    const fixtureSeed = deriveBenchmarkSeed(seed, fixture.id, String(fixture.revision))
    const timeoutMs = clampTimeout(fixture, parsedSuite.value, input.maxFixtureTimeoutMs)
    const fixtureStartedAt = clock.now()
    const monotonicStartedAt = clock.monotonic()
    const run = fixtureRunBase(input.runId, fixture, fixtureSeed, timeoutMs, fixtureStartedAt)
    const scope = createBenchmarkAbortScope(signal, timeoutMs)
    let workspace: Awaited<ReturnType<BenchmarkWorkspaceFactory['prepare']>> | null = null

    try {
      throwIfBenchmarkAborted(scope.signal)
      workspace = await raceBenchmarkAbort(input.workspaceFactory.prepare(fixture, fixtureSeed, scope.signal), scope.signal)
      if (!workspace || typeof workspace.id !== 'string' || typeof workspace.dispose !== 'function' || workspace.sourceReadOnly !== true ||
        !['temporary_directory', 'container', 'memory'].includes(workspace.isolation)) {
        throw new Error('Workspace factory returned an invalid workspace handle.')
      }
      if (input.mode === 'production' && workspace.isolation === 'memory') {
        throw new Error('Production benchmark fixtures require an isolated temporary directory or container.')
      }
      if (workspace.isolation === 'temporary_directory' && (!workspace.rootPath || !workspace.rootPath.trim())) {
        throw new Error('Temporary benchmark workspace is missing its isolated root path.')
      }

      run.status = 'planning'
      const plannerStarted = clock.monotonic()
      const plannerValue = await raceBenchmarkAbort(
        input.planner.plan({ fixture, target: parsedTarget.value, workspace, seed: fixtureSeed, signal: scope.signal }),
        scope.signal
      )
      const parsedPlan = validatePlannerOutput(plannerValue)
      if (!parsedPlan.ok) throw new Error(`Planner adapter returned invalid output: ${parsedPlan.errors.join('; ')}`)
      run.planner = { latencyMs: Math.max(0, clock.monotonic() - plannerStarted), usage: parsedPlan.value.usage }
      run.plannerSummary = parsedPlan.value.summary

      run.status = 'executing'
      const executorStarted = clock.monotonic()
      const executorValue = await raceBenchmarkAbort(
        input.executor.execute({ fixture, target: parsedTarget.value, workspace, seed: fixtureSeed, signal: scope.signal, plan: parsedPlan.value }),
        scope.signal
      )
      const parsedExecution = validateExecutorOutput(executorValue)
      if (!parsedExecution.ok) throw new Error(`Executor adapter returned invalid output: ${parsedExecution.errors.join('; ')}`)
      run.executor = { latencyMs: Math.max(0, clock.monotonic() - executorStarted), usage: parsedExecution.value.usage }
      run.executorSummary = parsedExecution.value.summary
      run.artifactReferences = parsedExecution.value.artifactReferences
      if (parsedExecution.value.status === 'failed') {
        run.status = 'failed'
        run.errorCode = 'executor_failed'
        run.error = parsedExecution.value.error
      } else {
        run.status = 'validating'
        const evidenceValue = await raceBenchmarkAbort(
          input.validator.validate({
            fixture,
            target: parsedTarget.value,
            workspace,
            seed: fixtureSeed,
            signal: scope.signal,
            plan: parsedPlan.value,
            execution: parsedExecution.value
          }),
          scope.signal
        )
        const evidence = validateEvidence(evidenceValue, fixture, input.mode)
        if (!evidence.ok) {
          run.status = 'invalid_evidence'
          run.errorCode = 'invalid_validation_evidence'
          run.error = evidence.errors.join('; ').slice(0, 4_000)
        } else {
          run.evidence = evidence.value
          run.status = 'completed'
        }
      }
    } catch (error) {
      const abort = scope.classify(error)
      if (abort) {
        run.status = abort.code
        run.errorCode = abort.code
        run.error = abort.message
        cancelled = abort.code === 'cancelled'
      } else {
        run.status = 'failed'
        run.errorCode = 'adapter_error'
        run.error = boundedError(error)
      }
    } finally {
      scope.dispose()
      if (workspace) {
        try {
          await workspace.dispose()
        } catch (error) {
          if (run.status === 'completed') {
            run.status = 'failed'
            run.errorCode = 'workspace_cleanup_failed'
            run.error = boundedError(error)
            run.evidence = null
          }
        }
      }
      run.finishedAt = clock.now()
      run.durationMs = Math.max(0, clock.monotonic() - monotonicStartedAt)
      fixtureRuns.push(run)
      try {
        await input.onFixtureComplete?.(structuredClone(run))
      } catch (error) {
        modelError = `Fixture persistence callback failed: ${boundedError(error)}`
        break
      }
    }
    if (cancelled || modelError) break
  }

  const status = modelError ? (fixtureRuns.some((run) => run.status === 'completed') ? 'partial' : 'failed') : terminalModelStatus(fixtureRuns, cancelled)
  return {
    schemaVersion: 1,
    id: input.runId,
    suiteId: parsedSuite.value.id,
    suiteRevision: parsedSuite.value.revision,
    suiteSeed: seed,
    mode: input.mode,
    target: parsedTarget.value,
    configuration,
    compatibilityKey: benchmarkCompatibilityKey(configuration),
    status,
    startedAt,
    finishedAt: clock.now(),
    fixtureRuns,
    error: modelError
  }
}

export const BENCHMARK_UNAVAILABLE_USAGE = Object.freeze(unavailableUsage())

export function isBenchmarkAbort(error: unknown): error is BenchmarkAbortError {
  return error instanceof BenchmarkAbortError
}
