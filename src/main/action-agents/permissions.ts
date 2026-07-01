import type { AgentPermissionMode } from './types'

// Phase 52: agent permission policy. Deterministic — the mode decides what the
// executor may do; the model never escalates its own permissions. Default is the
// safest (preview).

export interface PermissionCapabilities {
  canWriteFiles: boolean
  canRunCommands: boolean
  /** Every write/command is surfaced for approval before it happens. */
  requiresStepApproval: boolean
}

export function capabilitiesFor(mode: AgentPermissionMode, allowCommands: boolean): PermissionCapabilities {
  switch (mode) {
    case 'preview':
      return { canWriteFiles: false, canRunCommands: false, requiresStepApproval: false }
    case 'ask_write':
      return { canWriteFiles: true, canRunCommands: false, requiresStepApproval: true }
    case 'safe_writes':
      return { canWriteFiles: true, canRunCommands: false, requiresStepApproval: false }
    case 'safe_commands':
      return { canWriteFiles: true, canRunCommands: allowCommands, requiresStepApproval: false }
    case 'manual_each':
      return { canWriteFiles: true, canRunCommands: allowCommands, requiresStepApproval: true }
    default:
      return { canWriteFiles: false, canRunCommands: false, requiresStepApproval: false }
  }
}

export function describePermission(mode: AgentPermissionMode): string {
  switch (mode) {
    case 'preview':
      return 'Preview only — plans and previews changes, writes nothing and runs nothing.'
    case 'ask_write':
      return 'Ask before write — proposes file changes; you approve before anything is written.'
    case 'safe_writes':
      return 'Allow safe writes — writes files inside the chosen folder only; no commands.'
    case 'safe_commands':
      return 'Allow safe commands — safe writes plus allowlisted validation commands.'
    case 'manual_each':
      return 'Manual approval every step — you approve each write and command.'
    default:
      return 'Preview only.'
  }
}

export const PERMISSION_MODES: AgentPermissionMode[] = ['preview', 'ask_write', 'safe_writes', 'safe_commands', 'manual_each']

/** The safe default for a newly created agent. */
export const DEFAULT_PERMISSION_MODE: AgentPermissionMode = 'preview'
