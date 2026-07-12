export const BENCHMARK_SCHEMA_VERSION = 1 as const

export const BENCHMARK_CATEGORIES = [
  'repository_repair',
  'multi_language',
  'code_generation',
  'debugging_repair',
  'repository_understanding',
  'tool_agent',
  'long_context',
  'akorith_real_world'
] as const

export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number]

export const BENCHMARK_LANGUAGES = [
  'cpp',
  'go',
  'java',
  'javascript',
  'typescript',
  'python',
  'rust'
] as const

export type BenchmarkLanguage = (typeof BENCHMARK_LANGUAGES)[number]

export type BenchmarkValidationKind =
  | 'test_command'
  | 'behavior_assertion'
  | 'artifact_check'
  | 'repository_assertion'

export interface BenchmarkFixtureFile {
  path: string
  content: string
}

export interface BenchmarkValidationRequirement {
  id: string
  label: string
  kind: BenchmarkValidationKind
  weight: number
  mandatory: boolean
}

/** A fixture is immutable once published; changes require a revision bump. */
export interface BenchmarkFixture {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION
  id: string
  revision: number
  category: BenchmarkCategory
  title: string
  summary: string
  taskPrompt: string
  seed: number
  timeoutMs: number
  languages: BenchmarkLanguage[]
  tags: string[]
  workspaceFiles: BenchmarkFixtureFile[]
  validation: BenchmarkValidationRequirement[]
}

/** Suites embed fixtures so a persisted result always identifies the exact workload. */
export interface BenchmarkSuite {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION
  id: string
  revision: number
  name: string
  description: string
  seed: number
  defaultTimeoutMs: number
  fixtures: BenchmarkFixture[]
  createdAt: number
}

export type BenchmarkExecutionLocation = 'local' | 'remote' | 'cloud'

export interface BenchmarkModelTarget {
  catalogModelId: string
  providerId: string
  model: string
  location: BenchmarkExecutionLocation
  nodeId: string | null
  quantization: string | null
  contextWindowTokens: number | null
}

export type BenchmarkParameterValue = string | number | boolean | null

export interface BenchmarkTemperatureSetting {
  support: 'supported' | 'unsupported' | 'unknown'
  requested: number | null
  applied: number | null
}

export interface BenchmarkHardwareMetadata {
  source: 'observed' | 'reported' | 'unavailable'
  platform: string | null
  architecture: string | null
  cpuModel: string | null
  cpuLogicalCores: number | null
  ramMb: number | null
  gpuModel: string | null
  vramMb: number | null
  nodeId: string | null
}

/** Settings that must be persisted to decide whether two runs are comparable. */
export interface BenchmarkRunConfiguration {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION
  harnessVersion: string
  instructionProfileId: string
  maxAttempts: number
  temperature: BenchmarkTemperatureSetting
  providerParameters: Record<string, BenchmarkParameterValue>
  unsupportedParameters: string[]
  repetitionIndex: number
  repetitionCount: number
  hardware: BenchmarkHardwareMetadata
  dependencyVersions: Record<string, string>
  environmentImage: string | null
}

export type BenchmarkUsageSource = 'reported' | 'estimated' | 'unavailable'

export interface BenchmarkUsageMetadata {
  source: BenchmarkUsageSource
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  costUsd: number | null
}

export interface BenchmarkStageMetrics {
  latencyMs: number
  usage: BenchmarkUsageMetadata
}

export interface BenchmarkPlannerOutput {
  plan: string
  summary: string
  usage: BenchmarkUsageMetadata
}

export interface BenchmarkExecutorOutput {
  status: 'completed' | 'failed'
  summary: string
  artifactReferences: string[]
  usage: BenchmarkUsageMetadata
  error: string | null
}

export type BenchmarkEvidenceSource =
  | 'process'
  | 'filesystem'
  | 'structured_parser'
  | 'deterministic_mock'

export interface BenchmarkProcessEvidence {
  commandLabel: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdoutDigest: string | null
  stderrDigest: string | null
}

export interface BenchmarkFilesystemEvidence {
  relativePath: string
  sha256: string | null
}

export interface BenchmarkValidationObservation {
  requirementId: string
  passed: boolean
  observedAt: number
  source: BenchmarkEvidenceSource
  summary: string
  process: BenchmarkProcessEvidence | null
  filesystem: BenchmarkFilesystemEvidence | null
}

/**
 * Evidence is supplied by an independent validator, never inferred from model text.
 * Simulation evidence is marked explicitly and excluded from production rankings.
 */
export interface BenchmarkValidationEvidence {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION
  validatorId: string
  validatorVersion: string
  fixtureId: string
  fixtureRevision: number
  capturedAt: number
  simulated: boolean
  observations: BenchmarkValidationObservation[]
  logsDigest: string | null
}

export type BenchmarkFixtureRunStatus =
  | 'queued'
  | 'planning'
  | 'executing'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'invalid_evidence'

export interface BenchmarkFixtureRun {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION
  id: string
  fixtureId: string
  fixtureRevision: number
  category: BenchmarkCategory
  seed: number
  timeoutMs: number
  status: BenchmarkFixtureRunStatus
  startedAt: number
  finishedAt: number
  durationMs: number
  planner: BenchmarkStageMetrics | null
  executor: BenchmarkStageMetrics | null
  plannerSummary: string | null
  executorSummary: string | null
  artifactReferences: string[]
  evidence: BenchmarkValidationEvidence | null
  errorCode: string | null
  error: string | null
}

export type BenchmarkModelRunMode = 'production' | 'simulation'
export type BenchmarkModelRunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'

export interface BenchmarkModelRun {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION
  id: string
  suiteId: string
  suiteRevision: number
  suiteSeed: number
  mode: BenchmarkModelRunMode
  target: BenchmarkModelTarget
  configuration: BenchmarkRunConfiguration
  compatibilityKey: string
  status: BenchmarkModelRunStatus
  startedAt: number
  finishedAt: number | null
  fixtureRuns: BenchmarkFixtureRun[]
  error: string | null
}

export interface BenchmarkFixtureScore {
  fixtureId: string
  category: BenchmarkCategory
  score: number
  passedWeight: number
  totalWeight: number
  mandatoryFailures: string[]
}

export interface BenchmarkCategoryScore {
  category: BenchmarkCategory
  score: number
  scoredFixtures: number
  expectedFixtures: number
  complete: boolean
}

export interface BenchmarkRunScore {
  runId: string
  catalogModelId: string
  mode: BenchmarkModelRunMode
  compatibilityKey: string
  eligibleForRanking: boolean
  ineligibleReason: string | null
  overallScore: number | null
  fixtureScores: BenchmarkFixtureScore[]
  categoryScores: BenchmarkCategoryScore[]
  totalLatencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  costUsd: number | null
  usageCompleteness: BenchmarkUsageSource
}

export interface BenchmarkRankingEntry extends BenchmarkRunScore {
  rank: number
}

export interface BenchmarkCategoryRecommendation {
  category: BenchmarkCategory
  catalogModelId: string
  score: number
  comparedModels: number
  evidenceFixtures: number
  rationale: string
}

export interface BenchmarkModelFitRecommendation {
  catalogModelId: string
  strongestCategories: BenchmarkCategory[]
  overallRank: number
  rationale: string
}

export interface BenchmarkScoringPolicy {
  id: string
  categoryWeights: Record<BenchmarkCategory, number>
  fixtureNormalization: 'declared_requirement_weights'
  incompleteRunBehavior: 'exclude'
  productionSimulationBehavior: 'exclude_unless_explicit'
  tieBreakers: Array<'latency' | 'output_tokens' | 'cost' | 'catalog_model_id'>
}

export interface BenchmarkAnalysis {
  policy: BenchmarkScoringPolicy
  rankings: BenchmarkRankingEntry[]
  categoryRecommendations: BenchmarkCategoryRecommendation[]
  modelFit: BenchmarkModelFitRecommendation[]
  excludedRuns: { runId: string; reason: string }[]
}

export interface BenchmarkWorkspace {
  id: string
  rootPath: string | null
  isolation: 'temporary_directory' | 'container' | 'memory'
  sourceReadOnly: boolean
  dispose(): Promise<void>
}

export interface BenchmarkPlannerRequest {
  fixture: BenchmarkFixture
  target: BenchmarkModelTarget
  workspace: BenchmarkWorkspace
  seed: number
  signal: AbortSignal
}

export interface BenchmarkExecutorRequest extends BenchmarkPlannerRequest {
  plan: BenchmarkPlannerOutput
}

export interface BenchmarkValidationRequest extends BenchmarkExecutorRequest {
  execution: BenchmarkExecutorOutput
}

export interface BenchmarkPlannerAdapter {
  readonly id: string
  plan(request: BenchmarkPlannerRequest): Promise<BenchmarkPlannerOutput>
}

export interface BenchmarkExecutorAdapter {
  readonly id: string
  execute(request: BenchmarkExecutorRequest): Promise<BenchmarkExecutorOutput>
}

export interface BenchmarkValidatorAdapter {
  readonly id: string
  readonly version: string
  validate(request: BenchmarkValidationRequest): Promise<BenchmarkValidationEvidence>
}

export interface BenchmarkWorkspaceFactory {
  prepare(fixture: BenchmarkFixture, seed: number, signal: AbortSignal): Promise<BenchmarkWorkspace>
}

export interface BenchmarkClock {
  now(): number
  monotonic(): number
}
