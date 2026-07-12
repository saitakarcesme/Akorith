import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  TELEMETRY_EVENT_KINDS,
  TelemetryAggregator,
  TelemetryStore,
  applyTelemetryMigrations,
  backfillUsageEvents,
  calculateStreaks,
  listGpuRollups,
  recordGpuDetailSample,
  rollupAndPruneGpuSamples,
  validateTelemetryMetadata
} from '../src/main/telemetry/index.ts'

// better-sqlite3 is rebuilt for Electron in this repository. Run this verifier
// headlessly with Electron's Node mode so its native ABI matches:
//   $env:ELECTRON_RUN_AS_NODE='1'; .\node_modules\electron\dist\electron.exe -r tsx/cjs scripts/verify-telemetry.ts

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

function localDay(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dayAt(noon: number, offset: number): number {
  const date = new Date(noon)
  date.setDate(date.getDate() + offset)
  return date.getTime()
}

function verifyMigrationsAndBackfill(): void {
  const database = new Database(':memory:')
  try {
    database.exec(`
      CREATE TABLE usage_events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        cost_usd REAL,
        estimated INTEGER NOT NULL DEFAULT 0,
        session_id TEXT
      );
    `)
    database
      .prepare(
        `INSERT INTO usage_events
         (id, ts, provider_id, model, prompt_tokens, completion_tokens, cost_usd, estimated, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('legacy-1', 1_700_000_000_000, 'local', 'qwen-test', 12, 8, 0, 0, 'session-1')

    assert.deepEqual(applyTelemetryMigrations(database), [1, 2], 'all telemetry migrations apply once')
    assert.deepEqual(applyTelemetryMigrations(database), [], 'telemetry migrations are idempotent')
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM usage_events').get() as { count: number }).count, 1)

    const first = backfillUsageEvents(database, { batchSize: 1, maxRows: 1 })
    assert.deepEqual(first, { source: 'usage_events', processed: 1, remaining: 0 })
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM telemetry_backfill_markers').get() as { count: number }).count, 1)
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM telemetry_events').get() as { count: number }).count, 2)
    const tokens = database
      .prepare("SELECT prompt_tokens, completion_tokens FROM telemetry_events WHERE kind = 'token_usage'")
      .get() as { prompt_tokens: number; completion_tokens: number }
    assert.deepEqual(tokens, { prompt_tokens: 12, completion_tokens: 8 })
    assert.equal(backfillUsageEvents(database).processed, 0, 'backfill marker prevents duplicate events')
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM telemetry_events').get() as { count: number }).count, 2)
  } finally {
    database.close()
  }
}

function recordRequest(
  store: TelemetryStore,
  input: {
    requestId: string
    occurredAt: number
    providerId: string
    model: string
    location: 'local' | 'remote' | 'cloud'
    nodeId?: string
    taskType: 'planning' | 'code_edit' | 'debugging'
    success: boolean
    durationMs: number
    promptTokens: number
    completionTokens: number
    cachedTokens?: number
  }
): void {
  store.record({
    kind: input.success ? 'model_request_completed' : 'model_request_failed',
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    providerId: input.providerId,
    model: input.model,
    location: input.location,
    nodeId: input.nodeId,
    taskType: input.taskType,
    reasoningMode: input.taskType === 'planning' ? 'high' : 'medium',
    durationMs: input.durationMs,
    ...(input.success ? {} : { errorCode: 'fixture_failure' }),
    metadata: { fixture: true, nested: { bounded: 'yes' } }
  })
  store.record({
    kind: 'token_usage',
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    providerId: input.providerId,
    model: input.model,
    location: input.location,
    nodeId: input.nodeId,
    taskType: input.taskType,
    reasoningMode: input.taskType === 'planning' ? 'high' : 'medium',
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    cachedTokens: input.cachedTokens,
    costUsd: input.location === 'cloud' ? 0.01 : 0,
    estimated: false
  })
}

function verifyStoreAndAggregations(): void {
  const database = new Database(':memory:')
  try {
    applyTelemetryMigrations(database)
    const store = new TelemetryStore(database)
    const aggregator = new TelemetryAggregator(database)
    const now = new Date(2026, 6, 12, 12, 0, 0, 0).getTime()

    store.record({
      kind: 'model_request_started',
      requestId: 'request-start',
      occurredAt: dayAt(now, -6) - 1_000,
      providerId: 'local',
      model: 'qwen-code',
      location: 'local',
      nodeId: 'local',
      taskType: 'code_edit',
      reasoningMode: 'medium'
    })
    for (const offset of [-6, -5, -4]) {
      recordRequest(store, {
        requestId: `local-${offset}`,
        occurredAt: dayAt(now, offset),
        providerId: 'local',
        model: 'qwen-code',
        location: 'local',
        nodeId: 'local',
        taskType: 'code_edit',
        success: true,
        durationMs: 2_000,
        promptTokens: 100,
        completionTokens: 50,
        cachedTokens: 10
      })
    }
    for (const offset of [-1, 0]) {
      recordRequest(store, {
        requestId: `cloud-${offset}`,
        occurredAt: dayAt(now, offset),
        providerId: 'chatgpt',
        model: 'gpt-code',
        location: 'cloud',
        taskType: 'planning',
        success: true,
        durationMs: 3_000,
        promptTokens: 200,
        completionTokens: 80,
        cachedTokens: 25
      })
    }
    recordRequest(store, {
      requestId: 'failed-today',
      occurredAt: now + 1_000,
      providerId: 'claude',
      model: 'claude-code',
      location: 'cloud',
      taskType: 'debugging',
      success: false,
      durationMs: 1_500,
      promptTokens: 40,
      completionTokens: 0
    })

    store.record({ kind: 'plugin_invocation', pluginId: 'github', outcome: 'completed', occurredAt: now, durationMs: 120 })
    store.record({ kind: 'plugin_invocation', pluginId: 'github', outcome: 'failed', occurredAt: now, durationMs: 80 })
    store.record({ kind: 'loop_cycle', loopId: 'loop-1', outcome: 'completed', occurredAt: now, cycleIndex: 1 })
    store.record({
      kind: 'benchmark_task',
      benchmarkRunId: 'benchmark-1',
      benchmarkTaskId: 'task-1',
      suiteId: 'repo-repair',
      suiteVersion: '1.0.0',
      outcome: 'completed',
      occurredAt: now
    })
    store.record({ kind: 'git_commit', repositoryId: 'repo-1', outcome: 'completed', commitSha: 'abc1234', occurredAt: now })
    store.record({ kind: 'git_push', repositoryId: 'repo-1', outcome: 'completed', remoteName: 'origin', branch: 'main', occurredAt: now })

    const validMetadata = validateTelemetryMetadata({ a: [1, true, null], nested: { value: 'ok' } })
    assert.equal(validMetadata.ok, true)
    assert.equal(validateTelemetryMetadata({ huge: 'x'.repeat(20_000) }).ok, false, 'oversized metadata is rejected')
    assert.throws(
      () => store.record({ kind: 'plugin_invocation', pluginId: 'github', outcome: 'completed', metadata: { huge: 'x'.repeat(20_000) } }),
      /metadata|characters|bytes/
    )

    const range = { since: dayAt(now, -7), until: now + HOUR }
    const daily = aggregator.daily(range)
    assert.equal(aggregator.daily().length, daily.length, 'unbounded daily aggregation accepts an empty parameter set')
    assert.equal(daily.length, 5, 'daily aggregation emits only active days')
    assert.equal(daily.find((row) => row.day === localDay(now))?.completedTasks, 1)
    assert.equal(daily.find((row) => row.day === localDay(now))?.failedTasks, 1)
    assert.equal(daily.find((row) => row.day === localDay(now))?.primaryModel, 'gpt-code')

    const models = aggregator.byModel(range)
    assert.equal(aggregator.byModel().length, models.length)
    assert.equal(models.find((row) => row.model === 'qwen-code')?.runs, 3)
    assert.equal(models.find((row) => row.model === 'qwen-code')?.totalTokens, 450)
    assert.equal(models.find((row) => row.model === 'gpt-code')?.cachedTokens, 50)
    assert.equal(models.find((row) => row.model === 'claude-code')?.failedRuns, 1)

    const plugins = aggregator.byPlugin(range)
    assert.deepEqual(plugins[0], {
      pluginId: 'github',
      runs: 2,
      successfulRuns: 1,
      failedRuns: 1,
      totalDurationMs: 200
    })
    const tasks = aggregator.byTask(range)
    assert.equal(tasks.find((row) => row.taskType === 'code_edit')?.successfulRuns, 3)
    assert.equal(tasks.find((row) => row.taskType === 'planning')?.totalTokens, 560)
    assert.equal(tasks.find((row) => row.taskType === 'debugging')?.failedRuns, 1)

    assert.deepEqual(aggregator.streaks(now), { currentStreak: 2, longestStreak: 3 })
    assert.deepEqual(calculateStreaks(['2026-07-01', '2026-07-02', '2026-07-04'], '2026-07-05'), {
      currentStreak: 0,
      longestStreak: 2
    })
    const heatmap = aggregator.heatmap(10, now)
    assert.equal(heatmap.length, 10)
    assert.equal(heatmap.at(-1)?.day, localDay(now))
    assert.ok((heatmap.find((cell) => cell.day === localDay(now))?.intensity ?? 0) > 0)

    const gpuPolicy = { detailRetentionMs: 2 * DAY, rollupRetentionMs: 30 * DAY, bucketMs: HOUR }
    const oldBucket = Math.floor((now - 3 * DAY) / HOUR) * HOUR
    recordGpuDetailSample(database, {
      occurredAt: oldBucket + 5_000,
      nodeId: 'local',
      deviceId: 'gpu-0',
      deviceName: 'Fixture GPU',
      utilizationPercent: 20,
      memoryUsedMb: 1_000,
      memoryTotalMb: 24_000,
      temperatureC: 50,
      powerWatts: 100,
      model: 'qwen-code',
      processName: 'ollama'
    })
    recordGpuDetailSample(database, {
      occurredAt: oldBucket + 10_000,
      nodeId: 'local',
      deviceId: 'gpu-0',
      deviceName: 'Fixture GPU',
      utilizationPercent: 60,
      memoryUsedMb: 2_000,
      memoryTotalMb: 24_000,
      temperatureC: 60,
      powerWatts: 140
    })
    recordGpuDetailSample(database, {
      occurredAt: now - HOUR,
      nodeId: 'local',
      deviceId: 'gpu-0',
      deviceName: 'Fixture GPU',
      utilizationPercent: 30
    })
    recordGpuDetailSample(database, {
      occurredAt: now - 40 * DAY,
      nodeId: 'local',
      deviceId: 'gpu-0',
      deviceName: 'Fixture GPU',
      utilizationPercent: 10
    })

    const retention = rollupAndPruneGpuSamples(database, now, gpuPolicy)
    assert.equal(retention.samplesRolledUp, 2)
    assert.equal(retention.detailSamplesDeleted, 3)
    assert.equal(retention.aggregateEventsAdded, 1)
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM telemetry_gpu_samples').get() as { count: number }).count, 1)
    const rollups = listGpuRollups(database)
    assert.equal(rollups.length, 1)
    assert.equal(rollups[0].sampleCount, 2)
    assert.equal(rollups[0].averageUtilizationPercent, 40)
    assert.deepEqual(rollupAndPruneGpuSamples(database, now, gpuPolicy), {
      samplesRolledUp: 0,
      detailSamplesDeleted: 0,
      rollupsDeleted: 0,
      aggregateEventsAdded: 0
    })

    const kinds = new Set(store.list({ since: 0, limit: 500 }).map((event) => event.kind))
    assert.deepEqual([...TELEMETRY_EVENT_KINDS].filter((kind) => !kinds.has(kind)), [], 'every required event kind is recordable')
  } finally {
    database.close()
  }
}

verifyMigrationsAndBackfill()
verifyStoreAndAggregations()
console.log('verify-telemetry: ok')
