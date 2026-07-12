import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BENCHMARK_CATEGORIES,
  BENCHMARK_LANGUAGES,
  analyzeBenchmarkRuns,
  benchmarkCompatibilityKey,
  deriveBenchmarkSeed,
  deterministicShuffle,
  createTemporaryBenchmarkWorkspaceFactory,
  getProductionBenchmarkSuite,
  runBenchmarkModel,
  scoreBenchmarkRun,
  validateBenchmarkModelRun,
  validateBenchmarkSuite,
  validateUsageMetadata,
  type BenchmarkClock,
  type BenchmarkExecutorAdapter,
  type BenchmarkModelRun,
  type BenchmarkModelTarget,
  type BenchmarkPlannerAdapter,
  type BenchmarkValidationEvidence,
  type BenchmarkValidatorAdapter,
  type BenchmarkWorkspaceFactory
} from '../src/main/benchmark-lab/index'

class DeterministicClock implements BenchmarkClock {
  private wall = 1_800_000_000_000
  private elapsed = 0
  now(): number { return this.wall + this.elapsed }
  monotonic(): number { return this.elapsed }
  advance(milliseconds: number): void { this.elapsed += milliseconds }
}

const suite = getProductionBenchmarkSuite()
const alpha: BenchmarkModelTarget = {
  catalogModelId: 'local:alpha',
  providerId: 'local',
  model: 'alpha',
  location: 'local',
  nodeId: null,
  quantization: 'Q8_0',
  contextWindowTokens: 32_768
}
const beta: BenchmarkModelTarget = {
  catalogModelId: 'remote:beta',
  providerId: 'remote',
  model: 'beta',
  location: 'remote',
  nodeId: 'node-beta',
  quantization: 'Q4_K_M',
  contextWindowTokens: 65_536
}

function createAdapters(clock: DeterministicClock): {
  planner: BenchmarkPlannerAdapter
  executor: BenchmarkExecutorAdapter
  validator: BenchmarkValidatorAdapter
  workspaces: BenchmarkWorkspaceFactory
  disposals: string[]
} {
  const disposals: string[] = []
  return {
    planner: {
      id: 'offline-planner-v1',
      async plan({ fixture, seed }) {
        clock.advance(4)
        return {
          plan: `Use fixture ${fixture.id} with seed ${seed}.`,
          summary: 'Deterministic offline plan.',
          usage: { source: 'reported', inputTokens: 10, outputTokens: 4, cachedTokens: 0, costUsd: 0 }
        }
      }
    },
    executor: {
      id: 'offline-executor-v1',
      async execute({ target, fixture }) {
        clock.advance(target.model === 'alpha' ? 11 : 17)
        return {
          status: 'completed',
          summary: `Deterministic ${target.model} execution for ${fixture.id}.`,
          artifactReferences: [`workspace:${fixture.id}`],
          usage: { source: 'reported', inputTokens: 20, outputTokens: 8, cachedTokens: 2, costUsd: target.model === 'alpha' ? 0 : 0.002 },
          error: null
        }
      }
    },
    validator: {
      id: 'offline-validator',
      version: '1.0.0',
      async validate({ target, fixture }): Promise<BenchmarkValidationEvidence> {
        clock.advance(3)
        return {
          schemaVersion: 1,
          validatorId: 'offline-validator',
          validatorVersion: '1.0.0',
          fixtureId: fixture.id,
          fixtureRevision: fixture.revision,
          capturedAt: clock.now(),
          simulated: true,
          observations: fixture.validation.map((requirement, index) => ({
            requirementId: requirement.id,
            passed: target.model === 'alpha' || index > 0,
            observedAt: clock.now(),
            source: 'deterministic_mock',
            summary: target.model === 'alpha' || index > 0 ? 'Deterministic check passed.' : 'Deterministic check failed.',
            process: null,
            filesystem: null
          })),
          logsDigest: null
        }
      }
    },
    workspaces: {
      async prepare(fixture, seed) {
        clock.advance(1)
        return {
          id: `${fixture.id}:${seed}`,
          rootPath: null,
          isolation: 'memory',
          sourceReadOnly: true,
          async dispose() { disposals.push(fixture.id) }
        }
      }
    },
    disposals
  }
}

async function runSimulation(runId: string, target: BenchmarkModelTarget): Promise<{ run: BenchmarkModelRun; order: string[]; seeds: number[]; disposals: string[] }> {
  const clock = new DeterministicClock()
  const adapters = createAdapters(clock)
  const run = await runBenchmarkModel({
    runId,
    suite,
    target,
    mode: 'simulation',
    planner: adapters.planner,
    executor: adapters.executor,
    validator: adapters.validator,
    workspaceFactory: adapters.workspaces,
    clock
  })
  return { run, order: run.fixtureRuns.map((fixture) => fixture.fixtureId), seeds: run.fixtureRuns.map((fixture) => fixture.seed), disposals: adapters.disposals }
}

let checks = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  checks += 1
}

async function main(): Promise<void> {
  const parsedSuite = validateBenchmarkSuite(suite)
  check(parsedSuite.ok, 'production suite schema is valid')
  check(new Set(suite.fixtures.map((fixture) => fixture.category)).size === BENCHMARK_CATEGORIES.length, 'all eight benchmark categories are present')
  check(BENCHMARK_CATEGORIES.every((category) => suite.fixtures.some((fixture) => fixture.category === category)), 'every declared category has a fixture')
  const multiLanguages = new Set(suite.fixtures.filter((fixture) => fixture.category === 'multi_language').flatMap((fixture) => fixture.languages))
  check(BENCHMARK_LANGUAGES.every((language) => multiLanguages.has(language)), 'C++, Go, Java, JavaScript, TypeScript, Python, and Rust are covered')

  const firstOrder = deterministicShuffle(suite.fixtures.map((fixture) => fixture.id), suite.seed)
  const secondOrder = deterministicShuffle(suite.fixtures.map((fixture) => fixture.id), suite.seed)
  check(JSON.stringify(firstOrder) === JSON.stringify(secondOrder), 'fixture shuffle is reproducible')
  check(deriveBenchmarkSeed(suite.seed, 'fixture-a') === deriveBenchmarkSeed(suite.seed, 'fixture-a'), 'derived fixture seeds are reproducible')
  check(deriveBenchmarkSeed(suite.seed, 'fixture-a') !== deriveBenchmarkSeed(suite.seed, 'fixture-b'), 'fixture identities perturb the seed')

  const temporaryFactory = createTemporaryBenchmarkWorkspaceFactory()
  const temporaryWorkspace = await temporaryFactory.prepare(suite.fixtures[0], suite.fixtures[0].seed, new AbortController().signal)
  check(temporaryWorkspace.isolation === 'temporary_directory' && temporaryWorkspace.sourceReadOnly, 'production workspace factory creates an isolated source-safe copy')
  const firstFile = suite.fixtures[0].workspaceFiles[0]
  check(await readFile(join(temporaryWorkspace.rootPath!, firstFile.path), 'utf8') === firstFile.content, 'fixture files are materialized exactly in the isolated workspace')
  const removedPath = temporaryWorkspace.rootPath!
  await temporaryWorkspace.dispose()
  await assert.rejects(access(removedPath))
  checks += 1

  const alphaOne = await runSimulation('verify-alpha-one', alpha)
  const alphaTwo = await runSimulation('verify-alpha-two', alpha)
  const betaRun = await runSimulation('verify-beta', beta)
  check(alphaOne.run.status === 'completed' && betaRun.run.status === 'completed', 'deterministic mock adapters complete the suite')
  check(JSON.stringify(alphaOne.order) === JSON.stringify(alphaTwo.order), 'independent model runs use identical fixture order')
  check(JSON.stringify(alphaOne.seeds) === JSON.stringify(alphaTwo.seeds), 'independent model runs use identical per-fixture seeds')
  check(alphaOne.disposals.length === suite.fixtures.length, 'every prepared workspace is disposed')
  check(validateBenchmarkModelRun(alphaOne.run, suite).ok, 'completed model-run schema validates')

  const productionAnalysis = analyzeBenchmarkRuns(suite, [alphaOne.run, betaRun.run])
  check(productionAnalysis.rankings.length === 0, 'simulation runs are excluded from production rankings')
  check(productionAnalysis.excludedRuns.length === 2, 'simulation exclusions carry explicit reasons')
  const simulationAnalysis = analyzeBenchmarkRuns(suite, [betaRun.run, alphaOne.run], { includeSimulated: true })
  check(simulationAnalysis.rankings.length === 2, 'simulation results can be analyzed only by explicit opt-in')
  check(simulationAnalysis.rankings[0].catalogModelId === alpha.catalogModelId, 'validated higher-scoring model ranks first')
  check(simulationAnalysis.categoryRecommendations.length === BENCHMARK_CATEGORIES.length, 'a model-fit recommendation is produced for each covered category')
  check(simulationAnalysis.modelFit[0].strongestCategories.length === BENCHMARK_CATEGORIES.length, 'category leaders surface as model strengths')
  check(Object.values(simulationAnalysis.policy.categoryWeights).reduce((sum, weight) => sum + weight, 0) === 1, 'transparent category weights sum to one')

  const incompatibleRun = structuredClone(betaRun.run)
  incompatibleRun.id = 'verify-beta-incompatible'
  incompatibleRun.configuration.instructionProfileId = 'different-system-instructions'
  incompatibleRun.compatibilityKey = benchmarkCompatibilityKey(incompatibleRun.configuration)
  const incompatibleAnalysis = analyzeBenchmarkRuns(suite, [alphaOne.run, incompatibleRun], {
    includeSimulated: true,
    expectedCompatibilityKey: alphaOne.run.compatibilityKey
  })
  check(incompatibleAnalysis.rankings.length === 1 && incompatibleAnalysis.excludedRuns[0]?.runId === incompatibleRun.id, 'incompatible system settings are never silently compared')

  const alphaScore = scoreBenchmarkRun(suite, alphaOne.run, { includeSimulated: true })
  const betaScore = scoreBenchmarkRun(suite, betaRun.run, { includeSimulated: true })
  check(alphaScore.overallScore === 100, 'all-pass evidence scores 100')
  check(alphaScore.usageCompleteness === 'reported' && alphaScore.inputTokens !== null && alphaScore.costUsd !== null, 'reported tokens and cost are aggregated without invention')
  const manualCategoryMean = betaScore.categoryScores.reduce((sum, category) => sum + category.score, 0) / BENCHMARK_CATEGORIES.length
  check(Math.abs(Number(betaScore.overallScore) - Math.round(manualCategoryMean * 100) / 100) < 0.001, 'overall quality uses equal category weighting')
  const languageScore = betaScore.categoryScores.find((category) => category.category === 'multi_language')
  check(languageScore?.expectedFixtures === BENCHMARK_LANGUAGES.length, 'multi-language category tracks all seven fixtures without overweighting the category')

  const unavailableWithNumbers = validateUsageMetadata({ source: 'unavailable', inputTokens: 10, outputTokens: null, cachedTokens: null, costUsd: null })
  check(!unavailableWithNumbers.ok, 'unavailable usage cannot carry fabricated numbers')
  const reportedWithoutNumbers = validateUsageMetadata({ source: 'reported', inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null })
  check(!reportedWithoutNumbers.ok, 'reported usage must contain actual metadata')

  const tampered = getProductionBenchmarkSuite()
  tampered.fixtures = tampered.fixtures.filter((fixture) => fixture.category !== 'long_context')
  check(!validateBenchmarkSuite(tampered).ok, 'suite validation rejects a missing required category')

  const productionClock = new DeterministicClock()
  const productionAdapters = createAdapters(productionClock)
  const productionWorkspaces: BenchmarkWorkspaceFactory = {
    async prepare(fixture, seed) {
      return { id: `${fixture.id}:${seed}`, rootPath: null, isolation: 'container', sourceReadOnly: true, async dispose() {} }
    }
  }
  const productionRun = await runBenchmarkModel({
    runId: 'verify-no-fabrication', suite, target: alpha, mode: 'production',
    planner: productionAdapters.planner, executor: productionAdapters.executor,
    validator: productionAdapters.validator, workspaceFactory: productionWorkspaces,
    clock: productionClock
  })
  check(productionRun.fixtureRuns.every((fixture) => fixture.status === 'invalid_evidence'), 'production runner rejects deterministic mock evidence')
  check(scoreBenchmarkRun(suite, productionRun).eligibleForRanking === false, 'invalid evidence can never enter rankings')

  const cancelController = new AbortController()
  const cancelClock = new DeterministicClock()
  const cancelAdapters = createAdapters(cancelClock)
  const cancellingPlanner: BenchmarkPlannerAdapter = {
    id: 'cancelling-planner',
    async plan(request) {
      cancelController.abort(new Error('operator cancelled'))
      return cancelAdapters.planner.plan(request)
    }
  }
  const cancelled = await runBenchmarkModel({
    runId: 'verify-cancel', suite, target: alpha, mode: 'simulation', planner: cancellingPlanner,
    executor: cancelAdapters.executor, validator: cancelAdapters.validator,
    workspaceFactory: cancelAdapters.workspaces, signal: cancelController.signal, clock: cancelClock
  })
  check(cancelled.status === 'cancelled', 'caller cancellation stops the model run')
  check(cancelled.fixtureRuns.length === 1 && cancelled.fixtureRuns[0].status === 'cancelled', 'in-flight fixture records cancellation evidence')
  check(cancelAdapters.disposals.length === 1, 'cancelled fixture still disposes its workspace')

  process.stdout.write(`verify-benchmark-lab: PASS (${checks} assertions, ${suite.fixtures.length} fixtures, ${BENCHMARK_CATEGORIES.length} categories)\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`verify-benchmark-lab: FAIL\n${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
