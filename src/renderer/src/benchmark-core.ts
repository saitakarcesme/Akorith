/**
 * Pure Benchmark orchestration helpers.
 *
 * Keep this module free of React and Electron APIs. TestPage can use it to
 * calculate honest token/ETA summaries and to run an immutable, cancellable
 * queue without duplicating state-machine rules in the component.
 */

export interface BenchmarkUsageLike {
  promptTokens?: number
  completionTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

function validTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))
    : null
}

/**
 * Prefer the provider's canonical total. Components are only a compatibility
 * fallback because some CLIs do not report `totalTokens`.
 *
 * `null` means usage was not reported; it is intentionally different from a
 * provider explicitly reporting zero tokens.
 */
export function canonicalTokenTotal(usage: BenchmarkUsageLike | null | undefined): number | null {
  if (!usage) return null

  const canonical = validTokenCount(usage.totalTokens)
  if (canonical !== null) return canonical

  const components = [
    usage.promptTokens,
    usage.completionTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.reasoningTokens
  ].map(validTokenCount)
  if (components.every((value) => value === null)) return null

  return Math.min(
    Number.MAX_SAFE_INTEGER,
    components.reduce<number>((total, value) => total + (value ?? 0), 0)
  )
}

export interface BenchmarkDurationSample {
  modelKey: string
  durationMs: number
}

export interface BenchmarkDurationEstimateSettings {
  parallel: boolean
  concurrency?: number
  /** Optional documented fallback. Omit it rather than fabricating an ETA. */
  fallbackDurationMs?: number | null
}

export interface BenchmarkModelDurationEstimate {
  modelKey: string
  durationMs: number | null
  source: 'history' | 'fallback' | 'unknown'
}

export interface BenchmarkRunDurationEstimate {
  totalMs: number | null
  concurrency: number
  modelCount: number
  historyCount: number
  fallbackCount: number
  unknownModelKeys: string[]
  models: BenchmarkModelDurationEstimate[]
}

export const MAX_BENCHMARK_CONCURRENCY = 4

function positiveDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle]
}

export function boundedBenchmarkConcurrency(requested: number | undefined, itemCount: number): number {
  if (itemCount <= 0) return 0
  const normalized = typeof requested === 'number' && Number.isFinite(requested)
    ? Math.floor(requested)
    : 1
  return Math.min(Math.max(normalized, 1), MAX_BENCHMARK_CONCURRENCY, itemCount)
}

/**
 * Estimate wall-clock duration from the median history for each selected
 * model. Parallel estimates use the same bounded list-scheduling behavior as
 * `runBoundedBenchmarkQueue`.
 */
export function estimateRunDuration(
  selectedModelKeys: readonly string[],
  history: readonly BenchmarkDurationSample[],
  settings: BenchmarkDurationEstimateSettings
): BenchmarkRunDurationEstimate {
  const modelKeys = [...new Set(selectedModelKeys.filter((key) => key.trim().length > 0))]
  const fallbackDurationMs = positiveDuration(settings.fallbackDurationMs)
  const samplesByModel = new Map<string, number[]>()

  for (const sample of history) {
    const durationMs = positiveDuration(sample.durationMs)
    if (!sample.modelKey.trim() || durationMs === null) continue
    const samples = samplesByModel.get(sample.modelKey) ?? []
    samples.push(durationMs)
    samplesByModel.set(sample.modelKey, samples)
  }

  const models = modelKeys.map<BenchmarkModelDurationEstimate>((modelKey) => {
    const samples = samplesByModel.get(modelKey)
    if (samples?.length) return { modelKey, durationMs: median(samples), source: 'history' }
    if (fallbackDurationMs !== null) {
      return { modelKey, durationMs: fallbackDurationMs, source: 'fallback' }
    }
    return { modelKey, durationMs: null, source: 'unknown' }
  })
  const unknownModelKeys = models
    .filter((model) => model.durationMs === null)
    .map((model) => model.modelKey)
  const concurrency = settings.parallel
    ? boundedBenchmarkConcurrency(settings.concurrency, models.length)
    : boundedBenchmarkConcurrency(1, models.length)

  let totalMs: number | null = null
  if (models.length === 0) {
    totalMs = 0
  } else if (unknownModelKeys.length === 0) {
    const durations = models.map((model) => model.durationMs as number)
    if (concurrency <= 1) {
      totalMs = durations.reduce((total, durationMs) => total + durationMs, 0)
    } else {
      const lanes = Array.from({ length: concurrency }, () => 0)
      for (const durationMs of durations) {
        let nextLane = 0
        for (let lane = 1; lane < lanes.length; lane++) {
          if (lanes[lane] < lanes[nextLane]) nextLane = lane
        }
        lanes[nextLane] += durationMs
      }
      totalMs = Math.max(...lanes)
    }
  }

  return {
    totalMs,
    concurrency,
    modelCount: models.length,
    historyCount: models.filter((model) => model.source === 'history').length,
    fallbackCount: models.filter((model) => model.source === 'fallback').length,
    unknownModelKeys,
    models
  }
}

export type BenchmarkQueueStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface BenchmarkQueueItem<T, R = never> {
  id: string
  index: number
  input: T
  status: BenchmarkQueueStatus
  startedAt: number | null
  finishedAt: number | null
  result?: R
  error?: string
}

export interface BenchmarkQueueTransition<R> {
  now?: number
  result?: R
  error?: unknown
}

const QUEUE_TRANSITIONS: Record<BenchmarkQueueStatus, ReadonlySet<BenchmarkQueueStatus>> = {
  queued: new Set(['running', 'cancelled']),
  running: new Set(['completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
}

export function canTransitionBenchmarkQueue(
  from: BenchmarkQueueStatus,
  to: BenchmarkQueueStatus
): boolean {
  return QUEUE_TRANSITIONS[from].has(to)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

/** Apply one legal immutable queue transition. Terminal states stay terminal. */
export function transitionBenchmarkQueueItem<T, R>(
  item: BenchmarkQueueItem<T, R>,
  status: BenchmarkQueueStatus,
  transition: BenchmarkQueueTransition<R> = {}
): BenchmarkQueueItem<T, R> {
  if (!canTransitionBenchmarkQueue(item.status, status)) {
    throw new Error(`invalid benchmark queue transition: ${item.status} -> ${status}`)
  }
  const now = transition.now ?? Date.now()
  const next: BenchmarkQueueItem<T, R> = {
    ...item,
    status,
    startedAt: status === 'running' ? now : item.startedAt,
    finishedAt: status === 'running' ? null : now
  }
  if (status === 'completed') next.result = transition.result as R
  if (status === 'failed') next.error = errorMessage(transition.error)
  return next
}

export interface RunBoundedBenchmarkQueueOptions<T, R> {
  concurrency?: number
  signal?: AbortSignal
  idForItem?: (item: T, index: number) => string
  onTransition?: (queue: readonly BenchmarkQueueItem<T, R>[], changedIndex: number) => void
}

export type BenchmarkQueueWorker<T, R> = (
  item: T,
  index: number,
  signal: AbortSignal
) => Promise<R>

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Run a bounded queue. Once the supplied signal is aborted, no queued item is
 * launched. Active workers receive the same signal; even a worker that resolves
 * late is recorded as cancelled instead of overwriting the cancelled run.
 */
export async function runBoundedBenchmarkQueue<T, R>(
  inputs: readonly T[],
  worker: BenchmarkQueueWorker<T, R>,
  options: RunBoundedBenchmarkQueueOptions<T, R> = {}
): Promise<BenchmarkQueueItem<T, R>[]> {
  const internalController = options.signal ? null : new AbortController()
  const signal = options.signal ?? internalController!.signal
  const queue = inputs.map<BenchmarkQueueItem<T, R>>((input, index) => ({
    id: options.idForItem?.(input, index) ?? String(index),
    index,
    input,
    status: 'queued',
    startedAt: null,
    finishedAt: null
  }))
  const concurrency = boundedBenchmarkConcurrency(options.concurrency, queue.length)
  let nextIndex = 0

  const publish = (changedIndex: number): void => {
    if (!options.onTransition) return
    try {
      options.onTransition(queue.map((item) => ({ ...item })), changedIndex)
    } catch {
      // UI observers must never be able to break execution or cancellation.
    }
  }

  const transition = (
    index: number,
    status: BenchmarkQueueStatus,
    detail: BenchmarkQueueTransition<R> = {}
  ): void => {
    queue[index] = transitionBenchmarkQueueItem(queue[index], status, detail)
    publish(index)
  }

  const consume = async (): Promise<void> => {
    while (!signal.aborted && nextIndex < queue.length) {
      const index = nextIndex++
      transition(index, 'running')

      // An observer may synchronously abort in response to the running update.
      // Recheck immediately before calling user work to preserve no-new-launch.
      if (signal.aborted) {
        transition(index, 'cancelled')
        break
      }

      try {
        const result = await worker(queue[index].input, index, signal)
        transition(index, signal.aborted ? 'cancelled' : 'completed', { result })
      } catch (error) {
        transition(index, signal.aborted || isAbortError(error) ? 'cancelled' : 'failed', { error })
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => consume()))

  if (signal.aborted) {
    for (let index = 0; index < queue.length; index++) {
      if (queue[index].status === 'queued') transition(index, 'cancelled')
    }
  }

  return queue
}
