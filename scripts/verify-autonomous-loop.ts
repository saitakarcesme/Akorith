import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { applyAutonomousLoopMigrations } from '../src/main/autonomous-loop/migrations.ts'
import { AutonomousLoopStore } from '../src/main/autonomous-loop/store.ts'
import type { AutonomousLoopRecord, LoopCycleRecord } from '../src/main/autonomous-loop/types.ts'

const database = new Database(':memory:')
database.pragma('foreign_keys = ON')

assert.deepEqual(applyAutonomousLoopMigrations(database), [1])
assert.deepEqual(applyAutonomousLoopMigrations(database), [])

const store = new AutonomousLoopStore(database)
const now = Date.now()
const loop: AutonomousLoopRecord = {
  id: 'loop-1',
  projectName: 'Fixture',
  status: 'running',
  stage: 'observing',
  repositoryId: 'repo-1',
  workspacePath: 'C:\\fixture',
  remoteUrl: 'https://github.com/example/fixture.git',
  branch: 'main',
  executor: {
    catalogId: 'local.fixture', providerId: 'local', model: 'fixture-coder', location: 'local',
    capabilityProbeId: 'probe-1'
  },
  planner: { catalogId: 'cloud.fixture', providerId: 'chatgpt', model: 'planner', location: 'cloud' },
  limits: {
    maxRepairAttempts: 3,
    maxConsecutiveInfrastructureFailures: 5,
    tokenLimit: null,
    costLimitUsd: null,
    validationTimeoutMs: 60_000
  },
  createdAt: now,
  updatedAt: now,
  startedAt: now,
  pausedAt: null,
  stoppedAt: null,
  completedAt: null,
  lastActivityAt: now,
  nextCycleAt: null,
  activeCycleId: null,
  consecutiveInfrastructureFailures: 0,
  tokenUsage: { input: 0, output: 0, cached: 0, costUsd: 0 },
  commitCount: 0,
  pushCount: 0,
  successfulTasks: 0,
  failedTasks: 0,
  stopReason: null,
  error: null
}
store.createLoop(loop)
assert.equal(store.getLoop(loop.id)?.projectName, 'Fixture')

const cycle: LoopCycleRecord = {
  id: 'cycle-1',
  loopId: loop.id,
  index: 1,
  status: 'running',
  stage: 'planning',
  plannedTask: null,
  executorCatalogId: loop.executor.catalogId,
  executorProviderId: loop.executor.providerId,
  executorModel: loop.executor.model,
  plannerCatalogId: loop.planner.catalogId,
  plannerProviderId: loop.planner.providerId,
  plannerModel: loop.planner.model,
  reviewerCatalogId: null,
  reviewerProviderId: null,
  reviewerModel: null,
  repairAttempts: 0,
  startedAt: now,
  finishedAt: null,
  durationMs: null,
  validation: null,
  review: null,
  changedFiles: [],
  commitSha: null,
  commitMessage: null,
  pushed: false,
  tokenUsage: { input: 0, output: 0, cached: 0, costUsd: 0 },
  summary: null,
  error: null
}
store.createCycle(cycle)
assert.equal(store.nextCycleIndex(loop.id), 2)
assert.equal(store.listCycles(loop.id)[0]?.id, cycle.id)

const snapshot = {
  repositoryId: loop.repositoryId,
  capturedAt: now,
  headSha: null,
  branch: 'main',
  dirty: false,
  fileCount: 1,
  files: ['README.md'],
  languages: [{ name: 'Markdown', files: 1 }],
  frameworks: [],
  packageManagers: [],
  packageScripts: {},
  detectedCommands: [],
  readmeExcerpt: '# Fixture',
  recentCommits: [],
  todoItems: [],
  buildStatus: 'unknown' as const,
  testStatus: 'not_configured' as const,
  dependencySignals: [],
  routes: [],
  components: []
}
store.saveSnapshot(loop.id, cycle.id, snapshot)
assert.equal(store.latestSnapshot(loop.id)?.fileCount, 1)

store.saveInventory(loop.id, cycle.id, {
  snapshotCapturedAt: now,
  generatedAt: now,
  existingCapabilities: ['README'],
  incompleteCapabilities: [],
  brokenBehavior: [],
  technicalDebt: [],
  testGaps: ['No tests configured'],
  documentationGaps: [],
  securityConcerns: [],
  performanceOpportunities: [],
  highValueNextSteps: ['Add a deterministic smoke test']
})
assert.equal(store.latestInventory(loop.id)?.testGaps[0], 'No tests configured')

store.appendEvent({
  loopId: loop.id,
  cycleId: cycle.id,
  occurredAt: now,
  stage: 'planning',
  level: 'info',
  kind: 'planner_started',
  title: 'Planning next task',
  summary: 'Selecting one safe, high-value task.',
  details: { cycle: 1 }
})
assert.equal(store.listEvents(loop.id).length, 1)

store.recordCommand(loop.id, cycle.id, 0, 0, {
  kind: 'test',
  command: 'npm test',
  startedAt: now,
  durationMs: 10,
  exitCode: 0,
  timedOut: false,
  stdout: 'ok',
  stderr: ''
})
store.recordModelCall({
  loopId: loop.id,
  cycleId: cycle.id,
  role: 'planner',
  providerId: 'chatgpt',
  model: 'planner',
  catalogId: 'cloud.fixture',
  location: 'cloud',
  durationMs: 12,
  tokenUsage: { input: 10, output: 5, cached: 0, costUsd: 0 },
  estimated: true,
  outcome: 'completed'
})
assert.equal((database.prepare('SELECT COUNT(*) AS count FROM autonomous_loop_commands').get() as { count: number }).count, 1)
assert.equal((database.prepare('SELECT COUNT(*) AS count FROM autonomous_loop_model_calls').get() as { count: number }).count, 1)

assert.equal(store.acquireLease({
  repositoryId: loop.repositoryId,
  loopId: loop.id,
  acquiredAt: now,
  heartbeatAt: now,
  expiresAt: now + 1_000,
  processId: 1
}, now), true)
assert.equal(store.acquireLease({
  repositoryId: loop.repositoryId,
  loopId: 'loop-2',
  acquiredAt: now,
  heartbeatAt: now,
  expiresAt: now + 1_000,
  processId: 2
}, now), false)
assert.equal(store.heartbeatLease(loop.repositoryId, loop.id, now + 100, now + 2_000), true)
assert.equal(store.releaseLease(loop.repositoryId, loop.id), true)

database.close()
process.stdout.write('verify-autonomous-loop: ok\n')
