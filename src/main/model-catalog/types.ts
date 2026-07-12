export const MODEL_SOURCES = ['local', 'remote', 'cloud'] as const
export type ModelSource = (typeof MODEL_SOURCES)[number]

export const MODEL_PROVIDER_FAMILIES = [
  'openai',
  'anthropic',
  'opencode',
  'ollama',
  'openai_compatible',
  'other'
] as const
export type ModelProviderFamily = (typeof MODEL_PROVIDER_FAMILIES)[number]

export const MODEL_CAPABILITIES = [
  'file_read',
  'file_edit',
  'file_create',
  'file_delete',
  'command_execution',
  'tool_use',
  'multi_file_reasoning',
  'code_generation',
  'test_execution',
  'debugging',
  'iterative_repair',
  'streaming_status',
  'reasoning'
] as const
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number]

export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown'
export type CapabilityDeclaration = Partial<Record<ModelCapability, CapabilitySupport | boolean>>
export type CapabilityAssessmentSource = 'unknown' | 'provider' | 'model' | 'probe'

export interface CapabilityAssessment {
  support: CapabilitySupport
  source: CapabilityAssessmentSource
  verifiedAt: number | null
}

export type CapabilityAssessmentMap = Record<ModelCapability, CapabilityAssessment>

export type CatalogAvailabilityStatus = 'available' | 'unavailable' | 'unknown'

export interface CatalogAvailability {
  status: CatalogAvailabilityStatus
  reason: string | null
  checkedAt: number | null
}

export type SnapshotAvailability =
  | boolean
  | {
      ok?: boolean
      status?: CatalogAvailabilityStatus
      reason?: string
      checkedAt?: number
    }

export interface ProviderModelSnapshot {
  id?: string
  name: string
  label?: string
  available?: SnapshotAvailability
  contextWindowTokens?: number
  quantization?: string
  vramRequirementMb?: number
  currentLoadPercent?: number
  pingMs?: number
  capabilities?: CapabilityDeclaration
  metadata?: Record<string, string | number | boolean | null>
}

export interface ProviderCatalogSnapshot {
  providerId: string
  providerLabel: string
  family?: ModelProviderFamily
  source?: ModelSource
  /** Stable machine identifier for local/remote providers. */
  nodeId?: string
  nodeName?: string
  availability: SnapshotAvailability
  capabilities?: CapabilityDeclaration
  models: readonly (string | ProviderModelSnapshot)[]
}

/** Shape emitted by the current provider registry (`describeProviders`). */
export interface RegistryProviderSnapshot {
  id: string
  label: string
  available: SnapshotAvailability
  models: readonly (string | ProviderModelSnapshot)[]
  family?: ModelProviderFamily
  source?: ModelSource
  nodeId?: string
  nodeName?: string
  capabilities?: CapabilityDeclaration
}

export interface RemoteNodeModelSnapshot extends ProviderModelSnapshot {
  runtime?: 'ollama' | 'lm_studio' | 'vllm' | 'openai_compatible' | 'other'
  providerId?: string
  providerLabel?: string
  family?: ModelProviderFamily
}

export interface RemoteNodeCatalogSnapshot {
  nodeId: string
  nodeName: string
  availability: SnapshotAvailability
  currentLoadPercent?: number
  pingMs?: number
  capabilities?: CapabilityDeclaration
  models: readonly RemoteNodeModelSnapshot[]
}

export interface CatalogModel {
  id: string
  providerId: string
  providerLabel: string
  family: ModelProviderFamily
  source: ModelSource
  modelName: string
  label: string
  displayLabel: string
  nodeId: string | null
  nodeName: string | null
  availability: CatalogAvailability
  contextWindowTokens: number | null
  quantization: string | null
  vramRequirementMb: number | null
  currentLoadPercent: number | null
  pingMs: number | null
  declaredCapabilities: CapabilityAssessmentMap
  effectiveCapabilities: CapabilityAssessmentMap
  /** Latest code-execution probe; reasoning-only probes never satisfy Loop gating. */
  latestProbe: ModelCapabilityProbeRecord | null
  latestReasoningProbe: ModelCapabilityProbeRecord | null
  metadata: Record<string, string | number | boolean | null>
}

export type ProbeStatus = 'running' | 'succeeded' | 'failed' | 'unavailable' | 'cancelled' | 'error'
export type ProbeKind = 'code_execution' | 'reasoning'
export type ProbeCapabilityOutcome = 'confirmed' | 'rejected' | 'not_tested'

export interface ProbeCapabilityObservation {
  outcome: ProbeCapabilityOutcome
  summary?: string
}

export interface ModelCapabilityProbeRecord {
  schemaVersion: 1
  id: string
  catalogModelId: string
  probeKind: ProbeKind
  probeVersion: string
  status: ProbeStatus
  startedAt: number
  completedAt: number | null
  freshUntil: number | null
  providerId: string
  modelName: string
  source: ModelSource
  nodeId: string | null
  capabilities: Partial<Record<ModelCapability, ProbeCapabilityObservation>>
  failureCode?: string
  failureMessage?: string
  durationMs?: number
}

export type ProbeFreshnessState = 'fresh' | 'stale' | 'incomplete' | 'future' | 'invalid'

export interface ProbeFreshness {
  state: ProbeFreshnessState
  ageMs: number | null
}

export const LOOP_EXECUTOR_MANDATORY_CAPABILITIES = [
  'file_read',
  'file_edit',
  'file_create',
  'file_delete',
  'command_execution',
  'tool_use',
  'multi_file_reasoning',
  'code_generation',
  'test_execution',
  'debugging',
  'iterative_repair',
  'streaming_status'
] as const satisfies readonly ModelCapability[]

export type ModelEligibilityCode =
  | 'eligible'
  | 'model_unavailable'
  | 'reasoning_not_supported'
  | 'probe_missing'
  | 'probe_running'
  | 'probe_failed'
  | 'probe_unavailable'
  | 'probe_cancelled'
  | 'probe_error'
  | 'probe_stale'
  | 'probe_future'
  | 'probe_invalid'
  | 'mandatory_capability_missing'

export interface ModelEligibility {
  selectable: boolean
  code: ModelEligibilityCode
  reason: string
  missingCapabilities: ModelCapability[]
  probeFreshness: ProbeFreshness | null
}

export interface ModelCatalog {
  generatedAt: number
  models: CatalogModel[]
  collisions: string[]
}

export interface BuildModelCatalogInput {
  providers: readonly (ProviderCatalogSnapshot | RegistryProviderSnapshot)[]
  remoteNodes?: readonly RemoteNodeCatalogSnapshot[]
  probes?: readonly ModelCapabilityProbeRecord[]
  generatedAt?: number
}

export interface RoutingProfile {
  schemaVersion: 1
  id: string
  name: string
  plannerModelId: string
  loopExecutorModelId: string
  debuggerModelId?: string
  fallbackLoopExecutorModelIds: string[]
  createdAt: number
  updatedAt: number
}

export type RoutingProfileIssueCode =
  | 'invalid_shape'
  | 'duplicate_fallback'
  | 'model_not_found'
  | 'planner_ineligible'
  | 'executor_ineligible'

export interface RoutingProfileIssue {
  code: RoutingProfileIssueCode
  field: string
  message: string
}

export type RoutingProfileValidation =
  | { ok: true; profile: RoutingProfile }
  | { ok: false; issues: RoutingProfileIssue[] }
