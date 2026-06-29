import type { AgentId } from '../agents/types'

export type MissionId = string

export type MissionStatus =
  | 'draft'
  | 'ready'
  | 'planning'
  | 'awaiting_user_choice'
  | 'running'
  | 'paused'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unsupported'

export type MissionStepId = string

export type MissionStepKind =
  | 'inspect'
  | 'plan'
  | 'execute'
  | 'test'
  | 'review'
  | 'commit'
  | 'handoff'
  | 'memory'
  | 'user_choice'
  | 'report'

export type MissionStepStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'unsupported'

export type MissionAgentRole =
  | 'planner'
  | 'executor'
  | 'reviewer'
  | 'tester'
  | 'committer'
  | 'memory'
  | 'observer'

export type MissionRiskLevel = 'low' | 'medium' | 'high' | 'destructive'

export type MissionPermissionMode =
  | 'read_only'
  | 'ask_before_write'
  | 'allow_safe_writes'
  | 'allow_commits'
  | 'manual_only'

export type MissionOrigin = 'dashboard' | 'loop' | 'agent_hub' | 'workspace' | 'system'

export interface Mission {
  id: MissionId
  title: string
  description?: string
  status: MissionStatus
  projectPath?: string
  createdAt: number
  updatedAt: number
  origin: MissionOrigin
  permissionMode: MissionPermissionMode
  riskLevel: MissionRiskLevel
  steps: MissionStep[]
  metadata?: Record<string, unknown>
  notes?: string[]
}

export interface MissionStep {
  id: MissionStepId
  missionId: MissionId
  index: number
  title: string
  kind: MissionStepKind
  status: MissionStepStatus
  agentRole?: MissionAgentRole
  preferredAgentId?: AgentId
  dependsOn?: MissionStepId[]
  riskLevel: MissionRiskLevel
  permissionMode: MissionPermissionMode
  createdAt: number
  updatedAt: number
  summary?: string
  safePreview?: string
  metadata?: Record<string, unknown>
}

export interface MissionEvent {
  id: string
  missionId: MissionId
  stepId?: MissionStepId
  type: string
  message: string
  timestamp: number
  metadata?: Record<string, unknown>
}

export interface MissionPolicy {
  id: string
  name: string
  permissionMode: MissionPermissionMode
  allowProviderCalls: boolean
  allowPtyWrites: boolean
  allowFileWrites: boolean
  allowTests: boolean
  allowCommits: boolean
  allowPush: boolean
  requireUserApprovalForRiskAbove?: MissionRiskLevel
}

export interface MissionCreateInput {
  title?: string
  description?: string
  projectPath?: string
  origin?: MissionOrigin
  permissionMode?: MissionPermissionMode
  metadata?: Record<string, unknown>
}

export interface MissionTemplateStep {
  title: string
  kind: MissionStepKind
  agentRole?: MissionAgentRole
  preferredAgentId?: AgentId
  dependsOn?: number[]
  riskLevel?: MissionRiskLevel
  permissionMode?: MissionPermissionMode
  status?: MissionStepStatus
  summary?: string
  safePreview?: string
  metadata?: Record<string, unknown>
}

export interface MissionTemplate {
  id: string
  title: string
  description: string
  riskLevel: MissionRiskLevel
  permissionMode: MissionPermissionMode
  steps: MissionTemplateStep[]
  notes?: string[]
  metadata?: Record<string, unknown>
}

export interface MissionPreviewPlan {
  title: string
  description?: string
  origin: MissionOrigin
  permissionMode: MissionPermissionMode
  riskLevel: MissionRiskLevel
  policy: MissionPolicy
  steps: MissionStep[]
  warnings: string[]
  notes: string[]
}

export const MISSION_STATUSES: readonly MissionStatus[] = [
  'draft',
  'ready',
  'planning',
  'awaiting_user_choice',
  'running',
  'paused',
  'reviewing',
  'completed',
  'failed',
  'cancelled',
  'unsupported'
] as const

export const MISSION_ORIGINS: readonly MissionOrigin[] = [
  'dashboard',
  'loop',
  'agent_hub',
  'workspace',
  'system'
] as const

export const MISSION_PERMISSION_MODES: readonly MissionPermissionMode[] = [
  'read_only',
  'ask_before_write',
  'allow_safe_writes',
  'allow_commits',
  'manual_only'
] as const

export function isMissionStatus(value: unknown): value is MissionStatus {
  return typeof value === 'string' && (MISSION_STATUSES as readonly string[]).includes(value)
}

export function isMissionOrigin(value: unknown): value is MissionOrigin {
  return typeof value === 'string' && (MISSION_ORIGINS as readonly string[]).includes(value)
}

export function isMissionPermissionMode(value: unknown): value is MissionPermissionMode {
  return typeof value === 'string' && (MISSION_PERMISSION_MODES as readonly string[]).includes(value)
}
