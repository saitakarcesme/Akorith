import { sendMetaPrompt } from '../providers/registry'
import { acquireResearchSources } from './acquire'
import { appendResearchFindings, setResearchPlanSectionStatus } from './findings'
import { planResearchJob } from './planner'
import { buildResearchCyclePrompt, parseResearchCycle } from './prompts/cycle'
import {
  finishResearchCycle,
  getResearchCycle,
  getResearchJob,
  linkResearchClaimSource,
  listResearchClaims,
  listResearchSources,
  logResearchEvent,
  recordResearchClaim,
  researchClaimCoverage,
  researchCancellationRequested,
  saveResearchCheckpoint,
  startResearchCycle,
  updateResearchJob
} from './store'
import { synthesizeResearchJob } from './synthesize'
import {
  RESEARCH_DEPTH_PROFILES,
  type ResearchCycleResult,
  type ResearchJob,
  type ResearchPlan,
  type ResearchPlanSection,
  type ResearchWorkspaceState
} from './types'
import {
  RESEARCH_FINDINGS_FILE,
  readResearchMarkdown,
  readResearchPlan,
  readResearchState,
  writeResearchState
} from './workspace'
import { recordResearchModelUsage } from './usage'

const MIN_SOURCE_GATE = { quick: 3, standard: 8, deep: 20, continuous: 3 } as const

export async function runResearchCycle(jobId: string, signal?: AbortSignal): Promise<ResearchCycleResult> {
  let job = getResearchJob(jobId)
  if (!job) throw new Error('Research job not found.')
  if (job.status === 'completed' || job.status === 'archived' || job.status === 'paused') {
    return { ok: false, job, completed: job.status === 'completed', error: `Research is ${job.status}.` }
  }
  if (researchCancellationRequested(job.id)) {
    updateResearchJob(job.id, { status: 'paused', nextRunAt: undefined })
    job = getResearchJob(job.id)!
    return { ok: false, job, completed: false, error: 'Research was cancelled.' }
  }

  let plan = job.plan ?? readResearchPlan(job.workspaceDir)
  if (!plan) {
    plan = await planResearchJob(job.id, signal)
    job = getResearchJob(job.id)!
  }

  const section = chooseResearchSection(plan, job.cycleCount)
  if (!section) {
    await synthesizeResearchJob(job.id, { final: job.depth !== 'continuous', signal })
    job = getResearchJob(job.id)!
    return { ok: true, job, completed: job.status === 'completed' }
  }

  plan = setResearchPlanSectionStatus(job.workspaceDir, plan, section.id, 'active')
  updateResearchJob(job.id, { plan, status: 'researching', phase: 'research', error: undefined })
  const objective = `${section.title}: ${section.objective}`
  const cycle = startResearchCycle({ jobId: job.id, phase: 'research', objective })
  logResearchEvent({
    jobId: job.id,
    cycleId: cycle.id,
    kind: 'cycle_started',
    title: `Research cycle ${cycle.cycleIndex} · ${section.title}`,
    detail: section.objective
  })

  try {
    const sources = await acquireResearchSources({ job, section, cycleId: cycle.id, signal })
    const priorFindings = readResearchMarkdown(job.workspaceDir, RESEARCH_FINDINGS_FILE)
    const response = await sendMetaPrompt(
      job.providerId,
      job.model,
      buildResearchCyclePrompt({
        request: job.prompt,
        section,
        cycleIndex: cycle.cycleIndex,
        sources,
        priorFindings
      }),
      signal,
      { workingDirectory: job.workspaceDir }
    )
    recordResearchModelUsage({
      job,
      kind: 'research-cycle',
      turnId: cycle.id,
      model: response.model,
      usage: response.usage
    })
    const parsed = parseResearchCycle(response.text, sources.length)
    for (const candidate of parsed.claims) {
      const claim = recordResearchClaim({
        jobId: job.id,
        cycleId: cycle.id,
        sectionId: section.id,
        text: candidate.text,
        confidenceScore: candidate.confidence
      })
      for (const sourceNumber of candidate.sourceNumbers) {
        const source = sources[sourceNumber - 1]
        if (!source) continue
        linkResearchClaimSource({
          claimId: claim.id,
          sourceId: source.id,
          relation: candidate.relation
        })
      }
      logResearchEvent({
        jobId: job.id,
        cycleId: cycle.id,
        kind: 'finding_added',
        title: candidate.text.slice(0, 180),
        detail: `${candidate.sourceNumbers.length} citation${candidate.sourceNumbers.length === 1 ? '' : 's'} · ${Math.round(candidate.confidence * 100)}% confidence`
      })
    }
    appendResearchFindings({
      workspaceDir: job.workspaceDir,
      section,
      cycleIndex: cycle.cycleIndex,
      result: parsed,
      sources
    })
    plan = setResearchPlanSectionStatus(
      job.workspaceDir,
      plan,
      section.id,
      parsed.sectionComplete ? 'complete' : 'pending'
    )
    const latestSources = listResearchSources(job.id)
    const latestClaims = listResearchClaims(job.id)
    const state = nextWorkspaceState({
      current: readResearchState(job.workspaceDir),
      jobId: job.id,
      cycleCount: cycle.cycleIndex,
      plan,
      gaps: parsed.gaps,
      sourceCount: latestSources.length,
      findingCount: latestClaims.length
    })
    writeResearchState(job.workspaceDir, state)
    saveResearchCheckpoint({
      jobId: job.id,
      cycleId: cycle.id,
      idempotencyKey: `cycle-${cycle.cycleIndex}-complete`,
      phase: 'research',
      state
    })
    const finished = finishResearchCycle(cycle.id, {
      status: 'completed',
      result: parsed.summary,
      sourceCount: sources.length,
      findingCount: parsed.claims.length,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens
    })
    const coverage = researchClaimCoverage(job.id)
    const nextCycleCount = Math.max(job.cycleCount + 1, cycle.cycleIndex)
    const ready = shouldSynthesize({
      job: { ...job, cycleCount: nextCycleCount, sourceCount: latestSources.length },
      plan,
      coverage
    })
    updateResearchJob(job.id, {
      plan,
      cycleCount: nextCycleCount,
      sourceCount: latestSources.length,
      findingCount: latestClaims.length,
      status: ready ? 'verifying' : 'researching',
      phase: ready ? 'verify' : 'research',
      nextRunAt: ready ? Date.now() : Date.now() + RESEARCH_DEPTH_PROFILES[job.depth].cycleIntervalMs,
      error: undefined
    })
    logResearchEvent({
      jobId: job.id,
      cycleId: cycle.id,
      kind: 'cycle_completed',
      title: `Cycle ${cycle.cycleIndex} complete · ${sources.length} new sources`,
      detail: `${latestClaims.length} claims · ${Math.round(coverage.coverage * 100)}% verified coverage`
    })
    if (ready) {
      await synthesizeResearchJob(job.id, { final: job.depth !== 'continuous', signal })
    }
    job = getResearchJob(job.id)!
    return { ok: true, job, cycle: finished ?? undefined, completed: job.status === 'completed' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failed = finishResearchCycle(cycle.id, {
      status: signal?.aborted ? 'cancelled' : 'failed',
      error: message
    })
    if (!signal?.aborted) {
      updateResearchJob(job.id, {
        status: 'error',
        error: message,
        nextRunAt: Date.now() + Math.max(60_000, RESEARCH_DEPTH_PROFILES[job.depth].cycleIntervalMs)
      })
      logResearchEvent({ jobId: job.id, cycleId: cycle.id, kind: 'error', title: 'Research cycle failed', detail: message })
    }
    job = getResearchJob(job.id)!
    return { ok: false, job, cycle: failed ?? getResearchCycle(cycle.id) ?? undefined, completed: false, error: message }
  }
}

function chooseResearchSection(plan: ResearchPlan, cycleCount: number): ResearchPlanSection | null {
  const pending = plan.sections.filter((section) => section.status !== 'complete')
  if (pending.length === 0) return null
  return pending[cycleCount % pending.length]
}

function shouldSynthesize(input: {
  job: ResearchJob
  plan: ResearchPlan
  coverage: ReturnType<typeof researchClaimCoverage>
}): boolean {
  const job = input.job
  const allSectionsComplete = input.plan.sections.every((section) => section.status === 'complete')
  const completedRatio = input.plan.sections.filter((section) => section.status === 'complete').length /
    Math.max(1, input.plan.sections.length)
  const sourceGate = job.sourceCount >= MIN_SOURCE_GATE[job.depth]
  const coverageGate = input.coverage.total > 0 && input.coverage.coverage >= 0.6
  const targetReached = job.sourceCount >= job.sourceTarget && completedRatio >= 0.75 && coverageGate
  const exhausted = job.maxCycles > 0 && job.cycleCount >= job.maxCycles
  if (job.depth === 'continuous') return allSectionsComplete && sourceGate && coverageGate
  return exhausted || (allSectionsComplete && sourceGate && coverageGate) || targetReached
}

function nextWorkspaceState(input: {
  current: ResearchWorkspaceState | null
  jobId: string
  cycleCount: number
  plan: ResearchPlan
  gaps: string[]
  sourceCount: number
  findingCount: number
}): ResearchWorkspaceState {
  return {
    version: 1,
    jobId: input.jobId,
    cycleCount: input.cycleCount,
    currentPhase: 'research',
    completedSections: input.plan.sections.filter((section) => section.status === 'complete').map((section) => section.id),
    openQuestions: input.gaps,
    sourceCount: input.sourceCount,
    findingCount: input.findingCount,
    readyToSynthesize: input.plan.sections.every((section) => section.status === 'complete'),
    updatedAt: Date.now()
  }
}
