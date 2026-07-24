/**
 * Stable persistence ids for the duration-first Research control. `quick`,
 * `standard`, and `deep` stay intact so existing databases and exported
 * reports remain readable after the UI moves from named tiers to time labels.
 */
export const RESEARCH_DEPTHS = [
  'quick',
  'standard',
  'focused3h',
  'extended6h',
  'deep',
  'day',
  'continuous'
] as const
export type ResearchDepth = (typeof RESEARCH_DEPTHS)[number]

export const RESEARCH_OUTPUT_FORMATS = ['pdf', 'md', 'docx', 'xlsx', 'pptx'] as const
export type ResearchOutputFormat = (typeof RESEARCH_OUTPUT_FORMATS)[number]

export const RESEARCH_STATUSES = [
  'draft',
  'planning',
  'researching',
  'verifying',
  'synthesizing',
  'exporting',
  'completed',
  'paused',
  'error',
  'archived'
] as const
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number]

export const RESEARCH_PHASES = ['understand', 'plan', 'research', 'verify', 'synthesize', 'export'] as const
export type ResearchPhase = (typeof RESEARCH_PHASES)[number]

export const RESEARCH_EVENT_KINDS = [
  'created',
  'planning_started',
  'plan_ready',
  'cycle_started',
  'source_found',
  'finding_added',
  'verification_started',
  'source_verified',
  'synthesis_started',
  'export_started',
  'artifact_created',
  'cycle_completed',
  'paused',
  'resumed',
  'completed',
  'warning',
  'error',
  'note'
] as const
export type ResearchEventKind = (typeof RESEARCH_EVENT_KINDS)[number]

export interface ResearchDepthProfile {
  id: ResearchDepth
  label: string
  description: string
  targetDurationMs: number
  cycleIntervalMs: number
  maxCycles: number
  sourceTarget: number
}

export const RESEARCH_DEPTH_PROFILES: Record<ResearchDepth, ResearchDepthProfile> = {
  quick: {
    id: 'quick',
    label: 'Quick search',
    description: 'A focused evidence program with a minimum research window of 10 minutes.',
    targetDurationMs: 10 * 60_000,
    cycleIntervalMs: 20_000,
    maxCycles: 4,
    sourceTarget: 8
  },
  standard: {
    id: 'standard',
    label: 'Research',
    description: 'A broader, cross-checked investigation with a minimum research window of one hour.',
    targetDurationMs: 60 * 60_000,
    cycleIntervalMs: 45_000,
    maxCycles: 12,
    sourceTarget: 24
  },
  focused3h: {
    id: 'focused3h',
    label: '3-hour research',
    description: 'A sustained three-hour investigation with broader corroboration and follow-up passes.',
    targetDurationMs: 3 * 60 * 60_000,
    cycleIntervalMs: 60_000,
    maxCycles: 24,
    sourceTarget: 40
  },
  extended6h: {
    id: 'extended6h',
    label: '6-hour research',
    description: 'An extended six-hour evidence program for complex, multi-angle questions.',
    targetDurationMs: 6 * 60 * 60_000,
    cycleIntervalMs: 90_000,
    maxCycles: 36,
    sourceTarget: 56
  },
  deep: {
    id: 'deep',
    label: '10-hour research',
    description: 'A deep ten-hour evidence program with repeated verification and contradiction checks.',
    targetDurationMs: 10 * 60 * 60_000,
    cycleIntervalMs: 2 * 60_000,
    maxCycles: 60,
    sourceTarget: 80
  },
  day: {
    id: 'day',
    label: '24-hour research',
    description: 'A full-day research program for broad evidence coverage and measured re-verification.',
    targetDurationMs: 24 * 60 * 60_000,
    cycleIntervalMs: 5 * 60_000,
    maxCycles: 96,
    sourceTarget: 120
  },
  continuous: {
    id: 'continuous',
    label: 'Continuous research',
    description: 'Keeps watching for new evidence until you explicitly pause or complete it.',
    targetDurationMs: 0,
    cycleIntervalMs: 15 * 60_000,
    maxCycles: 0,
    sourceTarget: 0
  }
}

export interface ResearchPlanSection {
  id: string
  title: string
  objective: string
  queries: string[]
  status: 'pending' | 'active' | 'complete'
}

export interface ResearchPlan {
  title: string
  thesis: string
  deliverable: string
  sections: ResearchPlanSection[]
  sourceStrategy: string[]
  verificationCriteria: string[]
}

export interface ResearchJob {
  id: string
  title: string
  prompt: string
  status: ResearchStatus
  phase: ResearchPhase
  providerId: string
  model?: string
  depth: ResearchDepth
  outputFormat: ResearchOutputFormat
  targetDurationMs: number
  maxCycles: number
  sourceTarget: number
  cycleCount: number
  sourceCount: number
  findingCount: number
  workspaceDir: string
  artifactPath?: string
  coverPath?: string
  plan?: ResearchPlan
  summary?: string
  error?: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  activeElapsedMs: number
  activeAccountingAt?: number
  completedAt?: number
  nextRunAt?: number
  heartbeatAt?: number
  revision: number
}

export type ResearchCycleStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ResearchCycle {
  id: string
  jobId: string
  cycleIndex: number
  phase: ResearchPhase
  status: ResearchCycleStatus
  objective: string
  result?: string
  sourceCount: number
  findingCount: number
  promptTokens?: number
  completionTokens?: number
  startedAt: number
  endedAt?: number
  error?: string
}

export interface ResearchEvent {
  id: string
  jobId: string
  cycleId?: string
  kind: ResearchEventKind
  title: string
  detail?: string
  createdAt: number
}

export interface ResearchSource {
  id: string
  jobId: string
  cycleId?: string
  url: string
  title: string
  publisher?: string
  publishedAt?: string
  accessedAt: number
  excerpt?: string
  relevance?: string
  credibilityScore?: number
  contentHash?: string
  verified: boolean
}

export type ResearchClaimStatus = 'unverified' | 'verified' | 'conflicted' | 'unsupported'
export type ResearchEvidenceRelation = 'supports' | 'contradicts' | 'context'

export interface ResearchClaimEvidence {
  sourceId: string
  evidence?: string
  relation: ResearchEvidenceRelation
}

export interface ResearchClaim {
  id: string
  jobId: string
  cycleId?: string
  sectionId?: string
  text: string
  confidenceScore: number
  status: ResearchClaimStatus
  evidence: ResearchClaimEvidence[]
  createdAt: number
  updatedAt: number
}

export interface ResearchArtifact {
  id: string
  jobId: string
  format: ResearchOutputFormat
  title: string
  path: string
  coverPath?: string
  byteSize: number
  status: 'ready' | 'invalid'
  checksum?: string
  mimeType?: string
  version: number
  pageCount?: number
  validationError?: string
  createdAt: number
}

export interface CreateResearchJobInput {
  prompt: string
  title?: string
  providerId: string
  model?: string
  depth: ResearchDepth
  outputFormat: ResearchOutputFormat
  autoStart?: boolean
}

export interface ResearchWorkspaceState {
  version: 1
  jobId: string
  cycleCount: number
  currentPhase: ResearchPhase
  completedSections: string[]
  openQuestions: string[]
  sourceCount: number
  findingCount: number
  readyToSynthesize: boolean
  updatedAt: number
}

export interface ResearchCheckpoint {
  id: string
  jobId: string
  cycleId?: string
  idempotencyKey: string
  phase: ResearchPhase
  state: ResearchWorkspaceState
  createdAt: number
}

export interface ResearchCycleResult {
  ok: boolean
  job: ResearchJob
  cycle?: ResearchCycle
  completed: boolean
  error?: string
}
