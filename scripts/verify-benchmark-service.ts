import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { BenchmarkLabService } from '../src/main/benchmark-lab/service'
import type { BenchmarkRuntimeResolver } from '../src/main/benchmark-lab/service-types'
import { applyBenchmarkMigrations } from '../src/main/benchmark-lab/migrations'
import { BenchmarkStore } from '../src/main/benchmark-lab/store'
import { createTemporaryBenchmarkWorkspaceFactory } from '../src/main/benchmark-lab/workspace'
import type { BenchmarkModelRun, BenchmarkValidationEvidence } from '../src/main/benchmark-lab/types'
import { buildModelCatalog } from '../src/main/model-catalog/normalize'

let checks = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  checks += 1
}

const catalog = buildModelCatalog({
  generatedAt: 1_800_000_000_000,
  providers: [{
    providerId: 'fixture-runtime',
    providerLabel: 'Fixture Runtime',
    family: 'openai_compatible',
    source: 'local',
    availability: { status: 'available', checkedAt: 1_800_000_000_000 },
    models: [
      { name: 'deterministic-code', label: 'Deterministic Code', available: true, contextWindowTokens: 32_768, quantization: 'Q8_0' },
      { name: 'slow-code', label: 'Slow Code', available: true, contextWindowTokens: 32_768, quantization: 'Q8_0' }
    ]
  }]
})

let preparedWorkspaceCount = 0
let disposedWorkspaceCount = 0

const runtimeResolver: BenchmarkRuntimeResolver = {
  async resolve(model) {
    return {
      planner: {
        id: 'fixture-planner-v1',
        async plan({ fixture, workspace }) {
          check(Boolean(workspace.rootPath), 'planner receives a real temporary fixture workspace')
          const sourceFile = fixture.workspaceFiles[0]
          check(await readFile(join(workspace.rootPath!, sourceFile.path), 'utf8') === sourceFile.content, 'fixture source is materialized exactly')
          return {
            plan: `Apply the bounded fixture task for ${fixture.id}.`,
            summary: 'Verified fixture plan.',
            usage: { source: 'reported', inputTokens: 11, outputTokens: 3, cachedTokens: 0, costUsd: 0 }
          }
        }
      },
      executor: {
        id: 'fixture-executor-v1',
        async execute({ fixture, workspace, signal }) {
          if (model.modelName === 'slow-code') {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 60_000)
              timer.unref?.()
              signal.addEventListener('abort', () => {
                clearTimeout(timer)
                reject(signal.reason)
              }, { once: true })
            })
          }
          const marker = `validated:${fixture.id}`
          await writeFile(join(workspace.rootPath!, 'benchmark-output.txt'), marker, 'utf8')
          return {
            status: 'completed',
            summary: 'Fixture artifact written.',
            artifactReferences: ['benchmark-output.txt'],
            usage: { source: 'reported', inputTokens: 17, outputTokens: 7, cachedTokens: 0, costUsd: 0 },
            error: null
          }
        }
      },
      validator: {
        id: 'fixture-filesystem-validator',
        version: '1.0.0',
        async validate({ fixture, workspace }): Promise<BenchmarkValidationEvidence> {
          const marker = await readFile(join(workspace.rootPath!, 'benchmark-output.txt'), 'utf8')
          const digest = createHash('sha256').update(marker).digest('hex')
          return {
            schemaVersion: 1,
            validatorId: 'fixture-filesystem-validator',
            validatorVersion: '1.0.0',
            fixtureId: fixture.id,
            fixtureRevision: fixture.revision,
            capturedAt: Date.now(),
            simulated: false,
            observations: fixture.validation.map((requirement) => ({
              requirementId: requirement.id,
              passed: marker === `validated:${fixture.id}`,
              observedAt: Date.now(),
              source: 'filesystem',
              summary: 'The independent validator observed the executor artifact in the isolated fixture workspace.',
              process: null,
              filesystem: { relativePath: 'benchmark-output.txt', sha256: digest }
            })),
            logsDigest: digest
          }
        }
      },
      configuration: {
        harnessVersion: '1.0.0',
        instructionProfileId: 'akorith-production-benchmark-v1',
        maxAttempts: 1,
        temperature: { support: 'unsupported', requested: null, applied: null },
        providerParameters: { fixtureRuntime: true },
        unsupportedParameters: ['temperature'],
        dependencyVersions: { 'fixture-runtime': '1.0.0' },
        environmentImage: null
      }
    }
  }
}

async function waitForTerminal(service: BenchmarkLabService, id: string): Promise<Awaited<ReturnType<BenchmarkLabService['getRun']>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await service.getRun(id)
    if (run.status !== 'running' && run.status !== 'queued') return run
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for benchmark session ${id}.`)
}

async function main(): Promise<void> {
  const database = new Database(':memory:')
  applyBenchmarkMigrations(database)
  const backingStore = new BenchmarkStore(database)
  let progressWrites = 0
  const store = {
    saveSuite: (value: unknown) => backingStore.saveSuite(value),
    getSuite: (id: string, revision?: number) => backingStore.getSuite(id, revision),
    listSuites: (limit?: number) => backingStore.listSuites(limit),
    saveModelRun: (value: unknown) => {
      const saved = backingStore.saveModelRun(value)
      if (saved.status === 'running' && saved.fixtureRuns.length > 0) progressWrites += 1
      return saved
    },
    getModelRun: (id: string) => backingStore.getModelRun(id),
    listModelRuns: (options?: { suiteId?: string; catalogModelId?: string; limit?: number }) => backingStore.listModelRuns(options)
  }
  const tempRoot = join(process.cwd(), '.tmp', 'verify-benchmark-service')
  await rm(tempRoot, { recursive: true, force: true })
  await mkdir(tempRoot, { recursive: true })
  const baseWorkspaceFactory = createTemporaryBenchmarkWorkspaceFactory({ baseDirectory: tempRoot })
  const workspaceFactory = {
    async prepare(...args: Parameters<typeof baseWorkspaceFactory.prepare>) {
      const workspace = await baseWorkspaceFactory.prepare(...args)
      preparedWorkspaceCount += 1
      const dispose = workspace.dispose.bind(workspace)
      workspace.dispose = async () => {
        await dispose()
        disposedWorkspaceCount += 1
        await assert.rejects(access(workspace.rootPath!))
      }
      return workspace
    }
  }
  let idCounter = 0
  const service = new BenchmarkLabService({
    store,
    modelCatalog: { async discover() { return { catalog, warnings: [] } } },
    runtimeResolver,
    hardware: {
      async observe() {
        return {
          source: 'observed',
          platform: process.platform,
          architecture: process.arch,
          cpuModel: 'Verifier CPU',
          cpuLogicalCores: 8,
          ramMb: 16_384,
          gpuModel: null,
          vramMb: null,
          nodeId: null
        }
      }
    },
    workspaceFactory,
    createId: () => `bench-verify${String(++idCounter).padStart(4, '0')}`,
    maxFixtureTimeoutMs: 5_000
  })

  const serviceCatalog = await service.getCatalog()
  check(serviceCatalog.suites.length === 1, 'catalog exposes the published versioned production profile')
  check(serviceCatalog.models.length === 2 && serviceCatalog.models.every((model) => model.available), 'live model catalog entries are projected without a hardcoded model list')
  const productionProfile = serviceCatalog.suites[0]
  check(productionProfile.categoryIds.length === 8, 'production profile preserves every equally weighted category')
  const fastModel = serviceCatalog.models.find((model) => model.label.includes('Deterministic'))!
  const started = await service.start({ suiteId: productionProfile.id, modelIds: [fastModel.id], seed: 42, repetitions: 2 })
  check(started.status === 'running' || started.status === 'completed', 'start returns a persisted session immediately')
  const completed = await waitForTerminal(service, started.id)
  check(completed.status === 'completed', 'production service completes deterministic real-workspace runs')
  check(completed.results.length === 1 && completed.results[0].qualityScore === 100, 'quality derives from independently validated evidence')
  check(completed.results[0].comparison.comparableRepetitions === 2 && completed.results[0].comparison.excludedRepetitions === 0, 'matching runtime, model, context, settings, and hardware repetitions are aggregated')
  check(/^[a-f0-9]{64}$/.test(completed.results[0].comparison.workloadKey) && /^[a-f0-9]{64}$/.test(completed.results[0].comparison.environmentKey), 'workload and full environment comparability identities are stable hashes')
  check(completed.results[0].totalTokens !== null && completed.results[0].costUsd === 0, 'reported usage is aggregated without fabricated cost')
  check(completed.results[0].hardwareUtilizationPct === null, 'unobserved utilization remains honestly unavailable')
  check(completed.results[0].evidence.every((entry) => entry.status === 'passed' && entry.qualityScore === 100), 'fixture evidence remains inspectable in the service projection')
  check(progressWrites > 0, 'completed fixture progress is persisted before terminal model results')
  check(preparedWorkspaceCount > 0 && preparedWorkspaceCount === disposedWorkspaceCount, 'every real fixture workspace is disposed')

  const completedModelRuns = backingStore.listModelRuns({ catalogModelId: fastModel.id })
    .filter((run) => run.id.startsWith(`${completed.id}.`))
  const mismatchedEnvironment = structuredClone(completedModelRuns[0])
  mismatchedEnvironment.id = `${completed.id}.m1.r20`
  mismatchedEnvironment.startedAt += 1
  mismatchedEnvironment.finishedAt = (mismatchedEnvironment.finishedAt ?? mismatchedEnvironment.startedAt) + 1
  mismatchedEnvironment.configuration.hardware.cpuModel = 'Different verifier CPU'
  mismatchedEnvironment.fixtureRuns = mismatchedEnvironment.fixtureRuns.map((fixture, index) => ({
    ...fixture,
    id: `${mismatchedEnvironment.id}:fixture-${index + 1}`
  }))
  backingStore.saveModelRun(mismatchedEnvironment)
  const enforcedCohort = await service.getRun(completed.id)
  check(
    enforcedCohort.results[0].comparison.comparableRepetitions === 2 && enforcedCohort.results[0].comparison.excludedRepetitions === 1,
    'a repetition captured on different hardware is excluded rather than silently averaged'
  )

  const persisted = await service.listRuns(10)
  check(persisted.some((run) => run.id === completed.id && run.status === 'completed'), 'completed sessions are reconstructed from persisted model runs')

  const slowModel = serviceCatalog.models.find((model) => model.label.includes('Slow'))!
  const cancellable = await service.start({ suiteId: productionProfile.id, modelIds: [slowModel.id], seed: 7, repetitions: 1 })
  const cancelled = await service.cancel(cancellable.id)
  check(cancelled.status === 'cancelled', 'session cancellation reaches the active fixture abort boundary')
  check(backingStore.listModelRuns({ catalogModelId: slowModel.id }).every((run) => run.status === 'cancelled'), 'cancellation is persisted as a terminal state')

  const unavailableService = new BenchmarkLabService({
    store,
    modelCatalog: { async discover() { throw new Error('catalog offline') } },
    runtimeResolver,
    createId: () => 'bench-unused0001'
  })
  const unavailable = await unavailableService.getCatalog()
  check(unavailable.models.length === 0 && unavailable.warnings[0]?.includes('catalog offline'), 'catalog failure returns an honest empty model state with a warning')

  const invalid = service.start({ suiteId: productionProfile.id, modelIds: [], seed: 42, repetitions: 1 })
  await assert.rejects(invalid, /Select between/)
  checks += 1

  const savedRuns: BenchmarkModelRun[] = backingStore.listModelRuns({ limit: 5_000 })
  check(savedRuns.every((run) => run.mode === 'production'), 'service never persists verifier/simulation mode as a production result')

  database.close()
  await rm(tempRoot, { recursive: true, force: true })
  process.stdout.write(`verify-benchmark-service: PASS (${checks} assertions, ${preparedWorkspaceCount} isolated workspaces)\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`verify-benchmark-service: FAIL\n${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
