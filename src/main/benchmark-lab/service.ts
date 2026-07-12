import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { CatalogModel } from '../model-catalog/types'
import { recordTelemetryEvent } from '../telemetry'
import { getProductionBenchmarkSuite } from './catalog'
import { benchmarkCompatibilityKey, defaultBenchmarkRunConfiguration } from './comparability'
import { runBenchmarkModel } from './runner'
import { scoreBenchmarkRun } from './scoring'
import type { BenchmarkStore } from './store'
import type {
  BenchmarkCategory,
  BenchmarkFixtureRun,
  BenchmarkHardwareMetadata,
  BenchmarkModelRun,
  BenchmarkModelTarget,
  BenchmarkRunConfiguration,
  BenchmarkSuite,
  BenchmarkWorkspaceFactory
} from './types'
import { createTemporaryBenchmarkWorkspaceFactory } from './workspace'
import type {
  BenchmarkCatalogSource,
  BenchmarkCategoryId,
  BenchmarkComparisonIdentity,
  BenchmarkHardwareSource,
  BenchmarkResolvedRuntime,
  BenchmarkRuntimeResolver,
  BenchmarkServiceCatalog,
  BenchmarkServiceEvidence,
  BenchmarkServiceModelResult,
  BenchmarkServiceRecommendation,
  BenchmarkServiceRun,
  BenchmarkServiceSetup,
  BenchmarkSuiteOption
} from './service-types'

const CATEGORY_IDS: Record<BenchmarkCategory, BenchmarkCategoryId> = {
  repository_repair: 'repo-repair',
  multi_language: 'multi-language',
  code_generation: 'code-generation',
  debugging_repair: 'debugging',
  repository_understanding: 'repo-understanding',
  tool_agent: 'tool-agent',
  long_context: 'long-context',
  akorith_real_world: 'akorith-fixtures'
}

const CATEGORY_LABELS: Record<BenchmarkCategory, string> = {
  repository_repair: 'Repository repair',
  multi_language: 'Multi-language coding',
  code_generation: 'Code generation',
  debugging_repair: 'Debugging & repair',
  repository_understanding: 'Repository understanding',
  tool_agent: 'Tool & agent use',
  long_context: 'Long context',
  akorith_real_world: 'Akorith fixtures'
}

type StorePort = Pick<BenchmarkStore, 'saveSuite' | 'getSuite' | 'listSuites' | 'saveModelRun' | 'getModelRun' | 'listModelRuns'>

interface PreparedModelRun {
  sessionId: string
  runId: string
  suite: BenchmarkSuite
  model: CatalogModel
  target: BenchmarkModelTarget
  runtime: BenchmarkResolvedRuntime
  configuration: BenchmarkRunConfiguration
  startedAt: number
  seed: number
}

interface ActiveSession {
  controller: AbortController
  promise: Promise<void>
}

export interface BenchmarkLabServiceOptions {
  store: StorePort
  modelCatalog: BenchmarkCatalogSource
  runtimeResolver: BenchmarkRuntimeResolver
  hardware?: BenchmarkHardwareSource
  workspaceFactory?: BenchmarkWorkspaceFactory
  tempRoot?: string
  now?: () => number
  createId?: () => string
  maxFixtureTimeoutMs?: number
  maxModelsPerSession?: number
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\0\r\n]+/g, ' ').trim().slice(0, 1_000) || 'Unknown benchmark error.'
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function sessionIdFromRunId(runId: string): string | null {
  const match = /^(bench-[A-Za-z0-9-]{8,80})\.m\d+\.r\d+$/.exec(runId)
  return match?.[1] ?? null
}

function finiteAverage(values: readonly number[]): number | null {
  const finite = values.filter(Number.isFinite)
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null
}

function sumKnown(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + Number(value), 0)
}

function suiteProfiles(): BenchmarkSuite[] {
  // The versioned production profile intentionally retains all eight categories.
  // Category subsets would change weighting and are therefore not presented as
  // comparable benchmark suites without their own published domain revision.
  return [getProductionBenchmarkSuite()]
}

function optionForSuite(suite: BenchmarkSuite): BenchmarkSuiteOption {
  return {
    id: suite.id,
    label: suite.name,
    description: suite.description,
    categoryIds: [...new Set(suite.fixtures.map((fixture) => CATEGORY_IDS[fixture.category]))]
  }
}

function modelTarget(model: CatalogModel): BenchmarkModelTarget {
  return {
    catalogModelId: model.id,
    providerId: model.providerId,
    model: model.modelName,
    location: model.source === 'cloud' ? 'cloud' : model.source,
    nodeId: model.nodeId,
    quantization: model.quantization,
    contextWindowTokens: model.contextWindowTokens
  }
}

function unavailableHardware(nodeId: string | null): BenchmarkHardwareMetadata {
  return {
    source: 'unavailable',
    platform: null,
    architecture: null,
    cpuModel: null,
    cpuLogicalCores: null,
    ramMb: null,
    gpuModel: null,
    vramMb: null,
    nodeId
  }
}

function mergeConfiguration(
  target: BenchmarkModelTarget,
  runtime: BenchmarkResolvedRuntime,
  hardware: BenchmarkHardwareMetadata,
  repetitionIndex: number,
  repetitionCount: number
): BenchmarkRunConfiguration {
  const defaults = defaultBenchmarkRunConfiguration(target)
  const supplied = runtime.configuration ?? {}
  return {
    ...defaults,
    ...supplied,
    schemaVersion: 1,
    temperature: supplied.temperature ? { ...supplied.temperature } : defaults.temperature,
    providerParameters: supplied.providerParameters ? { ...supplied.providerParameters } : {},
    unsupportedParameters: supplied.unsupportedParameters ? [...supplied.unsupportedParameters] : [],
    dependencyVersions: supplied.dependencyVersions ? { ...supplied.dependencyVersions } : {},
    hardware: structuredClone(hardware),
    repetitionIndex,
    repetitionCount
  }
}

function runningModelRun(prepared: PreparedModelRun, fixtureRuns: BenchmarkFixtureRun[] = []): BenchmarkModelRun {
  return {
    schemaVersion: 1,
    id: prepared.runId,
    suiteId: prepared.suite.id,
    suiteRevision: prepared.suite.revision,
    suiteSeed: prepared.seed,
    mode: 'production',
    target: prepared.target,
    configuration: prepared.configuration,
    compatibilityKey: benchmarkCompatibilityKey(prepared.configuration),
    status: 'running',
    startedAt: prepared.startedAt,
    finishedAt: null,
    fixtureRuns: structuredClone(fixtureRuns),
    error: null
  }
}

function environmentKey(run: BenchmarkModelRun): string {
  return hash({
    workloadSettings: run.compatibilityKey,
    providerId: run.target.providerId,
    model: run.target.model,
    location: run.target.location,
    nodeId: run.target.nodeId,
    quantization: run.target.quantization,
    contextWindowTokens: run.target.contextWindowTokens,
    hardware: run.configuration.hardware,
    dependencyVersions: run.configuration.dependencyVersions,
    environmentImage: run.configuration.environmentImage
  })
}

function workloadKey(run: BenchmarkModelRun): string {
  return hash({
    suiteId: run.suiteId,
    suiteRevision: run.suiteRevision,
    suiteSeed: run.suiteSeed,
    compatibilityKey: run.compatibilityKey
  })
}

function hardwareLabel(hardware: BenchmarkHardwareMetadata): string | null {
  if (hardware.source === 'unavailable') return null
  return [hardware.gpuModel, hardware.cpuModel, hardware.platform, hardware.architecture].find((value) => value?.trim()) ?? null
}

function evidenceSummary(run: BenchmarkFixtureRun): string {
  if (run.evidence) {
    const passed = run.evidence.observations.filter((observation) => observation.passed).length
    return `${passed}/${run.evidence.observations.length} independently validated requirements passed.`
  }
  return run.error ?? run.executorSummary ?? run.plannerSummary ?? 'No validated evidence was produced.'
}

function evidenceStatus(run: BenchmarkFixtureRun): BenchmarkServiceEvidence['status'] {
  if (run.status === 'completed' && run.evidence) {
    return run.evidence.observations.every((observation) => observation.passed) ? 'passed' : 'failed'
  }
  if (run.status === 'cancelled') return 'skipped'
  return 'error'
}

function viewEvidence(suite: BenchmarkSuite, run: BenchmarkModelRun, label: string): BenchmarkServiceEvidence[] {
  let score
  try {
    score = scoreBenchmarkRun(suite, run, { expectedSeed: run.suiteSeed })
  } catch {
    score = null
  }
  const fixtureScores = new Map(score?.fixtureScores.map((entry) => [entry.fixtureId, entry.score]) ?? [])
  return run.fixtureRuns.map((fixtureRun) => {
    const fixture = suite.fixtures.find((candidate) => candidate.id === fixtureRun.fixtureId)
    return {
      id: fixtureRun.id,
      categoryId: CATEGORY_IDS[fixtureRun.category],
      caseName: fixture?.title ?? fixtureRun.fixtureId,
      status: evidenceStatus(fixtureRun),
      qualityScore: fixtureScores.get(fixtureRun.fixtureId) ?? null,
      durationMs: Number.isFinite(fixtureRun.durationMs) ? fixtureRun.durationMs : null,
      promptTokens: sumKnown([fixtureRun.planner?.usage.inputTokens ?? null, fixtureRun.executor?.usage.inputTokens ?? null]),
      completionTokens: sumKnown([fixtureRun.planner?.usage.outputTokens ?? null, fixtureRun.executor?.usage.outputTokens ?? null]),
      costUsd: sumKnown([fixtureRun.planner?.usage.costUsd ?? null, fixtureRun.executor?.usage.costUsd ?? null]),
      hardwareLabel: hardwareLabel(run.configuration.hardware),
      summary: `${label}: ${evidenceSummary(fixtureRun)}`
    }
  })
}

function aggregateModel(
  suite: BenchmarkSuite,
  modelId: string,
  modelLabel: string,
  runs: readonly BenchmarkModelRun[]
): BenchmarkServiceModelResult | null {
  if (!runs.length) return null
  const environmentCounts = new Map<string, number>()
  for (const run of runs) environmentCounts.set(environmentKey(run), (environmentCounts.get(environmentKey(run)) ?? 0) + 1)
  const selectedEnvironment = [...environmentCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
  const comparable = runs.filter((run) => environmentKey(run) === selectedEnvironment)
  const scored = comparable.map((run) => ({ run, score: scoreBenchmarkRun(suite, run, { expectedSeed: run.suiteSeed }) }))
  const complete = scored.filter((entry) => entry.score.eligibleForRanking && entry.score.overallScore !== null)
  const observedFixtureScores = scored.flatMap((entry) => entry.score.fixtureScores)
  if (!observedFixtureScores.length && runs.every((run) => run.fixtureRuns.length === 0)) return null
  const quality = finiteAverage((complete.length ? complete.map((entry) => Number(entry.score.overallScore)) : observedFixtureScores.map((entry) => entry.score))) ?? 0
  const categoryScores: BenchmarkServiceModelResult['categoryScores'] = {}
  for (const category of Object.keys(CATEGORY_IDS) as BenchmarkCategory[]) {
    const values = complete.flatMap((entry) => entry.score.categoryScores.filter((score) => score.category === category && score.complete).map((score) => score.score))
    const average = finiteAverage(values)
    if (average !== null) categoryScores[CATEGORY_IDS[category]] = average
  }
  const outputTokens = comparable.map((run) => scoreBenchmarkRun(suite, run, { expectedSeed: run.suiteSeed }).outputTokens)
  const totalTokens = comparable.map((run) => {
    const score = scoreBenchmarkRun(suite, run, { expectedSeed: run.suiteSeed })
    return score.inputTokens === null || score.outputTokens === null ? null : score.inputTokens + score.outputTokens
  })
  const costs = comparable.map((run) => scoreBenchmarkRun(suite, run, { expectedSeed: run.suiteSeed }).costUsd)
  const executionMs = comparable.map((run) => run.fixtureRuns.reduce((sum, fixture) => sum + (fixture.executor?.latencyMs ?? 0), 0))
  const aggregateOutput = sumKnown(outputTokens)
  const aggregateExecutionMs = executionMs.reduce((sum, value) => sum + value, 0)
  const comparison: BenchmarkComparisonIdentity = {
    workloadKey: workloadKey(comparable[0]),
    environmentKey: selectedEnvironment,
    comparableRepetitions: comparable.length,
    excludedRepetitions: runs.length - comparable.length
  }
  return {
    modelId,
    modelLabel,
    rank: null,
    qualityScore: quality,
    speedTokensPerSecond: aggregateOutput !== null && aggregateExecutionMs > 0 ? aggregateOutput / (aggregateExecutionMs / 1_000) : null,
    totalTokens: sumKnown(totalTokens),
    costUsd: sumKnown(costs),
    hardwareUtilizationPct: null,
    categoryScores,
    evidence: comparable.flatMap((run) => viewEvidence(suite, run, `Repetition ${run.configuration.repetitionIndex}`)),
    comparison
  }
}

function rankAndRecommend(results: BenchmarkServiceModelResult[]): {
  results: BenchmarkServiceModelResult[]
  recommendations: BenchmarkServiceRecommendation[]
} {
  const workloadCounts = new Map(results.map((result) => [result.comparison.workloadKey, results.filter((candidate) => candidate.comparison.workloadKey === result.comparison.workloadKey).length]))
  const selectedWorkload = [...workloadCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
  const comparable = results.filter((result) =>
    result.comparison.workloadKey === selectedWorkload &&
    Object.keys(result.categoryScores).length === Object.keys(CATEGORY_IDS).length &&
    result.evidence.some((entry) => entry.qualityScore !== null)
  )
    .sort((left, right) => right.qualityScore - left.qualityScore || left.modelId.localeCompare(right.modelId))
  const ranks = new Map(comparable.map((result, index) => [result.modelId, index + 1]))
  const ranked = results.map((result) => ({ ...result, rank: ranks.get(result.modelId) ?? null }))
  const recommendations: BenchmarkServiceRecommendation[] = []
  for (const [category, categoryId] of Object.entries(CATEGORY_IDS) as [BenchmarkCategory, BenchmarkCategoryId][]) {
    const candidates = comparable.filter((result) => result.categoryScores[categoryId] !== undefined)
      .sort((left, right) => Number(right.categoryScores[categoryId]) - Number(left.categoryScores[categoryId]) || left.modelId.localeCompare(right.modelId))
    const best = candidates[0]
    if (!best) continue
    recommendations.push({
      id: `${categoryId}:${best.modelId}`,
      useCase: CATEGORY_LABELS[category],
      modelLabel: best.modelLabel,
      rationale: `${best.modelLabel} has the highest complete validated ${CATEGORY_LABELS[category].toLowerCase()} score (${Number(best.categoryScores[categoryId]).toFixed(2)}) in this comparable workload cohort.`
    })
  }
  return { results: ranked.sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER) || left.modelLabel.localeCompare(right.modelLabel)), recommendations }
}

/**
 * Production orchestration facade used by Electron IPC. All model execution,
 * hardware observation, persistence, and catalog access are injected so the
 * core remains headlessly verifiable without substituting fabricated scores.
 */
export class BenchmarkLabService {
  private readonly workspaceFactory: BenchmarkWorkspaceFactory
  private readonly now: () => number
  private readonly createId: () => string
  private readonly active = new Map<string, ActiveSession>()

  constructor(private readonly options: BenchmarkLabServiceOptions) {
    this.workspaceFactory = options.workspaceFactory ?? createTemporaryBenchmarkWorkspaceFactory({ baseDirectory: options.tempRoot })
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => `bench-${randomUUID()}`)
  }

  async getCatalog(): Promise<BenchmarkServiceCatalog> {
    const suites = this.ensureSuites().map(optionForSuite)
    try {
      const discovery = await this.options.modelCatalog.discover()
      return {
        suites,
        models: discovery.catalog.models.map((model) => ({
          id: model.id,
          label: model.displayLabel || model.label || model.modelName,
          providerLabel: model.providerLabel,
          available: model.availability.status === 'available',
          ...(model.availability.status === 'available' ? {} : { unavailableReason: model.availability.reason ?? 'Availability has not been confirmed.' })
        })),
        warnings: discovery.warnings ?? []
      }
    } catch (error) {
      return { suites, models: [], warnings: [`Model catalog unavailable: ${safeMessage(error)}`] }
    }
  }

  async start(setupValue: BenchmarkServiceSetup): Promise<BenchmarkServiceRun> {
    const setup = this.validateSetup(setupValue)
    const suite = this.ensureSuites().find((candidate) => candidate.id === setup.suiteId)
    if (!suite) throw new Error('Selected benchmark suite profile does not exist.')
    const controller = new AbortController()
    const discovery = await this.options.modelCatalog.discover(controller.signal)
    const selected = setup.modelIds.map((id) => discovery.catalog.models.find((model) => model.id === id))
    if (selected.some((model) => !model)) throw new Error('One or more selected benchmark models no longer exist in the live catalog.')
    const unavailable = selected.find((model) => model!.availability.status !== 'available')
    if (unavailable) throw new Error(`${unavailable.displayLabel} is not available: ${unavailable.availability.reason ?? 'availability is unconfirmed'}`)
    const sessionId = this.createId()
    if (!/^bench-[A-Za-z0-9-]{8,80}$/.test(sessionId)) throw new Error('Benchmark session id factory returned an invalid id.')
    if (this.options.store.listModelRuns({ limit: 5_000 }).some((run) => sessionIdFromRunId(run.id) === sessionId)) {
      throw new Error('Benchmark session id already exists.')
    }
    const resolved: Array<{
      modelIndex: number
      model: CatalogModel
      target: BenchmarkModelTarget
      runtime: BenchmarkResolvedRuntime
      hardware: BenchmarkHardwareMetadata
    }> = []
    for (const [modelIndex, modelValue] of selected.entries()) {
      const model = modelValue!
      const target = modelTarget(model)
      const runtime = await this.options.runtimeResolver.resolve(model, target, controller.signal)
      if (!runtime?.planner?.id || !runtime.executor?.id || !runtime.validator?.id || !runtime.validator.version) {
        throw new Error(`No complete production benchmark runtime is connected for ${model.displayLabel}.`)
      }
      const hardware = this.options.hardware
        ? await this.options.hardware.observe(model, controller.signal)
        : unavailableHardware(model.nodeId)
      resolved.push({ modelIndex, model, target, runtime, hardware })
    }
    const prepared: PreparedModelRun[] = []
    for (const { modelIndex, model, target, runtime, hardware } of resolved) {
      for (let repetition = 1; repetition <= setup.repetitions; repetition += 1) {
        const startedAt = this.now()
        const item: PreparedModelRun = {
          sessionId,
          runId: `${sessionId}.m${modelIndex + 1}.r${repetition}`,
          suite,
          model,
          target,
          runtime,
          configuration: mergeConfiguration(target, runtime, hardware, repetition, setup.repetitions),
          startedAt,
          seed: setup.seed
        }
        prepared.push(item)
      }
    }
    const persisted: PreparedModelRun[] = []
    try {
      for (const item of prepared) {
        this.options.store.saveModelRun(runningModelRun(item))
        persisted.push(item)
      }
    } catch (error) {
      for (const item of persisted) {
        const current = this.options.store.getModelRun(item.runId)
        if (current?.status === 'running') {
          this.options.store.saveModelRun({ ...current, status: 'failed', finishedAt: this.now(), error: 'Benchmark setup persistence was interrupted.' })
        }
      }
      throw error
    }
    const promise = this.executeSession(prepared, controller).finally(() => this.active.delete(sessionId))
    this.active.set(sessionId, { controller, promise })
    return await this.getRun(sessionId)
  }

  async cancel(sessionId: string): Promise<BenchmarkServiceRun> {
    const active = this.active.get(sessionId)
    if (!active) {
      const existing = await this.getRun(sessionId)
      if (existing.status === 'running' || existing.status === 'queued') throw new Error('This benchmark is not owned by the current process and cannot be cancelled safely.')
      return existing
    }
    active.controller.abort(new Error('Benchmark session cancelled by the user.'))
    await active.promise
    return await this.getRun(sessionId)
  }

  async getRun(sessionId: string): Promise<BenchmarkServiceRun> {
    if (!/^bench-[A-Za-z0-9-]{8,80}$/.test(sessionId)) throw new Error('Benchmark session id is invalid.')
    this.recoverInterruptedRuns()
    const runs = this.options.store.listModelRuns({ limit: 5_000 }).filter((run) => sessionIdFromRunId(run.id) === sessionId)
    if (!runs.length) throw new Error('Benchmark session was not found.')
    return await this.toSessionView(sessionId, runs)
  }

  async listRuns(limit = 20): Promise<BenchmarkServiceRun[]> {
    const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 20
    this.recoverInterruptedRuns()
    const grouped = new Map<string, BenchmarkModelRun[]>()
    for (const run of this.options.store.listModelRuns({ limit: 5_000 })) {
      const sessionId = sessionIdFromRunId(run.id)
      if (!sessionId) continue
      const group = grouped.get(sessionId) ?? []
      group.push(run)
      grouped.set(sessionId, group)
    }
    const ordered = [...grouped.entries()].sort((left, right) => Math.min(...right[1].map((run) => run.startedAt)) - Math.min(...left[1].map((run) => run.startedAt))).slice(0, bounded)
    return await Promise.all(ordered.map(([sessionId, runs]) => this.toSessionView(sessionId, runs)))
  }

  private ensureSuites(): BenchmarkSuite[] {
    return suiteProfiles().map((suite) => this.options.store.saveSuite(suite))
  }

  private validateSetup(value: BenchmarkServiceSetup): BenchmarkServiceSetup {
    if (!value || typeof value.suiteId !== 'string' || !value.suiteId || !Array.isArray(value.modelIds)) throw new Error('Benchmark setup is invalid.')
    const modelIds = [...new Set(value.modelIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 500))]
    const maximum = Math.max(1, Math.min(this.options.maxModelsPerSession ?? 16, 32))
    if (!modelIds.length || modelIds.length > maximum || modelIds.length !== value.modelIds.length) throw new Error(`Select between 1 and ${maximum} unique models.`)
    if (!Number.isSafeInteger(value.seed) || value.seed < 0 || value.seed > 0x7fffffff) throw new Error('Benchmark seed must be an integer from 0 through 2147483647.')
    if (!Number.isSafeInteger(value.repetitions) || value.repetitions < 1 || value.repetitions > 20) throw new Error('Benchmark repetitions must be an integer from 1 through 20.')
    return { suiteId: value.suiteId, modelIds, seed: value.seed, repetitions: value.repetitions }
  }

  private async executeSession(prepared: PreparedModelRun[], controller: AbortController): Promise<void> {
    for (const item of prepared) {
      try {
        let firstNow = true
        const fixtureRuns: BenchmarkFixtureRun[] = []
        const result = await runBenchmarkModel({
          runId: item.runId,
          suite: item.suite,
          target: item.target,
          mode: 'production',
          planner: item.runtime.planner,
          executor: item.runtime.executor,
          validator: item.runtime.validator,
          workspaceFactory: this.workspaceFactory,
          signal: controller.signal,
          seed: item.seed,
          maxFixtureTimeoutMs: this.options.maxFixtureTimeoutMs,
          configuration: item.configuration,
          clock: {
            now: () => firstNow ? (firstNow = false, item.startedAt) : this.now(),
            monotonic: () => performance.now()
          },
          onFixtureComplete: (fixtureRun) => {
            fixtureRuns.push(structuredClone(fixtureRun))
            this.options.store.saveModelRun(runningModelRun(item, fixtureRuns))
            const outcome = fixtureRun.status === 'completed'
              ? 'completed'
              : fixtureRun.status === 'cancelled'
                ? 'cancelled'
                : 'failed'
            recordTelemetryEvent({
              kind: 'benchmark_task', benchmarkRunId: item.sessionId, benchmarkTaskId: fixtureRun.fixtureId,
              suiteId: item.suite.id, suiteVersion: String(item.suite.revision), outcome,
              occurredAt: fixtureRun.finishedAt, durationMs: fixtureRun.durationMs,
              providerId: item.target.providerId, model: item.target.model, location: item.target.location,
              nodeId: item.target.nodeId ?? undefined, taskType: 'benchmark', correlationId: fixtureRun.id
            })
            if (fixtureRun.executor) {
              const requestId = `benchmark:${fixtureRun.id}`
              const usage = fixtureRun.executor.usage
              recordTelemetryEvent({
                kind: outcome === 'completed' ? 'model_request_completed' : 'model_request_failed',
                requestId, occurredAt: fixtureRun.finishedAt, durationMs: fixtureRun.executor.latencyMs,
                providerId: item.target.providerId, model: item.target.model, location: item.target.location,
                nodeId: item.target.nodeId ?? undefined, taskType: 'benchmark', correlationId: fixtureRun.id,
                ...(outcome === 'completed' ? {} : { errorCode: fixtureRun.errorCode ?? 'benchmark_executor_failed' })
              })
              if (usage.inputTokens !== null && usage.outputTokens !== null) {
                recordTelemetryEvent({
                  kind: 'token_usage', requestId, occurredAt: fixtureRun.finishedAt,
                  promptTokens: usage.inputTokens, completionTokens: usage.outputTokens,
                  cachedTokens: usage.cachedTokens ?? 0, costUsd: usage.costUsd ?? 0,
                  estimated: usage.source === 'estimated', providerId: item.target.providerId,
                  model: item.target.model, location: item.target.location, nodeId: item.target.nodeId ?? undefined,
                  taskType: 'benchmark', correlationId: fixtureRun.id
                })
              }
            }
          }
        })
        this.options.store.saveModelRun(result)
      } catch (error) {
        const current = this.options.store.getModelRun(item.runId) ?? runningModelRun(item)
        if (current.status === 'running') {
          this.options.store.saveModelRun({
            ...current,
            status: controller.signal.aborted ? 'cancelled' : 'failed',
            finishedAt: this.now(),
            error: safeMessage(error)
          })
        }
      }
    }
  }

  private recoverInterruptedRuns(): void {
    for (const run of this.options.store.listModelRuns({ limit: 5_000 })) {
      const sessionId = sessionIdFromRunId(run.id)
      if (!sessionId || run.status !== 'running' || this.active.has(sessionId)) continue
      this.options.store.saveModelRun({
        ...run,
        status: 'failed',
        finishedAt: this.now(),
        error: 'Benchmark execution was interrupted before this application process started.'
      })
    }
  }

  private async toSessionView(sessionId: string, runs: BenchmarkModelRun[]): Promise<BenchmarkServiceRun> {
    const sorted = [...runs].sort((left, right) => left.configuration.repetitionIndex - right.configuration.repetitionIndex || left.id.localeCompare(right.id))
    const first = sorted[0]
    const suite = this.options.store.getSuite(first.suiteId, first.suiteRevision)
    if (!suite) throw new Error('Persisted benchmark suite revision is unavailable.')
    let catalogModels: CatalogModel[] = []
    try {
      catalogModels = (await this.options.modelCatalog.discover()).catalog.models
    } catch {
      catalogModels = []
    }
    const groups = new Map<string, BenchmarkModelRun[]>()
    for (const run of sorted) {
      const group = groups.get(run.target.catalogModelId) ?? []
      group.push(run)
      groups.set(run.target.catalogModelId, group)
    }
    const aggregated = [...groups.entries()].flatMap(([modelId, modelRuns]) => {
      const catalog = catalogModels.find((candidate) => candidate.id === modelId)
      const label = catalog?.displayLabel || catalog?.label || modelRuns[0].target.model
      const result = aggregateModel(suite, modelId, label, modelRuns)
      return result ? [result] : []
    })
    const ranked = rankAndRecommend(aggregated)
    const terminal = sorted.every((run) => run.status !== 'running')
    const completed = sorted.filter((run) => run.status === 'completed').length
    const cancelled = sorted.filter((run) => run.status === 'cancelled').length
    const failed = sorted.filter((run) => run.status === 'failed').length
    const status: BenchmarkServiceRun['status'] = !terminal
      ? 'running'
      : completed > 0
        ? 'completed'
        : cancelled === sorted.length
          ? 'cancelled'
          : 'failed'
    const errors = sorted.flatMap((run) => run.error ? [run.error] : [])
    return {
      id: sessionId,
      status,
      createdAt: Math.min(...sorted.map((run) => run.startedAt)),
      completedAt: terminal ? Math.max(...sorted.map((run) => run.finishedAt ?? run.startedAt)) : null,
      setup: {
        suiteId: suite.id,
        modelIds: [...groups.keys()],
        seed: first.suiteSeed,
        repetitions: first.configuration.repetitionCount
      },
      results: ranked.results,
      recommendations: ranked.recommendations,
      ...(status === 'failed' ? { error: errors[0] ?? `${failed} model run${failed === 1 ? '' : 's'} failed without validated results.` } : {})
    }
  }
}
