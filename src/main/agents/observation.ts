import type { AgentId } from './types'
import type { AgentSession } from './session'

export type AgentRuntimeAttachmentKind =
  | 'provider_call'
  | 'pty_session'
  | 'ollama_connection'
  | 'loop_run'
  | 'test_run'
  | 'system'

export type AgentRuntimeAttachmentStatus =
  | 'observed'
  | 'active'
  | 'idle'
  | 'busy'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'unknown'

export interface AgentRuntimeAttachment {
  id: string
  kind: AgentRuntimeAttachmentKind
  agentId?: AgentId
  sessionId?: string
  externalId?: string
  status: AgentRuntimeAttachmentStatus
  sourceFile?: string
  projectPath?: string
  title?: string
  startedAt?: number
  updatedAt: number
  lastActivityAt?: number
  metadata?: Record<string, unknown>
  error?: string
}

export interface AgentRuntimeAttachmentCreateInput {
  kind: AgentRuntimeAttachmentKind
  agentId?: AgentId
  externalId?: string
  status: AgentRuntimeAttachmentStatus
  sourceFile?: string
  projectPath?: string
  title?: string
  startedAt?: number
  lastActivityAt?: number
  metadata?: Record<string, unknown>
  error?: string
}

export interface AgentRuntimeAttachmentPatch {
  status?: AgentRuntimeAttachmentStatus
  projectPath?: string
  title?: string
  lastActivityAt?: number
  metadata?: Record<string, unknown>
  error?: string
}

export interface AgentRuntimeSnapshot {
  checkedAt: number
  activeProviderCalls: AgentRuntimeAttachment[]
  activePtySessions: AgentRuntimeAttachment[]
  ollamaStatus?: AgentRuntimeAttachment
  observedSessions: AgentSession[]
  notes?: string[]
}

export function safeRuntimeError(err: unknown, max = 300): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/\s+/g, ' ').trim().slice(0, max) || 'runtime observation error'
}
