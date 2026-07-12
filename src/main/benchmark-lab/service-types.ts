import type { CatalogModel, ModelCatalog } from '../model-catalog/types'
import type {
  BenchmarkExecutorAdapter,
  BenchmarkHardwareMetadata,
  BenchmarkModelTarget,
  BenchmarkPlannerAdapter,
  BenchmarkRunConfiguration,
  BenchmarkValidatorAdapter
} from './types'

export type BenchmarkCategoryId =
  | 'repo-repair'
  | 'multi-language'
  | 'code-generation'
  | 'debugging'
  | 'repo-understanding'
  | 'tool-agent'
  | 'long-context'
  | 'akorith-fixtures'

export type BenchmarkServiceRunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'

export interface BenchmarkSuiteOption {
  id: string
  label: string
  description: string
  categoryIds: BenchmarkCategoryId[]
}

export interface BenchmarkModelOption {
  id: string
  label: string
  providerLabel: string
  available: boolean
  unavailableReason?: string
}

export interface BenchmarkServiceCatalog {
  suites: BenchmarkSuiteOption[]
  models: BenchmarkModelOption[]
  warnings: string[]
}

export interface BenchmarkServiceSetup {
  suiteId: string
  modelIds: string[]
  seed: number
  repetitions: number
}

export interface BenchmarkServiceEvidence {
  id: string
  categoryId: BenchmarkCategoryId
  caseName: string
  status: 'passed' | 'failed' | 'error' | 'skipped'
  qualityScore: number | null
  durationMs: number | null
  promptTokens: number | null
  completionTokens: number | null
  costUsd: number | null
  hardwareLabel: string | null
  summary: string
}

export interface BenchmarkComparisonIdentity {
  /** Same workload, harness, context-affecting settings, suite revision, and seed. */
  workloadKey: string
  /** Same model, runtime, node, hardware, context, quantization, and settings. */
  environmentKey: string
  comparableRepetitions: number
  excludedRepetitions: number
}

export interface BenchmarkServiceModelResult {
  modelId: string
  modelLabel: string
  rank: number | null
  qualityScore: number
  speedTokensPerSecond: number | null
  totalTokens: number | null
  costUsd: number | null
  hardwareUtilizationPct: number | null
  categoryScores: Partial<Record<BenchmarkCategoryId, number>>
  evidence: BenchmarkServiceEvidence[]
  comparison: BenchmarkComparisonIdentity
}

export interface BenchmarkServiceRecommendation {
  id: string
  useCase: string
  modelLabel: string
  rationale: string
}

export interface BenchmarkServiceRun {
  id: string
  status: BenchmarkServiceRunStatus
  createdAt: number
  completedAt: number | null
  setup: BenchmarkServiceSetup
  results: BenchmarkServiceModelResult[]
  recommendations: BenchmarkServiceRecommendation[]
  error?: string
}

export interface BenchmarkCatalogDiscovery {
  catalog: ModelCatalog
  warnings?: string[]
}

export interface BenchmarkCatalogSource {
  discover(signal?: AbortSignal): Promise<BenchmarkCatalogDiscovery>
}

export interface BenchmarkResolvedRuntime {
  planner: BenchmarkPlannerAdapter
  executor: BenchmarkExecutorAdapter
  validator: BenchmarkValidatorAdapter
  /** Runtime-observed settings. Values that are not known must remain unknown/null. */
  configuration?: Partial<Omit<BenchmarkRunConfiguration, 'schemaVersion' | 'repetitionIndex' | 'repetitionCount' | 'hardware'>>
}

export interface BenchmarkRuntimeResolver {
  resolve(model: CatalogModel, target: BenchmarkModelTarget, signal: AbortSignal): Promise<BenchmarkResolvedRuntime>
}

export interface BenchmarkHardwareSource {
  observe(model: CatalogModel, signal: AbortSignal): Promise<BenchmarkHardwareMetadata>
}
