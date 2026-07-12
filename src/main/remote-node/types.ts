export const REMOTE_NODE_PROTOCOL_VERSION = 'akorith.remote-node.v1' as const
export const REMOTE_NODE_SCHEMA_VERSION = 1 as const

export type RemoteNodeProtocolVersion = typeof REMOTE_NODE_PROTOCOL_VERSION
export type RemoteRuntimeKind = 'ollama' | 'lm_studio' | 'vllm' | 'openai_compatible'
export type CapabilityEvidence = 'verified' | 'reported' | 'unknown'

export interface RemoteNodeSafetyPolicy {
  inferenceOnly: true
  codeToolsLocation: 'client'
  nodeFilesystemAccess: false
  nodeCommandExecution: false
  nodeGitAccess: false
}

export const REMOTE_NODE_SAFETY_POLICY: Readonly<RemoteNodeSafetyPolicy> = Object.freeze({
  inferenceOnly: true,
  codeToolsLocation: 'client',
  nodeFilesystemAccess: false,
  nodeCommandExecution: false,
  nodeGitAccess: false
})

export interface RemoteGpuDevice {
  id: string
  name: string
  utilizationPercent?: number
  memoryUsedBytes?: number
  memoryTotalBytes?: number
  temperatureC?: number
  powerWatts?: number
  processName?: string
  activeModel?: string
}

export type RemoteGpuSnapshot =
  | { status: 'observed'; devices: RemoteGpuDevice[]; reason?: never }
  | { status: 'unavailable'; devices: []; reason: string }

export interface RemoteHardwareSnapshot {
  observedAt: number
  platform: NodeJS.Platform | string
  architecture: string
  cpu: {
    logicalCores: number
    model?: string
  }
  memory: {
    totalBytes?: number
    freeBytes?: number
  }
  gpu: RemoteGpuSnapshot
}

export interface RemoteNodeLoad {
  activeGenerations: number
  queuedGenerations: number
  maxConcurrentGenerations: number
  utilizationPercent?: number
}

export interface RemoteRuntimeLoad {
  activeRequests?: number
  queuedRequests?: number
  utilizationPercent?: number
}

export interface RemoteRuntimeStatus {
  id: string
  kind: RemoteRuntimeKind
  label: string
  available: boolean
  reason?: string
  latencyMs?: number
  load?: RemoteRuntimeLoad
}

export interface RemoteModelCapabilities {
  textGeneration: true
  streaming: boolean
  cancellation: boolean
  toolUse: CapabilityEvidence
  codeEditing: CapabilityEvidence
  multiFileReasoning: CapabilityEvidence
  commandPlanning: CapabilityEvidence
}

export interface RemoteNodeModel {
  key: string
  runtimeId: string
  runtimeKind: RemoteRuntimeKind
  id: string
  name: string
  available: boolean
  unavailableReason?: string
  contextLength?: number
  quantization?: string
  requiredVramBytes?: number
  capabilities: RemoteModelCapabilities
}

export interface RemoteNodeIdentity {
  id: string
  name: string
  protocolVersion: RemoteNodeProtocolVersion
}

export interface RemoteNodeCatalog {
  schemaVersion: typeof REMOTE_NODE_SCHEMA_VERSION
  generatedAt: number
  node: RemoteNodeIdentity
  hardware: RemoteHardwareSnapshot
  load: RemoteNodeLoad
  runtimes: RemoteRuntimeStatus[]
  models: RemoteNodeModel[]
  safety: RemoteNodeSafetyPolicy
  warnings: string[]
}

export interface RemoteNodeHealth {
  schemaVersion: typeof REMOTE_NODE_SCHEMA_VERSION
  checkedAt: number
  node: RemoteNodeIdentity
  hardware: RemoteHardwareSnapshot
  load: RemoteNodeLoad
  runtimeCount: number
  modelCount: number
  safety: RemoteNodeSafetyPolicy
}

export interface GenerationMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface RemoteGenerationRequest {
  modelKey: string
  messages: GenerationMessage[]
  maxOutputTokens?: number
  temperature?: number
  safety: RemoteNodeSafetyPolicy
}

export interface AdapterGenerationRequest {
  generationId: string
  modelId: string
  messages: GenerationMessage[]
  maxOutputTokens?: number
  temperature?: number
}

export type AdapterGenerationChunk =
  | { type: 'delta'; text: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; cachedTokens?: number }

export type RemoteGenerationEvent =
  | { type: 'started'; generationId: string; modelKey: string; at: number }
  | { type: 'delta'; generationId: string; text: string; index: number }
  | {
      type: 'usage'
      generationId: string
      promptTokens?: number
      completionTokens?: number
      cachedTokens?: number
    }
  | { type: 'completed'; generationId: string; at: number }
  | { type: 'cancelled'; generationId: string; at: number }
  | { type: 'error'; generationId: string; at: number; code: string; message: string }

export type RemoteRequestKind = 'health' | 'catalog' | 'generate' | 'cancel'

export interface RemoteRequestEnvelope<TKind extends RemoteRequestKind, TBody> {
  protocolVersion: RemoteNodeProtocolVersion
  requestId: string
  kind: TKind
  bearerToken: string
  body: TBody
}

export type HealthRequestEnvelope = RemoteRequestEnvelope<'health', Record<string, never>>
export type CatalogRequestEnvelope = RemoteRequestEnvelope<'catalog', { refresh?: boolean }>
export type GenerateRequestEnvelope = RemoteRequestEnvelope<'generate', RemoteGenerationRequest>
export type CancelRequestEnvelope = RemoteRequestEnvelope<'cancel', { generationId: string }>

export type RemoteNodeRequest =
  | HealthRequestEnvelope
  | CatalogRequestEnvelope
  | GenerateRequestEnvelope
  | CancelRequestEnvelope

export interface RemoteHealthResponse {
  protocolVersion: RemoteNodeProtocolVersion
  requestId: string
  kind: 'health'
  health: RemoteNodeHealth
}

export interface RemoteCatalogResponse {
  protocolVersion: RemoteNodeProtocolVersion
  requestId: string
  kind: 'catalog'
  catalog: RemoteNodeCatalog
}

export interface RemoteCancelResponse {
  protocolVersion: RemoteNodeProtocolVersion
  requestId: string
  kind: 'cancel'
  generationId: string
  cancelled: boolean
}

export interface RemoteGenerationStreamResponse {
  protocolVersion: RemoteNodeProtocolVersion
  requestId: string
  kind: 'generation_stream'
  generationId: string
  stream: AsyncIterable<RemoteGenerationEvent>
}

export type RemoteNodeResponse =
  | RemoteHealthResponse
  | RemoteCatalogResponse
  | RemoteCancelResponse
  | RemoteGenerationStreamResponse

export interface RuntimeProbeResult {
  available: boolean
  reason?: string
  load?: RemoteRuntimeLoad
}

export interface RuntimeModelDescription {
  id: string
  name: string
  available?: boolean
  unavailableReason?: string
  contextLength?: number
  quantization?: string
  requiredVramBytes?: number
  capabilities: RemoteModelCapabilities
}

export interface RemoteRuntimeAdapter {
  readonly id: string
  readonly kind: RemoteRuntimeKind
  readonly label: string
  probe(signal: AbortSignal): Promise<RuntimeProbeResult>
  listModels(signal: AbortSignal): Promise<readonly RuntimeModelDescription[]>
  generate(request: AdapterGenerationRequest, signal: AbortSignal): AsyncIterable<AdapterGenerationChunk>
}

export interface RemoteRuntimeDiscoveryAdapter {
  readonly kind: RemoteRuntimeKind
  discover(signal: AbortSignal): Promise<readonly RemoteRuntimeAdapter[]>
}

export interface ClientRemoteModel {
  id: string
  providerId: string
  providerLabel: string
  nodeId: string
  nodeName: string
  runtimeId: string
  runtimeKind: RemoteRuntimeKind
  modelId: string
  modelName: string
  location: 'remote'
  available: boolean
  contextLength?: number
  quantization?: string
  requiredVramBytes?: number
  runtimeLatencyMs?: number
  runtimeLoad?: RemoteRuntimeLoad
  nodeLoad: RemoteNodeLoad
  capabilities: RemoteModelCapabilities
  codeExecutorEligible: boolean
  executionPolicy: RemoteNodeSafetyPolicy
}
