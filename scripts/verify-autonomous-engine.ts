import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { AutonomousLoopEngine } from '../src/main/autonomous-loop/engine.ts'
import type { AutonomousLoopEngineDependencies, LoopRepositorySession } from '../src/main/autonomous-loop/engine-types.ts'
import { applyAutonomousLoopMigrations } from '../src/main/autonomous-loop/migrations.ts'
import { AutonomousLoopStore } from '../src/main/autonomous-loop/store.ts'
import type { AutonomousLoopRecord, LoopPlannedTask, RepositorySnapshot } from '../src/main/autonomous-loop/types.ts'

let assertions = 0
function check(value: unknown, message: string): asserts value {
  assert.ok(value, message)
  assertions += 1
}

const task: LoopPlannedTask = {
  title: 'Repair greeting behavior',
  proposedTask: 'Repair greeting behavior and add regression coverage.',
  reason: 'The feature inventory identifies a failing greeting contract.',
  expectedUserValue: 'Users receive the documented greeting.',
  likelyAreas: ['src/greeting.ts', 'tests/greeting.test.ts'],
  acceptanceCriteria: ['Greeting tests pass.'],
  validationCommands: ['npm test'],
  riskLevel: 'low',
  estimatedComplexity: 'small',
  kind: 'bug_fix'
}

function fixtureLoop(id: string, now: number): AutonomousLoopRecord {
  return {
    id,
    projectName: 'Engine fixture',
    status: 'running',
    stage: 'idle',
    repositoryId: `repository-${id}`,
    workspacePath: 'C:\\fixture',
    remoteUrl: 'https://github.com/example/fixture.git',
    branch: 'main',
    executor: {
      catalogId: 'local.fixture', providerId: 'local', model: 'fixture-coder', location: 'local',
      capabilityProbeId: 'probe-fixture'
    },
    planner: { catalogId: 'cloud.fixture', providerId: 'chatgpt', model: 'fixture-planner', location: 'cloud' },
    limits: {
      maxRepairAttempts: 2,
      maxConsecutiveInfrastructureFailures: 3,
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
}

function snapshot(loop: AutonomousLoopRecord, now: number): RepositorySnapshot {
  return {
    repositoryId: loop.repositoryId,
    capturedAt: now,
    headSha: 'a'.repeat(40),
    branch: 'main',
    dirty: false,
    fileCount: 2,
    files: ['src/greeting.ts', 'tests/greeting.test.ts'],
    languages: [{ name: 'TypeScript', files: 2 }],
    frameworks: [],
    packageManagers: ['npm'],
    packageScripts: { test: 'vitest run' },
    detectedCommands: [{ kind: 'test', command: 'npm test', source: 'package.json' }],
    readmeExcerpt: '# Fixture',
    recentCommits: ['initial fixture'],
    todoItems: [],
    buildStatus: 'unknown',
    testStatus: 'failing',
    dependencySignals: [],
    routes: [],
    components: []
  }
}

interface ScenarioState {
  commits: number
  pushes: number
  restores: number
  releases: number
  executions: number
  validations: number
  failValidationUntil: number
  failPushes: number
}

function setup(id: string, configure: Partial<ScenarioState> = {}) {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  applyAutonomousLoopMigrations(database)
  const store = new AutonomousLoopStore(database)
  let clock = 1_700_000_000_000
  const loop = fixtureLoop(id, clock)
  store.createLoop(loop)
  const state: ScenarioState = {
    commits: 0, pushes: 0, restores: 0, releases: 0, executions: 0, validations: 0,
    failValidationUntil: 0, failPushes: 0, ...configure
  }
  const repository: LoopRepositorySession = {
    async checkpoint() {
      return { repositoryPath: loop.workspacePath, headSha: 'a'.repeat(40), branch: 'main', createdAt: clock }
    },
    async restore(_checkpoint, paths) {
      state.restores += 1
      return [...paths]
    },
    async commit(paths, message) {
      state.commits += 1
      check(message === 'fix(loop): Repair greeting behavior', 'engine creates a conventional bounded commit message')
      return { sha: 'b'.repeat(40), paths: [...paths] }
    },
    async push() {
      state.pushes += 1
      if (state.failPushes > 0) {
        state.failPushes -= 1
        throw new Error('temporary remote outage')
      }
    },
    async heartbeat() {},
    async release() { state.releases += 1 }
  }
  const dependencies: AutonomousLoopEngineDependencies = {
    async acquireRepository() { return repository },
    async observe() { return snapshot(loop, ++clock) },
    buildInventory(value) {
      return {
        snapshotCapturedAt: value.capturedAt,
        generatedAt: ++clock,
        existingCapabilities: ['Greeting module'],
        incompleteCapabilities: [], brokenBehavior: ['Greeting contract'], technicalDebt: [],
        testGaps: ['Greeting regression'], documentationGaps: [], securityConcerns: [],
        performanceOpportunities: [], highValueNextSteps: ['Repair greeting behavior']
      }
    },
    async plan() {
      return {
        value: task,
        usage: { input: 100, output: 50, cached: 10, costUsd: 0 },
        estimated: false,
        durationMs: 20,
        rawSummary: 'Selected greeting repair.'
      }
    },
    async execute() {
      state.executions += 1
      return {
        outcome: 'completed',
        summary: state.executions === 1 ? 'Implemented greeting repair.' : 'Repaired validation failure.',
        changedFiles: ['src/greeting.ts', 'tests/greeting.test.ts'],
        usage: { input: 200, output: 100, cached: 20, costUsd: 0 },
        estimatedUsage: false,
        durationMs: 40,
        rawOutput: 'fixture executor output',
        errorCode: null,
        retryable: false
      }
    },
    async validate() {
      state.validations += 1
      const passed = state.validations > state.failValidationUntil
      return {
        passed,
        commands: [{
          kind: 'test', command: 'npm test', startedAt: ++clock, durationMs: 10,
          exitCode: passed ? 0 : 1, timedOut: false,
          stdout: passed ? '1 passed' : '', stderr: passed ? '' : '1 failed'
        }],
        changedFiles: ['src/greeting.ts', 'tests/greeting.test.ts'],
        regressionDetected: !passed,
        failureSummary: passed ? null : 'npm test: exit 1'
      }
    },
    async review() {
      return {
        value: {
          accepted: true,
          acceptanceCriteriaMet: ['Greeting tests pass.'],
          acceptanceCriteriaMissed: [], relevantDiff: true, placeholdersDetected: [],
          deletedTestsDetected: [], secretFindings: [], unrelatedFiles: [], generatedFilesReviewed: [],
          rationale: 'The focused diff is validated and relevant.'
        },
        usage: { input: 20, output: 10, cached: 0, costUsd: 0 },
        estimated: true,
        durationMs: 5,
        rawSummary: 'Accepted.'
      }
    },
    delayMs: 1_000,
    now: () => ++clock
  }
  return { database, store, loop, state, engine: new AutonomousLoopEngine(store, dependencies) }
}

async function main(): Promise<void> {
{
  const fixture = setup('success')
  const result = await fixture.engine.runCycle(fixture.loop.id)
  assert.equal(result.outcome, 'pushed'); assertions += 1
  const persisted = fixture.store.getLoop(fixture.loop.id)
  assert.equal(persisted?.commitCount, 1); assertions += 1
  assert.equal(persisted?.pushCount, 1); assertions += 1
  assert.equal(persisted?.successfulTasks, 1); assertions += 1
  check((persisted?.tokenUsage.input ?? 0) > 0, 'model token usage is accumulated')
  check(fixture.store.listEvents(fixture.loop.id).some((event) => event.kind === 'push-complete'), 'push completion is persisted')
  assert.equal(fixture.state.releases, 1); assertions += 1
  fixture.database.close()
}

{
  const fixture = setup('repair', { failValidationUntil: 1 })
  const result = await fixture.engine.runCycle(fixture.loop.id)
  assert.equal(result.outcome, 'pushed'); assertions += 1
  assert.equal(fixture.state.executions, 2); assertions += 1
  assert.equal(fixture.store.listCycles(fixture.loop.id)[0]?.repairAttempts, 1); assertions += 1
  check(fixture.store.listEvents(fixture.loop.id).some((event) => event.kind === 'repair-attempt'), 'repair attempt is persisted')
  fixture.database.close()
}

{
  const fixture = setup('revert', { failValidationUntil: 10 })
  const result = await fixture.engine.runCycle(fixture.loop.id)
  assert.equal(result.outcome, 'reverted'); assertions += 1
  assert.equal(fixture.state.executions, 3); assertions += 1
  assert.equal(fixture.state.restores, 1); assertions += 1
  assert.equal(fixture.store.getLoop(fixture.loop.id)?.status, 'running'); assertions += 1
  assert.equal(fixture.store.getLoop(fixture.loop.id)?.failedTasks, 1); assertions += 1
  fixture.database.close()
}

{
  const fixture = setup('push-recovery', { failPushes: 1 })
  const first = await fixture.engine.runCycle(fixture.loop.id)
  assert.equal(first.outcome, 'infrastructure-failure'); assertions += 1
  assert.equal(fixture.store.listCycles(fixture.loop.id)[0]?.status, 'committed'); assertions += 1
  const second = await fixture.engine.runCycle(fixture.loop.id)
  assert.equal(second.outcome, 'pushed'); assertions += 1
  assert.equal(fixture.state.commits, 1); assertions += 1
  assert.equal(fixture.state.pushes, 2); assertions += 1
  assert.equal(fixture.store.getLoop(fixture.loop.id)?.successfulTasks, 1); assertions += 1
  fixture.database.close()
}

{
  const fixture = setup('pause')
  fixture.store.setLoopState(fixture.loop.id, { status: 'pausing' })
  const result = await fixture.engine.runCycle(fixture.loop.id)
  assert.equal(result.outcome, 'paused'); assertions += 1
  assert.equal(fixture.store.getLoop(fixture.loop.id)?.status, 'paused'); assertions += 1
  assert.equal(fixture.state.executions, 0); assertions += 1
  fixture.database.close()
}

console.log(`verify-autonomous-engine: ${assertions} assertions passed`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
