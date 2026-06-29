import type { AgentId } from './types'
import type { AgentSessionId } from './session'

export type AgentSessionEventType =
  | 'created'
  | 'status_changed'
  | 'stopped'
  | 'snapshot'
  | 'error'
  | 'note'

export interface AgentSessionEvent {
  id: string
  sessionId: AgentSessionId
  agentId: AgentId
  type: AgentSessionEventType
  message?: string
  timestamp: number
  metadata?: Record<string, unknown>
}

export interface AgentSessionEventInput {
  sessionId: AgentSessionId
  agentId: AgentId
  type: AgentSessionEventType
  message?: string
  metadata?: Record<string, unknown>
}
