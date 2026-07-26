import {
  MAX_BENCHMARK_CONCURRENCY,
  boundedBenchmarkConcurrency,
  canTransitionBenchmarkQueue,
  canonicalTokenTotal,
  estimateRunDuration,
  runBoundedBenchmarkQueue,
  transitionBenchmarkQueueItem,
  type BenchmarkQueueItem
} from '../src/renderer/src/benchmark-core'

let passed = 0
const failures: string[] = []

function check(value: unknown, label: string): void {
  if (value) {
    passed++
    console.log(`[ok] ${label}`)
    return
  }
  failures.push(label)
  console.error(`[fail] ${label}`)
}

function equal<T>(actual: T, expected: T, label: string): void {
  check(Object.is(actual, expected), `${label} (expected ${String(expected)}, got ${String(actual)})`)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function verifyTokens(): Promise<void> {
  equal(
    canonicalTokenTotal({ totalTokens: 77, promptTokens: 100, completionTokens: 200 }),
    77,
    'canonical provider total wins over component counters'
  )
  equal(
    canonicalTokenTotal({
      promptTokens: 10,
      completionTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      reasoningTokens: 5
    }),
    27,
    'documented token components form the compatibility fallback'
  )
  equal(canonicalTokenTotal({ promptTokens: 0, completionTokens: 0 }), 0, 'reported zero differs from missing usage')
  equal(canonicalTokenTotal({}), null, 'missing token usage stays unknown')
  equal(
    canonicalTokenTotal({ promptTokens: Number.NaN, completionTokens: -4 }),
    null,
    'invalid token counters are not presented as zero'
  )
}

async function verifyDurationEstimates(): Promise<void> {
  const history = [
    { modelKey: 'local::a', durationMs: 100 },
    { modelKey: 'local::a', durationMs: 300 },
    { modelKey: 'claude::b', durationMs: 400 },
    { modelKey: 'ignored', durationMs: Number.NaN }
  ]
  const sequential = estimateRunDuration(
    ['local::a', 'claude::b', 'local::a'],
    history,
    { parallel: false }
  )
  equal(sequential.modelCount, 2, 'ETA deduplicates selected model keys')
  equal(sequential.models[0].durationMs, 200, 'ETA uses median model history')
  equal(sequential.totalMs, 600, 'sequential ETA sums model durations')
  equal(sequential.concurrency, 1, 'sequential ETA always uses one worker')

  const parallel = estimateRunDuration(
    ['a', 'b', 'c'],
    [
      { modelKey: 'a', durationMs: 100 },
      { modelKey: 'b', durationMs: 400 },
      { modelKey: 'c', durationMs: 200 }
    ],
    { parallel: true, concurrency: 2 }
  )
  equal(parallel.totalMs, 400, 'parallel ETA models bounded list scheduling')
  equal(parallel.concurrency, 2, 'parallel ETA reports effective concurrency')

  const unknown = estimateRunDuration(['known', 'new'], [{ modelKey: 'known', durationMs: 120 }], {
    parallel: false
  })
  equal(unknown.totalMs, null, 'ETA stays unknown when a selected model has no basis')
  equal(unknown.unknownModelKeys.join(','), 'new', 'ETA identifies models without history')

  const fallback = estimateRunDuration(['known', 'new'], [{ modelKey: 'known', durationMs: 120 }], {
    parallel: false,
    fallbackDurationMs: 500
  })
  equal(fallback.totalMs, 620, 'explicit fallback makes a mixed ETA calculable')
  equal(fallback.fallbackCount, 1, 'ETA reports fallback usage')
  equal(
    boundedBenchmarkConcurrency(99, 20),
    MAX_BENCHMARK_CONCURRENCY,
    'concurrency is capped at the production bound'
  )
}

async function verifyQueueTransitions(): Promise<void> {
  const queued: BenchmarkQueueItem<string, number> = {
    id: 'one',
    index: 0,
    input: 'model',
    status: 'queued',
    startedAt: null,
    finishedAt: null
  }
  const running = transitionBenchmarkQueueItem(queued, 'running', { now: 10 })
  const completed = transitionBenchmarkQueueItem(running, 'completed', { now: 25, result: 42 })

  check(canTransitionBenchmarkQueue('queued', 'running'), 'queued items may start')
  check(!canTransitionBenchmarkQueue('completed', 'running'), 'terminal queue states stay terminal')
  equal(running.startedAt, 10, 'running transition records start time')
  equal(completed.finishedAt, 25, 'terminal transition records finish time')
  equal(completed.result, 42, 'completed transition records its result')
  equal(queued.status, 'queued', 'queue transitions are immutable')

  let invalidRejected = false
  try {
    transitionBenchmarkQueueItem(completed, 'running')
  } catch {
    invalidRejected = true
  }
  check(invalidRejected, 'invalid terminal transition is rejected')
}

async function verifyBoundedExecution(): Promise<void> {
  let active = 0
  let peak = 0
  const started: number[] = []
  const queue = await runBoundedBenchmarkQueue(
    [0, 1, 2, 3, 4, 5],
    async (item) => {
      started.push(item)
      active++
      peak = Math.max(peak, active)
      await wait(8)
      active--
      return item * 2
    },
    { concurrency: 2 }
  )
  equal(peak, 2, 'bounded queue never exceeds requested concurrency')
  equal(started.length, 6, 'bounded queue launches every item when not cancelled')
  check(queue.every((item) => item.status === 'completed'), 'successful queue reaches completed state')
  equal(queue[5].result, 10, 'queue preserves result-to-input identity')

  const failed = await runBoundedBenchmarkQueue(
    ['ok', 'bad', 'after'],
    async (item) => {
      if (item === 'bad') throw new Error('expected failure')
      return item
    },
    { concurrency: 1 }
  )
  equal(failed[1].status, 'failed', 'worker rejection becomes a failed queue item')
  equal(failed[1].error, 'expected failure', 'failed queue item keeps an actionable error')
  equal(failed[2].status, 'completed', 'one failure does not silently discard the remaining queue')
}

async function verifyCancellationInvariant(): Promise<void> {
  const controller = new AbortController()
  const launched: number[] = []
  let releaseWorkers: (() => void) | null = null
  const release = new Promise<void>((resolve) => {
    releaseWorkers = resolve
  })

  const pending = runBoundedBenchmarkQueue(
    [0, 1, 2, 3, 4],
    async (item) => {
      launched.push(item)
      if (launched.length === 2) controller.abort()
      await release
      return item
    },
    { concurrency: 2, signal: controller.signal }
  )

  await wait(0)
  releaseWorkers?.()
  const cancelled = await pending

  equal(launched.join(','), '0,1', 'abort launches no queued work after the active cohort')
  check(cancelled.slice(0, 2).every((item) => item.status === 'cancelled'), 'late active results cannot overwrite cancellation')
  check(cancelled.slice(2).every((item) => item.status === 'cancelled'), 'queued work is cancelled without launching')

  const immediate = new AbortController()
  immediate.abort()
  let immediateLaunches = 0
  const preCancelled = await runBoundedBenchmarkQueue(
    [1, 2],
    async () => {
      immediateLaunches++
      return 1
    },
    { concurrency: 2, signal: immediate.signal }
  )
  equal(immediateLaunches, 0, 'pre-aborted queue launches no work')
  check(preCancelled.every((item) => item.status === 'cancelled'), 'pre-aborted queue exposes cancelled states')
}

async function main(): Promise<void> {
  await verifyTokens()
  await verifyDurationEstimates()
  await verifyQueueTransitions()
  await verifyBoundedExecution()
  await verifyCancellationInvariant()

  if (failures.length > 0) {
    console.error(`\nBenchmark verification failed: ${failures.length} finding(s).`)
    process.exit(1)
  }
  console.log(`\nBenchmark verification passed: ${passed} checks.`)
}

void main()
