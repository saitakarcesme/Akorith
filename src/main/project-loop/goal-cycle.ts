import type { ProjectLoop, ProjectLoopRun } from './types'

export type GoalTaskKind = 'project' | 'research' | 'document' | 'automation' | 'analysis' | 'creative' | 'general'

export interface GoalUnderstanding {
  summary: string
  taskKind: GoalTaskKind
  deliverables: string[]
  acceptanceCriteria: string[]
  constraints: string[]
  firstObjective: string
}

export interface GoalProgressReview {
  goalMet: boolean
  progressSummary: string
  completedEvidence: string[]
  remainingWork: string[]
  nextObjective?: string
  confidence: number
  blocked: boolean
}

function boundedString(value: unknown, max = 500): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, max) : undefined
}

function boundedList(value: unknown, maxItems = 8, maxChars = 320): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => boundedString(item, maxChars))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems)
}

function jsonObject(raw: string): Record<string, unknown> | null {
  const candidates = [raw.trim()]
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) candidates.push(fenced.trim())
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // Try the next bounded candidate. Raw model prose is never executed.
    }
  }
  return null
}

function taskKind(value: unknown): GoalTaskKind {
  return value === 'project' || value === 'research' || value === 'document' || value === 'automation' || value === 'analysis' || value === 'creative'
    ? value
    : 'general'
}

export function fallbackGoalUnderstanding(goal: string): GoalUnderstanding {
  const summary = boundedString(goal, 500) ?? 'Complete the requested outcome.'
  return {
    summary,
    taskKind: 'general',
    deliverables: [summary],
    acceptanceCriteria: ['The requested outcome exists in the selected workspace and can be inspected.', 'Relevant checks or artifact validation complete without a known blocking error.'],
    constraints: ['Stay inside the selected workspace.', 'Do not expose secrets or push changes automatically.'],
    firstObjective: summary
  }
}

export function parseGoalUnderstanding(raw: string, goal: string): GoalUnderstanding {
  const fallback = fallbackGoalUnderstanding(goal)
  const value = jsonObject(raw)
  if (!value) return fallback
  return {
    summary: boundedString(value.summary, 500) ?? fallback.summary,
    taskKind: taskKind(value.task_kind),
    deliverables: boundedList(value.deliverables).length ? boundedList(value.deliverables) : fallback.deliverables,
    acceptanceCriteria: boundedList(value.acceptance_criteria).length
      ? boundedList(value.acceptance_criteria)
      : fallback.acceptanceCriteria,
    constraints: boundedList(value.constraints).length ? boundedList(value.constraints) : fallback.constraints,
    firstObjective: boundedString(value.first_objective, 600) ?? fallback.firstObjective
  }
}

export function fallbackGoalReview(run: ProjectLoopRun | null, attempt: number): GoalProgressReview {
  const evidence = run
    ? [
        run.summary,
        run.filesChanged > 0 ? `${run.filesChanged} file(s) changed` : undefined,
        run.validationResult
      ].filter((item): item is string => Boolean(item))
    : []
  const completeSignal = Boolean(
    run &&
    run.status === 'success' &&
    run.commitsCreated > 0 &&
    !run.nextStep &&
    attempt > 1
  )
  return {
    goalMet: completeSignal,
    progressSummary: run?.summary ?? 'The last cycle produced no reviewable result.',
    completedEvidence: evidence,
    remainingWork: completeSignal ? [] : [run?.nextStep ?? 'Reinspect the goal and choose the next smallest verifiable action.'],
    nextObjective: completeSignal ? undefined : run?.nextStep ?? 'Reinspect the workspace, identify the largest remaining gap, and close it with verifiable evidence.',
    confidence: completeSignal ? 0.55 : 0.35,
    blocked: run?.status === 'failed'
  }
}

export function parseGoalProgressReview(raw: string, run: ProjectLoopRun | null, attempt: number): GoalProgressReview {
  const fallback = fallbackGoalReview(run, attempt)
  const value = jsonObject(raw)
  if (!value) return fallback
  const nextObjective = boundedString(value.next_objective, 700)
  const remainingWork = boundedList(value.remaining_work)
  const completedEvidence = boundedList(value.completed_evidence)
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? Math.min(1, Math.max(0, value.confidence))
    : fallback.confidence
  const goalMet = value.goal_met === true && remainingWork.length === 0 && completedEvidence.length > 0
  return {
    goalMet,
    progressSummary: boundedString(value.progress_summary, 700) ?? fallback.progressSummary,
    completedEvidence: completedEvidence.length ? completedEvidence : fallback.completedEvidence,
    remainingWork: goalMet ? [] : remainingWork.length ? remainingWork : fallback.remainingWork,
    nextObjective: goalMet ? undefined : nextObjective ?? fallback.nextObjective,
    confidence,
    blocked: value.blocked === true
  }
}

export function buildGoalUnderstandingPrompt(loop: ProjectLoop, workspaceContext: string): string {
  return `You are the Goal interpreter for a durable local workflow. The request may be software work, research, document/PDF/DOCX/Markdown production, analysis, automation, creative work, or another artifact-driven task.

Original goal:
${loop.idea ?? loop.title}

Selected workspace:
${loop.localPath}

Current workspace context:
${workspaceContext}

Translate the goal into a concrete contract. Infer sensible deliverables and acceptance criteria without inventing requirements that change the user's intent. Keep every action inside the selected workspace. Prefer inspectable artifacts and objective evidence. Return ONLY JSON:
{
  "summary": "one precise sentence",
  "task_kind": "project|research|document|automation|analysis|creative|general",
  "deliverables": ["..."],
  "acceptance_criteria": ["observable proof that the goal is done"],
  "constraints": ["important boundary"],
  "first_objective": "the first small, concrete action"
}`
}

export function buildGoalReviewPrompt(input: {
  loop: ProjectLoop
  understanding: GoalUnderstanding
  run: ProjectLoopRun | null
  attempt: number
  workspaceContext: string
}): string {
  const { loop, understanding, run, attempt, workspaceContext } = input
  return `You are the evidence-based review gate in a durable Goal loop.

Original goal:
${loop.idea ?? loop.title}

Goal contract:
${JSON.stringify(understanding, null, 2)}

Cycle: ${attempt}
Last execution result:
${JSON.stringify(run ?? { status: 'missing' }, null, 2)}

Current workspace context after execution:
${workspaceContext}

Decide whether the ENTIRE original goal is complete, not merely whether one step ran. Mark goal_met true only when concrete evidence satisfies every acceptance criterion. A plan, intention, partial file, or unverified claim is not completion. If work remains, choose exactly one next objective that closes the most important gap. Return ONLY JSON:
{
  "goal_met": false,
  "progress_summary": "what materially changed in this cycle",
  "completed_evidence": ["file, check, artifact, or other observable evidence"],
  "remaining_work": ["specific unmet acceptance criterion"],
  "next_objective": "one small next action, or null when complete",
  "confidence": 0.0,
  "blocked": false
}`
}

export function renderGoalContract(understanding: GoalUnderstanding): string {
  const deliverables = understanding.deliverables.map((item) => `• ${item}`).join('\n')
  const acceptance = understanding.acceptanceCriteria.map((item) => `• ${item}`).join('\n')
  return `${understanding.summary}\n\nDeliverables\n${deliverables}\n\nCompletion evidence\n${acceptance}`
}
