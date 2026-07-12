export type AgentId = 'claude' | 'codex' | 'ollama' | 'opencode' | 'memory'

export type AgentKind = 'cli' | 'local' | 'memory'

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

export interface AgentAdapterMetadata {
  id: AgentId
  displayName: string
  kind: AgentKind
  description: string
  executableName?: string
  status: AgentStatus
  capabilities: AgentCapability[]
  currentIntegrationNotes: string[]
  safetyNotes: string[]
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
}
