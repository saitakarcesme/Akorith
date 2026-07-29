import assert from 'node:assert/strict'
import {
  KARPATHY_AUTORESEARCH_REF,
  extractMetric,
  extractPeakMemoryGb,
  metricImproved,
  normalizeEditablePaths,
  parseAutoresearchCommand,
  parseStoredAutoresearchResult,
  pathAllowed,
  starterExperimentConfig,
  validateMetricPattern
} from '../src/main/research/autoresearch-core.ts'
import type { ResearchCycle } from '../src/main/research/types.ts'

function main(): void {
  const starter = starterExperimentConfig()
  assert.equal(starter.target.kind, 'karpathy-starter')
  assert.match(KARPATHY_AUTORESEARCH_REF, /^[a-f0-9]{40}$/)
  assert.deepEqual(starter.command, {
    executable: 'uv',
    args: ['run', 'train.py'],
    display: 'uv run train.py'
  })
  assert.deepEqual(starter.editablePaths, ['train.py'])
  assert.equal(starter.metric.direction, 'minimize')

  assert.deepEqual(parseAutoresearchCommand('npm run "bench suite" -- --json'), {
    executable: 'npm',
    args: ['run', 'bench suite', '--', '--json'],
    display: 'npm run "bench suite" -- --json'
  })
  assert.throws(() => parseAutoresearchCommand('C:\\tools\\runner.exe --go'), /executable name/i)
  assert.throws(() => parseAutoresearchCommand('npm run test\nwhoami'), /one non-empty line/i)

  assert.deepEqual(normalizeEditablePaths(['./src/', 'src', 'bench\\score.ts']), ['src', 'bench/score.ts'])
  assert.throws(() => normalizeEditablePaths(['../outside']), /outside/i)
  assert.throws(() => normalizeEditablePaths(['.git/config']), /outside/i)
  assert.equal(pathAllowed('src/model.ts', ['src']), true)
  assert.equal(pathAllowed('prepare.py', ['train.py']), false)

  const pattern = validateMetricPattern('^score:\\s*([0-9]+(?:\\.[0-9]+)?)$')
  assert.equal(extractMetric('score: 1.25\nnoise\nscore: 1.5', pattern), 1.5)
  assert.equal(extractMetric('score unavailable', pattern), undefined)
  assert.equal(extractPeakMemoryGb('peak_vram_mb: 2048.0'), 2)
  assert.throws(() => validateMetricPattern('^(a+)+$'), /unsafe|capture/i)
  const catastrophicStartedAt = Date.now()
  assert.throws(
    () => extractMetric(`${'a'.repeat(500)}b`, '^(a|aa)+$'),
    /safety budget/i
  )
  assert.ok(Date.now() - catastrophicStartedAt < 1_000, 'catastrophic metric regex must be interrupted')

  assert.equal(metricImproved(0.9, 1, 'minimize'), true)
  assert.equal(metricImproved(1.1, 1, 'minimize'), false)
  assert.equal(metricImproved(11, 10, 'maximize'), true)
  assert.equal(metricImproved(9, 10, 'maximize'), false)

  const cycle: ResearchCycle = {
    id: 'cycle-1',
    jobId: 'job-1',
    cycleIndex: 1,
    phase: 'verify',
    status: 'completed',
    objective: 'baseline',
    result: JSON.stringify({
      version: 1,
      kind: 'baseline',
      status: 'keep',
      description: 'baseline',
      commit: 'abcdef1234567890',
      metric: 0.9979,
      durationMs: 300_000,
      changedFiles: []
    }),
    sourceCount: 0,
    findingCount: 0,
    startedAt: 1,
    endedAt: 2
  }
  assert.deepEqual(parseStoredAutoresearchResult(cycle), {
    version: 1,
    kind: 'baseline',
    status: 'keep',
    description: 'baseline',
    commit: 'abcdef1234567890',
    metric: 0.9979,
    previousBest: undefined,
    memoryGb: undefined,
    durationMs: 300_000,
    changedFiles: [],
    logFile: undefined,
    error: undefined
  })

  console.log('Autoresearch verifier passed (protocol, command boundary, metric, rollback decisions)')
}

main()
