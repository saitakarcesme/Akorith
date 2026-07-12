import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { DashboardTelemetryService } from '../src/main/dashboard/service'
import { applyTelemetryMigrations, TelemetryStore } from '../src/main/telemetry'

const DAY = 86_400_000
const now = new Date(2026, 6, 12, 12).getTime()
const database = new Database(':memory:')
applyTelemetryMigrations(database)
const store = new TelemetryStore(database)
let assertions = 0
const equal = (actual: unknown, expected: unknown, message: string): void => {
  assert.deepEqual(actual, expected, message)
  assertions += 1
}

function request(id: string, at: number, model: string, success: boolean, tokens: [number, number]): void {
  store.record({
    kind: success ? 'model_request_completed' : 'model_request_failed',
    requestId: id,
    occurredAt: at,
    providerId: model.startsWith('local') ? 'local' : 'chatgpt',
    model,
    location: model.startsWith('local') ? 'local' : 'cloud',
    taskType: 'code_edit',
    reasoningMode: 'high',
    durationMs: success ? 90_000 : undefined,
    metadata: { fastMode: id === 'one', skillId: id === 'one' ? 'github' : 'tests' }
  })
  store.record({
    kind: 'token_usage',
    requestId: id,
    occurredAt: at,
    providerId: model.startsWith('local') ? 'local' : 'chatgpt',
    model,
    location: model.startsWith('local') ? 'local' : 'cloud',
    taskType: 'code_edit',
    promptTokens: tokens[0],
    completionTokens: tokens[1]
  })
}

try {
  request('one', now - DAY, 'local-qwen', true, [80, 20])
  request('two', now, 'codex', true, [150, 50])
  request('three', now, 'codex', false, [30, 20])
  store.record({ kind: 'plugin_invocation', pluginId: 'github', outcome: 'completed', occurredAt: now, durationMs: 100 })

  const service = new DashboardTelemetryService({
    database,
    now: () => now,
    gpuSnapshot: () => ({
      running: true,
      sources: [{
        sourceId: 'local:nvidia-smi',
        nodeId: 'local',
        location: 'local',
        consecutiveFailures: 0,
        nextPollAt: now + 1_000,
        lastObservation: {
          status: 'observed',
          observedAt: now,
          devices: [{ id: 'gpu-0', name: 'Measured GPU', utilizationPercent: 42, memoryUsedMb: 1000, memoryTotalMb: 2000 }],
          warnings: []
        }
      }]
    })
  })
  const overview = service.overview() as Record<string, Record<string, unknown> | Array<Record<string, unknown>>>
  const summary = overview.summary as Record<string, unknown>
  equal(summary.lifetimeTokens, 350, 'lifetime tokens come from token events')
  equal(summary.peakDailyTokens, 250, 'peak tokens use the highest local day')
  equal(summary.longestTaskDurationMs, 90_000, 'longest completed task is measured')
  equal(summary.currentStreakDays, 2, 'current streak uses consecutive completed-task days')
  equal(summary.longestStreakDays, 2, 'longest streak is derived')
  const activity = overview.activity as Record<string, unknown>
  equal(activity.totalTasks, 3, 'completed and failed tasks are counted')
  equal(activity.successfulTasks, 2, 'successful tasks are counted')
  equal(activity.failedTasks, 1, 'failed tasks are counted')
  equal(activity.fastModeUsagePercent, 50, 'fast mode is evidence-backed')
  equal(activity.mostUsedReasoningMode, 'high', 'reasoning mode is aggregated')
  equal((overview.models as Array<Record<string, unknown>>)[0]?.model, 'codex', 'models are ranked by usage')
  equal((overview.plugins as Array<Record<string, unknown>>)[0]?.label, 'GitHub', 'plugin ids resolve to catalog labels')

  const daily = service.heatmap('daily') as { cells: Array<Record<string, unknown>> }
  equal(daily.cells.length, 365, 'daily heatmap covers twelve months')
  equal(daily.cells.at(-1)?.tokens, 250, 'daily cell keeps exact measured tokens')
  const weekly = service.heatmap('weekly') as { cells: Array<Record<string, unknown>> }
  assert.ok(weekly.cells.length >= 52 && weekly.cells.length <= 53)
  assertions += 1
  const cumulative = service.heatmap('cumulative') as { cells: Array<Record<string, unknown>> }
  equal(cumulative.cells.at(-1)?.tokens, 350, 'cumulative view preserves the measured total')

  const gpu = service.gpu() as { status: string; devices: Array<Record<string, unknown>> }
  equal(gpu.status, 'observed', 'GPU state is observed only with a real sample')
  equal(gpu.devices[0]?.name, 'Measured GPU', 'GPU identity comes from the monitor')
  equal(gpu.devices[0]?.utilizationPercent, 42, 'GPU utilization is not synthesized')
  assert.throws(() => service.heatmap('hourly' as never), /Unknown dashboard heatmap mode/)
  assertions += 1
  console.log(`Dashboard telemetry verification passed (${assertions} assertions).`)
} finally {
  database.close()
}
