import { randomUUID } from 'crypto'
import { maxRiskLevel } from './policies'
import type {
  Mission,
  MissionCreateInput,
  MissionPermissionMode,
  MissionRiskLevel,
  MissionStep,
  MissionStepKind,
  MissionStepStatus,
  MissionTemplate
} from './types'

const EXECUTION_KINDS = new Set<MissionStepKind>(['execute', 'test', 'commit', 'handoff'])

function placeholderStatus(kind: MissionStepKind, status?: MissionStepStatus): MissionStepStatus {
  if (status) return status
  if (kind === 'user_choice') return 'ready'
  return EXECUTION_KINDS.has(kind) ? 'unsupported' : 'pending'
}

function permissionForKind(kind: MissionStepKind): MissionPermissionMode {
  if (kind === 'execute' || kind === 'test') return 'ask_before_write'
  if (kind === 'commit') return 'allow_commits'
  return 'read_only'
}

export const MISSION_TEMPLATES: readonly MissionTemplate[] = [
  {
    id: 'repository-health-review',
    title: 'Repository health review',
    description: 'Preview a mission that inspects architecture, risks, tests, docs, and release readiness without touching files.',
    riskLevel: 'low',
    permissionMode: 'read_only',
    steps: [
      {
        title: 'Inspect repository structure',
        kind: 'inspect',
        agentRole: 'observer',
        preferredAgentId: 'memory',
        safePreview: 'Would read bounded repository metadata and existing local records only.'
      },
      {
        title: 'Summarize health signals',
        kind: 'review',
        agentRole: 'reviewer',
        preferredAgentId: 'codex',
        dependsOn: [0],
        safePreview: 'Would produce a prioritized health review after a future read-only context pass.'
      },
      {
        title: 'Report findings',
        kind: 'report',
        agentRole: 'observer',
        dependsOn: [1],
        safePreview: 'Would show a local report in Akorith. Phase 32 only previews this step.'
      }
    ],
    notes: ['Preview-only template. No provider call, file read expansion, test run, or commit is performed in Phase 32.']
  },
  {
    id: 'feature-implementation-loop',
    title: 'Feature implementation loop',
    description: 'Preview the future inspect, plan, choose, execute, test, review, and commit pipeline for a feature.',
    riskLevel: 'medium',
    permissionMode: 'read_only',
    steps: [
      {
        title: 'Inspect repository',
        kind: 'inspect',
        agentRole: 'observer',
        preferredAgentId: 'memory',
        safePreview: 'Would gather safe project context and runtime status.'
      },
      {
        title: 'Propose implementation plan',
        kind: 'plan',
        agentRole: 'planner',
        preferredAgentId: 'claude',
        dependsOn: [0],
        safePreview: 'Would ask a planner agent for a bounded plan in a later phase.'
      },
      {
        title: 'Await user choice',
        kind: 'user_choice',
        agentRole: 'observer',
        dependsOn: [1],
        safePreview: 'Would require explicit user selection before any future write-capable step.'
      },
      {
        title: 'Execute selected change',
        kind: 'execute',
        status: 'unsupported',
        agentRole: 'executor',
        preferredAgentId: 'codex',
        dependsOn: [2],
        riskLevel: 'medium',
        safePreview: 'Execution is intentionally unsupported in Phase 32.'
      },
      {
        title: 'Run tests',
        kind: 'test',
        status: 'unsupported',
        agentRole: 'tester',
        preferredAgentId: 'ollama',
        dependsOn: [3],
        riskLevel: 'medium',
        safePreview: 'Test execution remains on the existing Test Lab and loop paths, not Mission Engine.'
      },
      {
        title: 'Review diff',
        kind: 'review',
        status: 'unsupported',
        agentRole: 'reviewer',
        preferredAgentId: 'claude',
        dependsOn: [4],
        riskLevel: 'medium',
        safePreview: 'Future reviewer handoff is represented only as metadata here.'
      },
      {
        title: 'Commit if approved',
        kind: 'commit',
        status: 'unsupported',
        agentRole: 'committer',
        dependsOn: [5],
        riskLevel: 'high',
        safePreview: 'Commit policy is preview-only; no git command is available through this skeleton.'
      }
    ],
    notes: ['This template describes the future Mission Engine pipeline. It does not replace the macro loop.']
  },
  {
    id: 'test-coverage-improvement',
    title: 'Test coverage improvement',
    description: 'Preview a mission that finds test gaps, proposes generated tests, validates them, and reviews risk.',
    riskLevel: 'medium',
    permissionMode: 'read_only',
    steps: [
      {
        title: 'Inspect existing test surface',
        kind: 'inspect',
        agentRole: 'tester',
        preferredAgentId: 'ollama',
        safePreview: 'Would read existing test metadata and Test Lab history in a later phase.'
      },
      {
        title: 'Plan coverage targets',
        kind: 'plan',
        agentRole: 'planner',
        dependsOn: [0],
        safePreview: 'Would propose safe test targets before generation.'
      },
      {
        title: 'Generate candidate tests',
        kind: 'execute',
        status: 'unsupported',
        agentRole: 'tester',
        preferredAgentId: 'ollama',
        dependsOn: [1],
        riskLevel: 'medium',
        safePreview: 'Future generated tests would go through Test Lab safeguards, not this Phase 32 preview.'
      },
      {
        title: 'Run sandbox validation',
        kind: 'test',
        status: 'unsupported',
        agentRole: 'tester',
        dependsOn: [2],
        riskLevel: 'medium',
        safePreview: 'No test process is started by Mission Engine in Phase 32.'
      },
      {
        title: 'Report coverage recommendation',
        kind: 'report',
        dependsOn: [3],
        safePreview: 'Would summarize what passed, failed, and needs user approval.'
      }
    ]
  },
  {
    id: 'release-prep-review',
    title: 'Release prep review',
    description: 'Preview a release gate that checks build, tests, docs, packaging notes, and push readiness.',
    riskLevel: 'medium',
    permissionMode: 'read_only',
    steps: [
      {
        title: 'Inspect release checklist',
        kind: 'inspect',
        agentRole: 'observer',
        safePreview: 'Would review local release docs and package metadata.'
      },
      {
        title: 'Plan validation matrix',
        kind: 'plan',
        agentRole: 'planner',
        dependsOn: [0],
        safePreview: 'Would prepare validation commands for user approval.'
      },
      {
        title: 'Run release validation',
        kind: 'test',
        status: 'unsupported',
        agentRole: 'tester',
        dependsOn: [1],
        riskLevel: 'medium',
        safePreview: 'Validation commands are not executed by this skeleton.'
      },
      {
        title: 'Review release risk',
        kind: 'review',
        status: 'unsupported',
        agentRole: 'reviewer',
        dependsOn: [2],
        safePreview: 'Would summarize release risk after validation exists.'
      },
      {
        title: 'Report ship/no-ship preview',
        kind: 'report',
        dependsOn: [3],
        safePreview: 'Would present the final recommendation locally.'
      }
    ]
  },
  {
    id: 'documentation-improvement',
    title: 'Documentation improvement',
    description: 'Preview a docs-focused mission from audit to proposed changes to review.',
    riskLevel: 'low',
    permissionMode: 'read_only',
    steps: [
      {
        title: 'Inspect docs and README',
        kind: 'inspect',
        agentRole: 'observer',
        safePreview: 'Would inspect bounded documentation context.'
      },
      {
        title: 'Plan documentation changes',
        kind: 'plan',
        agentRole: 'planner',
        preferredAgentId: 'claude',
        dependsOn: [0],
        safePreview: 'Would suggest missing sections and stale content.'
      },
      {
        title: 'Draft documentation patch',
        kind: 'execute',
        status: 'unsupported',
        agentRole: 'executor',
        dependsOn: [1],
        riskLevel: 'medium',
        safePreview: 'File writes are intentionally unavailable in Phase 32.'
      },
      {
        title: 'Review documentation diff',
        kind: 'review',
        status: 'unsupported',
        agentRole: 'reviewer',
        dependsOn: [2],
        safePreview: 'Would review proposed docs only after write support is deliberately added.'
      }
    ]
  },
  {
    id: 'local-model-benchmark-visualization',
    title: 'Local model benchmark visualization',
    description: 'Preview a local-first mission for comparing Ollama models and turning results into an overview.',
    riskLevel: 'low',
    permissionMode: 'read_only',
    steps: [
      {
        title: 'Inspect available local models',
        kind: 'inspect',
        agentRole: 'observer',
        preferredAgentId: 'ollama',
        safePreview: 'Would use existing local runtime detection only.'
      },
      {
        title: 'Plan benchmark dimensions',
        kind: 'plan',
        agentRole: 'planner',
        dependsOn: [0],
        safePreview: 'Would define timing, quality, and cost-free local metrics.'
      },
      {
        title: 'Run benchmark prompts',
        kind: 'execute',
        status: 'unsupported',
        agentRole: 'tester',
        preferredAgentId: 'ollama',
        dependsOn: [1],
        riskLevel: 'medium',
        safePreview: 'No prompts are sent to Ollama by Mission Engine in Phase 32.'
      },
      {
        title: 'Visualize benchmark report',
        kind: 'report',
        status: 'unsupported',
        dependsOn: [2],
        safePreview: 'Would display local benchmark results after a future execution layer exists.'
      }
    ]
  },
  {
    id: 'autonomous-project-creation-preview',
    title: 'Autonomous project creation preview',
    description: 'Preview how a future Mission Engine could coordinate project idea, scaffold, build, test, review, and commit.',
    riskLevel: 'high',
    permissionMode: 'read_only',
    steps: [
      {
        title: 'Generate project idea preview',
        kind: 'plan',
        agentRole: 'planner',
        preferredAgentId: 'claude',
        riskLevel: 'low',
        safePreview: 'Would produce a project concept without creating folders in Phase 32.'
      },
      {
        title: 'Await user project choice',
        kind: 'user_choice',
        agentRole: 'observer',
        dependsOn: [0],
        safePreview: 'Future project creation would require an explicit user choice.'
      },
      {
        title: 'Scaffold project workspace',
        kind: 'execute',
        status: 'unsupported',
        agentRole: 'executor',
        dependsOn: [1],
        riskLevel: 'high',
        safePreview: 'No directories or files are created by this skeleton.'
      },
      {
        title: 'Run autonomous build loop',
        kind: 'handoff',
        status: 'unsupported',
        agentRole: 'executor',
        dependsOn: [2],
        riskLevel: 'high',
        safePreview: 'AkorithLoop and macro/workspace loops remain separate execution paths.'
      },
      {
        title: 'Review and commit phases',
        kind: 'commit',
        status: 'unsupported',
        agentRole: 'committer',
        dependsOn: [3],
        riskLevel: 'high',
        safePreview: 'No commits or pushes are available through Phase 32 Mission Engine.'
      }
    ],
    notes: ['AkorithLoop stays separate; this template is only a future orchestration preview.']
  }
] as const

function cleanTitle(input: MissionCreateInput, fallback: string): string {
  const title = input.title?.trim().replace(/\s+/g, ' ').slice(0, 120)
  return title || fallback
}

function cloneMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  return { ...metadata }
}

export function listMissionTemplates(): MissionTemplate[] {
  return MISSION_TEMPLATES.map((template) => ({
    ...template,
    steps: template.steps.map((step) => ({
      ...step,
      dependsOn: step.dependsOn ? [...step.dependsOn] : undefined,
      metadata: cloneMetadata(step.metadata)
    })),
    notes: template.notes ? [...template.notes] : undefined,
    metadata: cloneMetadata(template.metadata)
  }))
}

export function getMissionTemplate(id: string): MissionTemplate | null {
  return listMissionTemplates().find((template) => template.id === id) ?? null
}

export function createMissionFromTemplateDefinition(template: MissionTemplate, input: MissionCreateInput = {}): Mission {
  const now = Date.now()
  const missionId = randomUUID()
  const stepIds = template.steps.map(() => randomUUID())
  const steps: MissionStep[] = template.steps.map((step, index) => {
    const kind = step.kind
    return {
      id: stepIds[index],
      missionId,
      index,
      title: step.title,
      kind,
      status: placeholderStatus(kind, step.status),
      agentRole: step.agentRole,
      preferredAgentId: step.preferredAgentId,
      dependsOn: step.dependsOn?.map((depIndex) => stepIds[depIndex]).filter(Boolean),
      riskLevel: step.riskLevel ?? (EXECUTION_KINDS.has(kind) ? 'medium' : 'low'),
      permissionMode: step.permissionMode ?? permissionForKind(kind),
      createdAt: now,
      updatedAt: now,
      summary: step.summary,
      safePreview: step.safePreview ?? 'Preview-only mission step. Phase 32 does not execute mission steps.',
      metadata: {
        ...(step.metadata ?? {}),
        previewOnly: true,
        nonExecuting: true
      }
    }
  })
  const riskLevel = maxRiskLevel([template.riskLevel, ...steps.map((step) => step.riskLevel as MissionRiskLevel)])

  return {
    id: missionId,
    title: cleanTitle(input, template.title),
    description: input.description?.trim().slice(0, 2000) || template.description,
    status: 'draft',
    projectPath: input.projectPath,
    createdAt: now,
    updatedAt: now,
    origin: input.origin ?? 'system',
    permissionMode: 'read_only',
    riskLevel,
    steps,
    metadata: {
      ...(template.metadata ?? {}),
      ...(input.metadata ?? {}),
      templateId: template.id,
      previewOnly: true,
      phase: 32,
      policyId: 'phase-32-read-only'
    },
    notes: [
      ...(template.notes ?? []),
      'Phase 32 mission templates are preview-only and do not execute.'
    ]
  }
}
