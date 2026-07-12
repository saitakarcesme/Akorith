export const LOOP_STATUSES = [
  'setting_up',
  'running',
  'pausing',
  'paused',
  'stopping',
  'stopped',
  'completed',
  'error'
] as const

export type AutonomousLoopStatus = (typeof LOOP_STATUSES)[number]

export const LOOP_STAGES = [
  'idle',
  'observing',
  'analyzing',
  'inventory',
  'planning',
  'executing',
  'validating',
  'repairing',
  'reviewing',
  'committing',
  'pushing',
  'scheduling'
] as const

export type AutonomousLoopStage = (typeof LOOP_STAGES)[number]
export type LoopTaskKind = 'code' | 'test' | 'documentation' | 'refactor' | 'bug_fix' | 'infrastructure'
export type LoopRiskLevel = 'low' | 'medium' | 'high'
export type LoopExecutionLocation = 'local' | 'remote' | 'cloud'

export type LoopProjectSource =
  | {
      kind: 'new'
      parentPath: string
      projectName: string
      remoteUrl?: string
      createRemoteWithPlugin?: boolean
      githubOwner?: string
      githubVisibility?: 'private' | 'public'
    }
  | {
      kind: 'existing_github'
      remoteUrl: string
    }

export interface LoopExecutorSelection {
  catalogId: string
  providerId: string
  model: string
  location: LoopExecutionLocation
  nodeId?: string
  capabilityProbeId: string
}

export interface LoopPlannerSelection {
  catalogId: string
  providerId: string
  model: string
  location: LoopExecutionLocation
  nodeId?: string
}

export interface LoopSafetyLimits {
  maxRepairAttempts: number
  maxConsecutiveInfrastructureFailures: number
  tokenLimit: number | null
  costLimitUsd: number | null
  validationTimeoutMs: number
}

export interface CreateAutonomousLoopInput {
  source: LoopProjectSource
  executor: LoopExecutorSelection
  planner?: LoopPlannerSelection
  limits?: Partial<LoopSafetyLimits>
}

export interface AutonomousLoopRecord {
  id: string
  projectName: string
  status: AutonomousLoopStatus
  stage: AutonomousLoopStage
  repositoryId: string
  workspacePath: string
  remoteUrl: string
  branch: string
  executor: LoopExecutorSelection
  planner: LoopPlannerSelection
  limits: LoopSafetyLimits
  createdAt: number
  updatedAt: number
  startedAt: number | null
  pausedAt: number | null
  stoppedAt: number | null
  completedAt: number | null
  lastActivityAt: number | null
  nextCycleAt: number | null
  activeCycleId: string | null
  consecutiveInfrastructureFailures: number
  tokenUsage: LoopTokenUsage
  commitCount: number
  pushCount: number
  successfulTasks: number
  failedTasks: number
  stopReason: string | null
  error: string | null
}

export interface LoopTokenUsage {
  input: number
  output: number
  cached: number
  costUsd: number
}

export interface LoopDetectedCommand {
  kind: 'test' | 'lint' | 'typecheck' | 'build'
  command: string
  source: string
}

export interface RepositorySnapshot {
  repositoryId: string
  capturedAt: number
  headSha: string | null
  branch: string
  dirty: boolean
  fileCount: number
  files: string[]
  languages: { name: string; files: number }[]
  frameworks: string[]
  packageManagers: string[]
  packageScripts: Record<string, string>
  detectedCommands: LoopDetectedCommand[]
  readmeExcerpt: string | null
  recentCommits: string[]
  todoItems: { file: string; line: number; text: string }[]
  buildStatus: 'unknown' | 'passing' | 'failing'
  testStatus: 'unknown' | 'passing' | 'failing' | 'not_configured'
  dependencySignals: string[]
  routes: string[]
  components: string[]
}

export interface ProjectFeatureInventory {
  snapshotCapturedAt: number
  generatedAt: number
  existingCapabilities: string[]
  incompleteCapabilities: string[]
  brokenBehavior: string[]
  technicalDebt: string[]
  testGaps: string[]
  documentationGaps: string[]
  securityConcerns: string[]
  performanceOpportunities: string[]
  highValueNextSteps: string[]
}

export interface LoopPlannedTask {
  title: string
  proposedTask: string
  reason: string
  expectedUserValue: string
  likelyAreas: string[]
  acceptanceCriteria: string[]
  validationCommands: string[]
  riskLevel: LoopRiskLevel
  estimatedComplexity: 'small' | 'medium' | 'large'
  kind: LoopTaskKind
}

export interface LoopCommandEvidence {
  kind: 'test' | 'lint' | 'typecheck' | 'build' | 'targeted'
  command: string
  startedAt: number
  durationMs: number
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

export interface LoopValidationResult {
  passed: boolean
  commands: LoopCommandEvidence[]
  changedFiles: string[]
  regressionDetected: boolean
  failureSummary: string | null
}

export interface LoopReviewResult {
  accepted: boolean
  acceptanceCriteriaMet: string[]
  acceptanceCriteriaMissed: string[]
  relevantDiff: boolean
  placeholdersDetected: string[]
  deletedTestsDetected: string[]
  secretFindings: string[]
  unrelatedFiles: string[]
  generatedFilesReviewed: string[]
  rationale: string
}

export type LoopCycleStatus =
  | 'queued'
  | 'running'
  | 'repairing'
  | 'validated'
  | 'committed'
  | 'pushed'
  | 'reverted'
  | 'failed'
  | 'cancelled'

export interface LoopCycleRecord {
  id: string
  loopId: string
  index: number
  status: LoopCycleStatus
  stage: AutonomousLoopStage
  plannedTask: LoopPlannedTask | null
  executorCatalogId: string
  executorProviderId: string
  executorModel: string
  plannerCatalogId: string
  plannerProviderId: string
  plannerModel: string
  reviewerCatalogId: string | null
  reviewerProviderId: string | null
  reviewerModel: string | null
  repairAttempts: number
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  validation: LoopValidationResult | null
  review: LoopReviewResult | null
  changedFiles: string[]
  commitSha: string | null
  commitMessage: string | null
  pushed: boolean
  tokenUsage: LoopTokenUsage
  summary: string | null
  error: string | null
}

export type LoopActivityLevel = 'info' | 'success' | 'warning' | 'error'

export interface LoopActivityEvent {
  id: string
  loopId: string
  cycleId: string | null
  occurredAt: number
  stage: AutonomousLoopStage
  level: LoopActivityLevel
  kind: string
  title: string
  summary: string
  details: Record<string, string | number | boolean | null>
}

export interface LoopRepositoryLease {
  repositoryId: string
  loopId: string
  acquiredAt: number
  heartbeatAt: number
  expiresAt: number
  processId: number
}

export interface LoopEngineDecision {
  continue: boolean
  status: AutonomousLoopStatus
  reason: string | null
}
