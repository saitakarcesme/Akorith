import type { MissionPermissionMode, MissionPolicy, MissionRiskLevel } from './types'

export const READ_ONLY_MISSION_POLICY: MissionPolicy = {
  id: 'phase-32-read-only',
  name: 'Phase 32 read-only preview',
  permissionMode: 'read_only',
  allowProviderCalls: false,
  allowPtyWrites: false,
  allowFileWrites: false,
  allowTests: false,
  allowCommits: false,
  allowPush: false,
  requireUserApprovalForRiskAbove: 'low'
}

export const MANUAL_ONLY_MISSION_POLICY: MissionPolicy = {
  id: 'phase-32-manual-only',
  name: 'Manual-only skeleton',
  permissionMode: 'manual_only',
  allowProviderCalls: false,
  allowPtyWrites: false,
  allowFileWrites: false,
  allowTests: false,
  allowCommits: false,
  allowPush: false,
  requireUserApprovalForRiskAbove: 'low'
}

export const MISSION_POLICIES: readonly MissionPolicy[] = [
  READ_ONLY_MISSION_POLICY,
  MANUAL_ONLY_MISSION_POLICY
] as const

const RISK_ORDER: Record<MissionRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  destructive: 3
}

export function maxRiskLevel(values: MissionRiskLevel[]): MissionRiskLevel {
  return values.reduce<MissionRiskLevel>(
    (max, value) => (RISK_ORDER[value] > RISK_ORDER[max] ? value : max),
    'low'
  )
}

export function missionPolicyForPermissionMode(mode: MissionPermissionMode): MissionPolicy {
  if (mode === 'manual_only') return MANUAL_ONLY_MISSION_POLICY
  return READ_ONLY_MISSION_POLICY
}
