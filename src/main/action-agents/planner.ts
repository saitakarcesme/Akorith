import { sendStructured } from '../local-runtime'
import { inspectProject, renderProjectContext } from '../project-loop/context'
import { templateById } from './templates'
import type { ActionAgent, AgentPlan, AgentPlanStep, AgentRiskLevel } from './types'

// Phase 52: the agent planner. Asks the local model for a step plan + risk level
// the user reviews BEFORE anything runs. The plan never grants permission — it is
// a preview only.

const VALID_STEP_KINDS = ['read', 'write', 'command', 'report', 'ask'] as const

function validatePlan(v: unknown): AgentPlan | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const summary = typeof o.summary === 'string' ? o.summary.trim() : ''
  if (summary.length < 3) return null
  const risk = (['low', 'medium', 'high'] as AgentRiskLevel[]).includes(o.risk_level as AgentRiskLevel)
    ? (o.risk_level as AgentRiskLevel)
    : 'low'
  const rawSteps = Array.isArray(o.steps) ? o.steps : []
  const steps: AgentPlanStep[] = []
  for (const s of rawSteps.slice(0, 12)) {
    if (!s || typeof s !== 'object') continue
    const so = s as Record<string, unknown>
    const kind = (VALID_STEP_KINDS as readonly string[]).includes(so.kind as string) ? (so.kind as AgentPlanStep['kind']) : 'report'
    const title = typeof so.title === 'string' ? so.title.slice(0, 200) : ''
    if (!title) continue
    steps.push({
      kind,
      title,
      reason: typeof so.reason === 'string' ? so.reason.slice(0, 300) : '',
      requiresPermission: so.requires_permission === true || kind === 'write' || kind === 'command'
    })
  }
  return { type: 'agent_plan', summary: summary.slice(0, 400), riskLevel: risk, steps }
}

export interface PlanResult {
  ok: boolean
  plan?: AgentPlan
  raw?: string
  error?: string
}

export async function planAgent(agent: ActionAgent, input?: string): Promise<PlanResult> {
  const tpl = templateById(agent.templateId)
  const goal = tpl?.goal ?? agent.description
  const context = agent.allowedRoot ? renderProjectContext(inspectProject(agent.allowedRoot)) : 'No folder selected.'

  const prompt = `You are ${agent.name}, an Akorith Agent that performs a bounded local task. Produce a short plan the user will review before anything runs. You do NOT have permission yet.

Task: ${goal}
${input ? `User input: ${input}\n` : ''}Working folder: ${agent.allowedRoot ?? '(none)'}
Folder context:
${context}

Return:
{"type":"agent_plan","summary":"...","risk_level":"low|medium|high","steps":[{"kind":"read|write|command|report|ask","title":"...","reason":"...","requires_permission":true}]}`

  const res = await sendStructured<AgentPlan>(prompt, {
    model: agent.localModel,
    validate: validatePlan,
    schemaHint: 'Return an agent_plan object with steps.'
  })
  if (res.ok && res.value) return { ok: true, plan: res.value, raw: res.raw }
  return { ok: false, raw: res.raw, error: res.error ?? 'planning failed' }
}
