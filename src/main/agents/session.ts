import type { AgentId } from './types'

export type AgentSessionId = string

export type AgentSessionMode = 'chat' | 'terminal' | 'exec' | 'loop' | 'review' | 'memory'

export type AgentSessionStatus =
  | 'created'
  | 'starting'
  | 'running'
  | 'idle'
  | 'busy'
  | 'waiting_for_permission'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'unsupported'

export type AgentSessionOrigin = 'agent_hub' | 'chat' | 'terminal' | 'loop' | 'test_lab' | 'system'

export interface AgentSession {
  id: AgentSessionId
  agentId: AgentId
  mode: AgentSessionMode
  origin: AgentSessionOrigin
  status: AgentSessionStatus
  projectPath?: string
  title?: string
  createdAt: number
  updatedAt: number
  lastActivityAt?: number
  metadata?: Record<string, unknown>
  error?: string
}

export interface AgentSessionCreateInput {
  agentId: AgentId
  mode: AgentSessionMode
  origin: AgentSessionOrigin
  projectPath?: string
  title?: string
  metadata?: Record<string, unknown>
}

export interface AgentSessionPatch {
  projectPath?: string
  title?: string
  lastActivityAt?: number
  metadata?: Record<string, unknown>
  error?: string
}

export interface AgentSessionSnapshot {
  session: AgentSession
  summary: string
  metadata?: Record<string, unknown>
}

export const AGENT_SESSION_MODES: readonly AgentSessionMode[] = [
  'chat',
  'terminal',
  'exec',
  'loop',
  'review',
  'memory'
] as const

export const AGENT_SESSION_ORIGINS: readonly AgentSessionOrigin[] = [
  'agent_hub',
  'chat',
  'terminal',
  'loop',
  'test_lab',
  'system'
] as const

export const AGENT_SESSION_STATUSES: readonly AgentSessionStatus[] = [
  'created',
  'starting',
  'running',
  'idle',
  'busy',
  'waiting_for_permission',
  'completed',
  'stopped',
  'failed',
  'unsupported'
] as const

export function isAgentSessionMode(value: unknown): value is AgentSessionMode {
  return typeof value === 'string' && (AGENT_SESSION_MODES as readonly string[]).includes(value)
}

export function isAgentSessionOrigin(value: unknown): value is AgentSessionOrigin {
  return typeof value === 'string' && (AGENT_SESSION_ORIGINS as readonly string[]).includes(value)
}

export function isAgentSessionStatus(value: unknown): value is AgentSessionStatus {
  return typeof value === 'string' && (AGENT_SESSION_STATUSES as readonly string[]).includes(value)
}
