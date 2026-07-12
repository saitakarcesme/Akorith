import { BENCHMARK_CATEGORIES, type BenchmarkAnalysis, type BenchmarkCategoryScore, type BenchmarkFixtureScore, type BenchmarkModelRun, type BenchmarkRunScore, type BenchmarkScoringPolicy, type BenchmarkSuite, type BenchmarkUsageMetadata, type BenchmarkUsageSource } from './types'
import { validateBenchmarkModelRun, validateBenchmarkSuite } from './validation'

export const BENCHMARK_SCORING_POLICY: BenchmarkScoringPolicy = Object.freeze({
  id: 'akorith-equal-category-v1',
  categoryWeights: {
    repository_repair: 1 / 8,
    multi_language: 1 / 8,
    code_generation: 1 / 8,
    debugging_repair: 1 / 8,
    repository_understanding: 1 / 8,
    tool_agent: 1 / 8,
    long_context: 1 / 8,
    akorith_real_world: 1 / 8
  },
  fixtureNormalization: 'declared_requirement_weights',
  incompleteRunBehavior: 'exclude',
  productionSimulationBehavior: 'exclude_unless_explicit',
  tieBreakers: ['latency', 'output_tokens', 'cost', 'catalog_model_id'] as BenchmarkScoringPolicy['tieBreakers']
})

export interface BenchmarkScoringOptions {
  includeSimulated?: boolean
  expectedSeed?: number
  expectedCompatibilityKey?: string
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100
}

function scoreFixture(suite: BenchmarkSuite, run: BenchmarkModelRun, fixtureId: string): BenchmarkFixtureScore | null {
  const fixture = suite.fixtures.find((candidate) => candidate.id === fixtureId)
  const fixtureRun = run.fixtureRuns.find((candidate) => candidate.fixtureId === fixtureId)
  if (!fixture || !fixtureRun || fixtureRun.status !== 'completed' || !fixtureRun.evidence) return null
  if (fixtureRun.evidence.fixtureId !== fixture.id || fixtureRun.evidence.fixtureRevision !== fixture.revision) return null
  const observations = new Map(fixtureRun.evidence.observations.map((observation) => [observation.requirementId, observation]))
  if (observations.size !== fixture.validation.length) return null
  let passedWeight = 0
  let totalWeight = 0
  const mandatoryFailures: string[] = []
  for (const requirement of fixture.validation) {
    const observation = observations.get(requirement.id)
    if (!observation) return null
    totalWeight += requirement.weight
    if (observation.passed) passedWeight += requirement.weight
    else if (requirement.mandatory) mandatoryFailures.push(requirement.id)
  }
  return {
    fixtureId: fixture.id,
    category: fixture.category,
    score: roundScore(totalWeight > 0 ? (passedWeight / totalWeight) * 100 : 0),
    passedWeight,
    totalWeight,
    mandatoryFailures
  }
}

function combineUsage(stages: readonly (BenchmarkUsageMetadata | null)[]): {
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  costUsd: number | null
  completeness: BenchmarkUsageSource
} {
  const present = stages.filter((stage): stage is BenchmarkUsageMetadata => stage !== null)
  if (present.length === 0 || present.some((usage) => usage.source === 'unavailable')) {
    return { inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null, completeness: 'unavailable' }
  }
  const sum = (selector: (usage: BenchmarkUsageMetadata) => number | null): number | null => {
    const values = present.map(selector)
    return values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + Number(value), 0)
  }
  return {
    inputTokens: sum((usage) => usage.inputTokens),
    outputTokens: sum((usage) => usage.outputTokens),
    cachedTokens: sum((usage) => usage.cachedTokens),
    costUsd: sum((usage) => usage.costUsd),
    completeness: present.every((usage) => usage.source === 'reported') ? 'reported' : 'estimated'
  }
}

export function scoreBenchmarkRun(
  suiteValue: BenchmarkSuite,
  runValue: BenchmarkModelRun,
  options: BenchmarkScoringOptions = {}
): BenchmarkRunScore {
  const parsedSuite = validateBenchmarkSuite(suiteValue)
  if (!parsedSuite.ok) throw new Error(`Cannot score invalid suite: ${parsedSuite.errors.join('; ')}`)
  const parsedRun = validateBenchmarkModelRun(runValue, parsedSuite.value)
  if (!parsedRun.ok) {
    return {
      runId: typeof runValue?.id === 'string' ? runValue.id : 'invalid-run',
      catalogModelId: typeof runValue?.target?.catalogModelId === 'string' ? runValue.target.catalogModelId : 'invalid-model',
      mode: runValue?.mode === 'simulation' ? 'simulation' : 'production',
      compatibilityKey: typeof runValue?.compatibilityKey === 'string' ? runValue.compatibilityKey : 'invalid',
      eligibleForRanking: false,
      ineligibleReason: `Invalid persisted run: ${parsedRun.errors.join('; ')}`,
      overallScore: null,
      fixtureScores: [],
      categoryScores: BENCHMARK_CATEGORIES.map((category) => ({
        category,
        score: 0,
        scoredFixtures: 0,
        expectedFixtures: parsedSuite.value.fixtures.filter((fixture) => fixture.category === category).length,
        complete: false
      })),
      totalLatencyMs: 0,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      costUsd: null,
      usageCompleteness: 'unavailable'
    }
  }

  const run = parsedRun.value
  const fixtureScores = parsedSuite.value.fixtures.flatMap((fixture) => {
    const score = scoreFixture(parsedSuite.value, run, fixture.id)
    return score ? [score] : []
  })
  const categoryScores: BenchmarkCategoryScore[] = BENCHMARK_CATEGORIES.map((category) => {
    const expectedFixtures = parsedSuite.value.fixtures.filter((fixture) => fixture.category === category).length
    const scores = fixtureScores.filter((score) => score.category === category)
    return {
      category,
      score: roundScore(scores.length ? scores.reduce((sum, score) => sum + score.score, 0) / scores.length : 0),
      scoredFixtures: scores.length,
      expectedFixtures,
      complete: scores.length === expectedFixtures
    }
  })
  const complete = run.status === 'completed' && fixtureScores.length === parsedSuite.value.fixtures.length && categoryScores.every((score) => score.complete)
  const expectedSeed = options.expectedSeed ?? parsedSuite.value.seed
  let ineligibleReason: string | null = null
  if (run.suiteSeed !== expectedSeed) ineligibleReason = `Run seed ${run.suiteSeed} does not match comparison seed ${expectedSeed}.`
  else if (options.expectedCompatibilityKey && run.compatibilityKey !== options.expectedCompatibilityKey) ineligibleReason = 'Run settings are incompatible with the selected comparison cohort.'
  else if (run.mode === 'simulation' && !options.includeSimulated) ineligibleReason = 'Simulated evidence is excluded from production rankings.'
  else if (!complete) ineligibleReason = 'Run lacks complete validated evidence for every suite fixture.'
  const overallScore = complete
    ? roundScore(categoryScores.reduce((sum, category) => sum + category.score, 0) / BENCHMARK_CATEGORIES.length)
    : null
  const usages = run.fixtureRuns.flatMap((fixture) => [fixture.planner?.usage ?? null, fixture.executor?.usage ?? null])
  const usage = combineUsage(usages)
  return {
    runId: run.id,
    catalogModelId: run.target.catalogModelId,
    mode: run.mode,
    compatibilityKey: run.compatibilityKey,
    eligibleForRanking: ineligibleReason === null,
    ineligibleReason,
    overallScore,
    fixtureScores,
    categoryScores,
    totalLatencyMs: roundScore(run.fixtureRuns.reduce((sum, fixture) => sum + fixture.durationMs, 0)),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    costUsd: usage.costUsd,
    usageCompleteness: usage.completeness
  }
}

function efficiencyValue(value: number | null): number {
  return value === null ? Number.POSITIVE_INFINITY : value
}

/** Equal-category ranking. Latency, tokens, and cost are transparent tie-break metadata, not hidden quality weights. */
export function analyzeBenchmarkRuns(
  suite: BenchmarkSuite,
  runs: readonly BenchmarkModelRun[],
  options: BenchmarkScoringOptions = {}
): BenchmarkAnalysis {
  const compatibilityCounts = new Map<string, number>()
  for (const run of runs) {
    if (/^[a-f0-9]{64}$/i.test(run.compatibilityKey ?? '')) {
      compatibilityCounts.set(run.compatibilityKey, (compatibilityCounts.get(run.compatibilityKey) ?? 0) + 1)
    }
  }
  const selectedCompatibilityKey = options.expectedCompatibilityKey ?? [...compatibilityCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
  const scored = runs.map((run) => scoreBenchmarkRun(suite, run, { ...options, expectedCompatibilityKey: selectedCompatibilityKey }))
  const eligible = scored
    .filter((score) => score.eligibleForRanking && score.overallScore !== null)
    .sort((left, right) =>
      Number(right.overallScore) - Number(left.overallScore) ||
      left.totalLatencyMs - right.totalLatencyMs ||
      efficiencyValue(left.outputTokens) - efficiencyValue(right.outputTokens) ||
      efficiencyValue(left.costUsd) - efficiencyValue(right.costUsd) ||
      left.catalogModelId.localeCompare(right.catalogModelId)
    )
  const rankings = eligible.map((score, index) => ({ ...score, rank: index + 1 }))
  const categoryRecommendations = BENCHMARK_CATEGORIES.flatMap((category) => {
    const candidates = eligible
      .map((score) => ({ score, category: score.categoryScores.find((entry) => entry.category === category)! }))
      .filter((candidate) => candidate.category.complete)
      .sort((left, right) => right.category.score - left.category.score || left.score.totalLatencyMs - right.score.totalLatencyMs || left.score.catalogModelId.localeCompare(right.score.catalogModelId))
    const best = candidates[0]
    if (!best) return []
    const evidenceFixtures = best.score.fixtureScores.filter((fixture) => fixture.category === category).length
    return [{
      category,
      catalogModelId: best.score.catalogModelId,
      score: best.category.score,
      comparedModels: candidates.length,
      evidenceFixtures,
      rationale: `${best.score.catalogModelId} has the highest validated ${category.replace(/_/g, ' ')} score (${best.category.score.toFixed(2)}) across ${candidates.length} complete model run${candidates.length === 1 ? '' : 's'}; latency is used only to break equal scores.`
    }]
  })
  const categoryLeaders = new Map(categoryRecommendations.map((entry) => [entry.category, entry.score]))
  const modelFit = rankings.map((ranking) => {
    const strongestCategories = ranking.categoryScores
      .filter((category) => category.complete && category.score >= (categoryLeaders.get(category.category) ?? 101) - 5)
      .map((category) => category.category)
    return {
      catalogModelId: ranking.catalogModelId,
      strongestCategories,
      overallRank: ranking.rank,
      rationale: strongestCategories.length
        ? `Within five points of the validated category leader for ${strongestCategories.map((category) => category.replace(/_/g, ' ')).join(', ')}.`
        : 'Complete evidence is available, but this model is not within five points of a category leader.'
    }
  })
  return {
    policy: BENCHMARK_SCORING_POLICY,
    rankings,
    categoryRecommendations,
    modelFit,
    excludedRuns: scored.filter((score) => !score.eligibleForRanking).map((score) => ({ runId: score.runId, reason: score.ineligibleReason ?? 'Not eligible.' }))
  }
}
