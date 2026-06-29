import { randomUUID } from 'crypto'
import { missionPolicyForPermissionMode, READ_ONLY_MISSION_POLICY } from './policies'
import { missionStore, MissionStore } from './store'
import {
  createMissionFromTemplateDefinition,
  getMissionTemplate,
  listMissionTemplates
} from './templates'
import type {
  Mission,
  MissionCreateInput,
  MissionEvent,
  MissionPreviewPlan,
  MissionStatus,
  MissionStep,
  MissionTemplate
} from './types'

function cleanTitle(value?: string): string {
  const title = value?.trim().replace(/\s+/g, ' ').slice(0, 120)
  return title || 'Untitled preview mission'
}

function cleanDescription(value?: string): string | undefined {
  const description = value?.trim().slice(0, 2000)
  return description || undefined
}

function createDraftSteps(missionId: string, now: number): MissionStep[] {
  const inspectId = randomUUID()
  const planId = randomUUID()
  const choiceId = randomUUID()
  const executeId = randomUUID()
  const reviewId = randomUUID()
  return [
    {
      id: inspectId,
      missionId,
      index: 0,
      title: 'Inspect available context',
      kind: 'inspect',
      status: 'pending',
      agentRole: 'observer',
      preferredAgentId: 'memory',
      riskLevel: 'low',
      permissionMode: 'read_only',
      createdAt: now,
      updatedAt: now,
      safePreview: 'Would inspect safe local metadata in a later phase. Phase 32 does not read extra files or call agents.'
    },
    {
      id: planId,
      missionId,
      index: 1,
      title: 'Draft mission plan',
      kind: 'plan',
      status: 'pending',
      agentRole: 'planner',
      preferredAgentId: 'claude',
      dependsOn: [inspectId],
      riskLevel: 'low',
      permissionMode: 'read_only',
      createdAt: now,
      updatedAt: now,
      safePreview: 'Would ask a planner in the future. In Phase 32 this remains a static preview step.'
    },
    {
      id: choiceId,
      missionId,
      index: 2,
      title: 'Await user choice',
      kind: 'user_choice',
      status: 'ready',
      agentRole: 'observer',
      dependsOn: [planId],
      riskLevel: 'low',
      permissionMode: 'read_only',
      createdAt: now,
      updatedAt: now,
      safePreview: 'Future execution would require explicit user choice before any write-capable step.'
    },
    {
      id: executeId,
      missionId,
      index: 3,
      title: 'Future execution placeholder',
      kind: 'execute',
      status: 'unsupported',
      agentRole: 'executor',
      preferredAgentId: 'codex',
      dependsOn: [choiceId],
      riskLevel: 'medium',
      permissionMode: 'ask_before_write',
      createdAt: now,
      updatedAt: now,
      safePreview: 'Unsupported in Phase 32. No providers, terminals, files, tests, commits, or pushes are controlled.'
    },
    {
      id: reviewId,
      missionId,
      index: 4,
      title: 'Future review and report placeholder',
      kind: 'report',
      status: 'unsupported',
      agentRole: 'reviewer',
      dependsOn: [executeId],
      riskLevel: 'medium',
      permissionMode: 'read_only',
      createdAt: now,
      updatedAt: now,
      safePreview: 'Would summarize execution results after a real Mission Engine exists.'
    }
  ]
}

function createDraft(input: MissionCreateInput = {}): Mission {
  const now = Date.now()
  const missionId = randomUUID()
  return {
    id: missionId,
    title: cleanTitle(input.title),
    description: cleanDescription(input.description),
    status: 'draft',
    projectPath: input.projectPath,
    createdAt: now,
    updatedAt: now,
    origin: input.origin ?? 'system',
    permissionMode: 'read_only',
    riskLevel: 'medium',
    steps: createDraftSteps(missionId, now),
    metadata: {
      ...(input.metadata ?? {}),
      previewOnly: true,
      phase: 32,
      policyId: READ_ONLY_MISSION_POLICY.id
    },
    notes: [
      'Mission Engine is an in-memory planning skeleton in Phase 32.',
      'No execution or control path is attached to these mission steps.'
    ]
  }
}

export class MissionEngine {
  constructor(private readonly store: MissionStore) {}

  listTemplates(): MissionTemplate[] {
    return listMissionTemplates()
  }

  createDraftMission(input: MissionCreateInput = {}): Mission {
    return this.store.createMission(createDraft(input))
  }

  listMissions(): Mission[] {
    return this.store.listMissions()
  }

  getMission(id: string): Mission | null {
    return this.store.getMission(id)
  }

  listMissionEvents(id: string): MissionEvent[] {
    return this.store.listEvents(id)
  }

  updateMissionStatus(id: string, status: MissionStatus): Mission | null {
    return this.store.updateMissionStatus(id, status)
  }

  createMissionFromTemplate(templateId: string, input: MissionCreateInput = {}): Mission | null {
    const template = getMissionTemplate(templateId)
    if (!template) return null
    return this.store.createMission(createMissionFromTemplateDefinition(template, input))
  }

  createSafePreviewPlan(input: MissionCreateInput = {}): MissionPreviewPlan {
    const mission = createDraft(input)
    const policy = missionPolicyForPermissionMode(mission.permissionMode)
    return {
      title: mission.title,
      description: mission.description,
      origin: mission.origin,
      permissionMode: mission.permissionMode,
      riskLevel: mission.riskLevel,
      policy,
      steps: mission.steps,
      warnings: [
        'Preview only: this plan is not stored unless a draft mission is created.',
        'No providers, PTYs, file writes, tests, commits, pushes, or background loops are invoked.'
      ],
      notes: mission.notes ?? []
    }
  }
}

export const missionEngine = new MissionEngine(missionStore)
