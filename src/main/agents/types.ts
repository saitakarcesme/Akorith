import type { AgentSession, AgentSessionCreateInput, AgentSessionSnapshot } from './session'
import type { AgentRuntimeCapability } from './runtime'

export type AgentId = 'claude' | 'codex' | 'ollama' | 'opencode' | 'memory'

export type AgentKind = 'cli' | 'local' | 'memory' | 'future'

export type AgentStatus = 'unknown' | 'available' | 'missing' | 'unauthenticated' | 'disabled' | 'error'

export type AgentCapability =
  | 'chat'
  | 'terminal'
  | 'exec'
  | 'streaming'
  | 'file_patch'
  | 'test_generation'
  | 'review'
  | 'commit'
  | 'memory'
  | 'skills'
  | 'automation'
  | 'mission_planning'

export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'ollama', 'opencode', 'memory'] as const

export interface AgentAdapterMetadata {
  id: AgentId
  displayName: string
  kind: AgentKind
  description: string
  executableName?: string
  status: AgentStatus
  capabilities: AgentCapability[]
  currentIntegrationNotes: string[]
  futureIntegrationNotes: string[]
  safetyNotes: string[]
}

export type AgentIntegrationStage =
  | 'metadata-only'
  | 'detection-ready'
  | 'session-placeholder-ready'
  | 'runtime-connected-existing-provider'
  | 'future-runtime'

export interface AgentAdapterInfo extends AgentAdapterMetadata {
  runtimeCapabilities: AgentRuntimeCapability
  integrationStage: AgentIntegrationStage
}

export interface AgentDetectionResult {
  id: AgentId
  status: AgentStatus
  version?: string
  executablePath?: string
  message?: string
  checkedAt: number
}

export interface AgentAdapter {
  metadata: AgentAdapterMetadata
  detect(): Promise<AgentDetectionResult>
  getRuntimeCapabilities?(): AgentRuntimeCapability
  createSession?(input: AgentSessionCreateInput): Promise<AgentSession>
  stopSession?(sessionId: string): Promise<void>
  getSessionSnapshot?(sessionId: string): Promise<AgentSessionSnapshot>
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value)
}
