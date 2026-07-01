// Phase 52: Agents — reusable local action shortcuts. An Agent performs a bounded
// task on the computer or inside a selected project, behind a permission policy.
// Unlike Companions (which never act) and Loop (which grows one repo over time),
// Agents are one-click shortcuts the user creates once and re-runs.

export type AgentPermissionMode =
  | 'preview' // plan + preview only, no writes/commands
  | 'ask_write' // ask before each write
  | 'safe_writes' // allow writes inside the root
  | 'safe_commands' // allow writes + allowlisted commands
  | 'manual_each' // approve every step

export type AgentRiskLevel = 'low' | 'medium' | 'high'

export interface ActionAgent {
  id: string
  name: string
  description: string
  icon: string
  category: string
  /** The template this agent was created from (or 'blank'). */
  templateId: string
  localModelProvider: string
  localModel?: string
  /** The single folder/project the agent may read/write within. */
  allowedRoot?: string
  permissionMode: AgentPermissionMode
  /** Whether the agent may run allowlisted validation commands. */
  allowCommands: boolean
  builtin: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  runCount: number
}

export type AgentRunStatus = 'planning' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'stopped'

export interface ActionAgentRun {
  id: string
  agentId: string
  status: AgentRunStatus
  startedAt: number
  endedAt?: number
  input?: string
  summary?: string
  riskLevel?: AgentRiskLevel
  filesChanged: number
  commandsRun: number
  error?: string
}

export type AgentEventKind =
  | 'plan_generated'
  | 'permission_requested'
  | 'file_read'
  | 'file_written'
  | 'command_run'
  | 'output_created'
  | 'completed'
  | 'failed'
  | 'stopped'

export interface ActionAgentEvent {
  id: string
  runId: string
  agentId: string
  kind: AgentEventKind
  message: string
  detail?: string
  createdAt: number
}

export type AgentArtifactKind = 'report' | 'file' | 'checklist' | 'summary' | 'plan'

export interface ActionAgentArtifact {
  id: string
  runId: string
  agentId: string
  kind: AgentArtifactKind
  title: string
  content: string
  createdAt: number
}

// ---- structured model output shapes ----

export interface AgentPlanStep {
  kind: 'read' | 'write' | 'command' | 'report' | 'ask'
  title: string
  reason: string
  requiresPermission: boolean
}

export interface AgentPlan {
  type: 'agent_plan'
  summary: string
  riskLevel: AgentRiskLevel
  steps: AgentPlanStep[]
}

export interface AgentActionFile {
  operation: 'create' | 'modify' | 'delete'
  path: string
  content?: string
}

export interface AgentActionCommand {
  cmd: string
  reason: string
}

export interface AgentActionArtifact {
  title: string
  kind: AgentArtifactKind
  content: string
}

export interface AgentAction {
  type: 'agent_action'
  summary: string
  files: AgentActionFile[]
  commands: AgentActionCommand[]
  artifacts: AgentActionArtifact[]
}
