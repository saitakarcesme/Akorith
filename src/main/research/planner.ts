import { sendMetaPrompt } from '../providers/registry'
import { buildResearchPlanningPrompt, parseResearchPlan } from './prompts/plan'
import { getResearchJob, logResearchEvent, updateResearchJob } from './store'
import { RESEARCH_DEPTH_PROFILES, type ResearchPlan } from './types'
import { readResearchState, writeResearchPlan, writeResearchState } from './workspace'

export async function planResearchJob(jobId: string, signal?: AbortSignal): Promise<ResearchPlan> {
  const job = getResearchJob(jobId)
  if (!job) throw new Error('Research job not found.')
  updateResearchJob(job.id, { status: 'planning', phase: 'plan', error: undefined })
  logResearchEvent({ jobId, kind: 'planning_started', title: 'Building the evidence plan' })
  const prompt = buildResearchPlanningPrompt({
    request: job.prompt,
    depth: RESEARCH_DEPTH_PROFILES[job.depth],
    outputFormat: job.outputFormat
  })
  let plan: ResearchPlan
  try {
    const response = await sendMetaPrompt(job.providerId, job.model, prompt, signal, {
      workingDirectory: job.workspaceDir
    })
    plan = parseResearchPlan(response.text)
  } catch (error) {
    plan = fallbackResearchPlan(job.title, job.prompt, job.outputFormat)
    logResearchEvent({
      jobId,
      kind: 'warning',
      title: 'Planner response was incomplete; Akorith created a safe fallback plan',
      detail: error instanceof Error ? error.message : String(error)
    })
  }
  writeResearchPlan(job.workspaceDir, plan)
  const state = readResearchState(job.workspaceDir)
  if (state) {
    writeResearchState(job.workspaceDir, {
      ...state,
      currentPhase: 'plan',
      openQuestions: plan.sections.map((section) => section.objective),
      updatedAt: Date.now()
    })
  }
  updateResearchJob(job.id, {
    title: plan.title,
    plan,
    status: 'researching',
    phase: 'research',
    nextRunAt: Date.now()
  })
  logResearchEvent({
    jobId,
    kind: 'plan_ready',
    title: `Plan ready · ${plan.sections.length} evidence sections`,
    detail: plan.deliverable
  })
  return plan
}

function fallbackResearchPlan(title: string, request: string, format: string): ResearchPlan {
  const topic = request.replace(/\s+/g, ' ').trim().slice(0, 280)
  return {
    title: title || 'Autonomous research',
    thesis: `Establish an evidence-based answer to: ${topic}`,
    deliverable: `A cited ${format.toUpperCase()} report that answers the request, distinguishes facts from commentary, and discloses inaccessible evidence.`,
    sections: [
      {
        id: 'scope-and-definitions',
        title: 'Scope and definitions',
        objective: 'Define the subject, boundaries, terminology, and measurable completion criteria.',
        queries: [topic, `${topic} official documentation primary sources`],
        status: 'pending'
      },
      {
        id: 'evidence-and-comparison',
        title: 'Evidence and comparison',
        objective: 'Collect primary evidence and independent comparisons relevant to the request.',
        queries: [`${topic} data benchmarks research`, `${topic} independent analysis`],
        status: 'pending'
      },
      {
        id: 'findings-and-limitations',
        title: 'Findings and limitations',
        objective: 'Synthesize supported conclusions, conflicts, gaps, and limitations.',
        queries: [`${topic} limitations criticism`, `${topic} recent developments`],
        status: 'pending'
      }
    ],
    sourceStrategy: ['Official and primary sources', 'Independent validation', 'Clearly labeled public community perspectives'],
    verificationCriteria: ['Every material claim links to at least one accessible source URL', 'Conflicting evidence is preserved', 'Missing or inaccessible evidence is disclosed']
  }
}
