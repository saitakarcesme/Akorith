import type {
  RemoteGenerationEvent,
  RemoteGenerationRequest,
  RemoteNodeCatalog,
  RemoteNodeHealth
} from './types'
import type { RemoteNodePairingResult } from './http-transport'

export const REMOTE_NODE_CLIENT_STATE_VERSION = 1 as const

export type RemoteNodeConnectionPhase = 'idle' | 'connecting' | 'online' | 'degraded' | 'offline'

/** Persisted connection metadata. Authentication material is deliberately absent. */
export interface RemoteNodeProfile {
  id: string
  nodeId: string
  name: string
  baseUrl: string
  protocolVersion: string
  deviceId: string
  deviceName: string
  createdAt: number
  updatedAt: number
  privateLanHttpAcknowledged: boolean
}

export interface RemoteNodeConnectionState {
  phase: RemoteNodeConnectionPhase
  consecutiveFailures: number
  lastCheckedAt?: number
  lastHealthyAt?: number
  nextRetryAt?: number
  latencyMs?: number
  error?: string
}

export interface ManagedRemoteNode extends RemoteNodeProfile {
  connection: RemoteNodeConnectionState
}

export interface PersistedRemoteNodeClientState {
  schemaVersion: typeof REMOTE_NODE_CLIENT_STATE_VERSION
  profiles: RemoteNodeProfile[]
}

export interface PairRemoteNodeInput {
  baseUrl: string
  pairingId: string
  code: string
  deviceName: string
  /** Must be true for plaintext HTTP, and is accepted only for a provably private LAN address. */
  acknowledgePrivateLanHttp?: boolean
}

export interface RemoteNodePairingView {
  node: ManagedRemoteNode
  replacedExistingProfile: boolean
}

export interface RemoteNodeTestResult {
  node: ManagedRemoteNode
  health?: RemoteNodeHealth
}

/** Minimal client contract consumed by catalog, executor, and GPU integrations. */
export interface ManagedRemoteNodeClient {
  readonly baseUrl: string
  pair(input: { pairingId: string; code: string; deviceName: string }, signal?: AbortSignal): Promise<RemoteNodePairingResult>
  health(signal?: AbortSignal): Promise<RemoteNodeHealth>
  catalog(refresh?: boolean, signal?: AbortSignal): Promise<RemoteNodeCatalog>
  revoke(signal?: AbortSignal): Promise<boolean>
  cancel(generationId: string, signal?: AbortSignal): Promise<boolean>
  generate(body: RemoteGenerationRequest, signal?: AbortSignal): AsyncIterable<RemoteGenerationEvent>
}

export interface RemoteNodeClientHandle {
  profile: RemoteNodeProfile
  client: ManagedRemoteNodeClient
}

export interface RemoteNodeTokenVault {
  get(profileId: string): Promise<string | undefined>
  set(profileId: string, token: string): Promise<void>
  delete(profileId: string): Promise<void>
}
