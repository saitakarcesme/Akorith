import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  BenchmarkStore,
  applyBenchmarkMigrations,
  benchmarkCompatibilityKey,
  defaultBenchmarkRunConfiguration,
  deriveBenchmarkSeed,
  getProductionBenchmarkSuite,
  type BenchmarkModelRun,
  type BenchmarkModelTarget
} from '../src/main/benchmark-lab/index'

const database = new Database(':memory:')
database.pragma('foreign_keys = ON')
assert.deepEqual(applyBenchmarkMigrations(database), [1])
assert.deepEqual(applyBenchmarkMigrations(database), [])

const store = new BenchmarkStore(database)
const suite = store.saveSuite(getProductionBenchmarkSuite())
assert.equal(store.getSuite(suite.id, suite.revision)?.fixtures.length, suite.fixtures.length)
assert.throws(() => store.saveSuite({ ...suite, name: 'Silently changed suite' }), /immutable/)

const target: BenchmarkModelTarget = {
  catalogModelId: 'local:store-fixture',
  providerId: 'local',
  model: 'store-fixture',
  location: 'local',
  nodeId: null,
  quantization: null,
  contextWindowTokens: 32_768
}
const configuration = defaultBenchmarkRunConfiguration(target)
const startedAt = 1_800_000_000_000
const run: BenchmarkModelRun = {
  schemaVersion: 1,
  id: 'benchmark-store-run',
  suiteId: suite.id,
  suiteRevision: suite.revision,
  suiteSeed: suite.seed,
  mode: 'simulation',
  target,
  configuration,
  compatibilityKey: benchmarkCompatibilityKey(configuration),
  status: 'completed',
  startedAt,
  finishedAt: startedAt + 1_000,
  fixtureRuns: suite.fixtures.map((fixture, index) => ({
    schemaVersion: 1,
    id: `store:${index}:${fixture.id}`,
    fixtureId: fixture.id,
    fixtureRevision: fixture.revision,
    category: fixture.category,
    seed: deriveBenchmarkSeed(suite.seed, fixture.id, String(fixture.revision)),
    timeoutMs: fixture.timeoutMs,
    status: 'completed',
    startedAt: startedAt + index,
    finishedAt: startedAt + index + 10,
    durationMs: 10,
    planner: { latencyMs: 2, usage: { source: 'unavailable', inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null } },
    executor: { latencyMs: 5, usage: { source: 'reported', inputTokens: 10, outputTokens: 4, cachedTokens: 0, costUsd: 0 } },
    plannerSummary: 'Store fixture plan.',
    executorSummary: 'Store fixture execution.',
    artifactReferences: [],
    evidence: {
      schemaVersion: 1,
      validatorId: 'store-validator',
      validatorVersion: '1',
      fixtureId: fixture.id,
      fixtureRevision: fixture.revision,
      capturedAt: startedAt + index + 9,
      simulated: true,
      observations: fixture.validation.map((requirement) => ({
        requirementId: requirement.id,
        passed: true,
        observedAt: startedAt + index + 9,
        source: 'deterministic_mock',
        summary: 'Persisted contract evidence.',
        process: null,
        filesystem: null
      })),
      logsDigest: null
    },
    errorCode: null,
    error: null
  })),
  error: null
}

store.saveModelRun(run)
assert.equal(store.getModelRun(run.id)?.fixtureRuns.length, suite.fixtures.length)
assert.equal(store.listModelRuns({ suiteId: suite.id })[0]?.id, run.id)
assert.equal(store.listModelRuns({ catalogModelId: target.catalogModelId })[0]?.id, run.id)
store.saveModelRun(run)
assert.throws(() => store.saveModelRun({ ...run, target: { ...target, model: 'changed' } }), /identity is immutable/)
assert.throws(() => store.saveModelRun({ ...run, status: 'failed' }), /terminal benchmark model run is immutable/)

database.close()
process.stdout.write(`verify-benchmark-store: PASS (${suite.fixtures.length} fixture rows)\n`)
