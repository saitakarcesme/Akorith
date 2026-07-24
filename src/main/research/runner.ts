import { sendMetaPrompt } from '../providers/registry'
import { acquireResearchSources } from './acquire'
import { appendResearchFindings, setResearchPlanSectionStatus } from './findings'
import { planResearchJob } from './planner'
import {
  chooseResearchSection,
  completedResearchCycleCountAfterSuccess,
  evaluateResearchCompletion,
  nextResearchCycleAt,
  prepareResearchSectionForCycle
} from './policy'
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
  startResearchActiveClock,
  startResearchCycle,
  updateResearchJob
} from './store'
import { synthesizeResearchJob } from './synthesize'
import {
  RESEARCH_DEPTH_PROFILES,
  type ResearchCycleResult,
  type ResearchPlan,
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
  startResearchActiveClock(job.id)
  job = getResearchJob(job.id)!

  let plan = job.plan ?? readResearchPlan(job.workspaceDir)
  if (!plan) {
    plan = await planResearchJob(job.id, signal)
    job = getResearchJob(job.id)!
  }

  if (job.depth !== 'continuous') {
    const completion = evaluateResearchCompletion({
      job,
      plan,
      coverage: researchClaimCoverage(job.id)
    })
    if (completion.shouldSynthesize) {
      await synthesizeResearchJob(job.id, { final: true, signal })
      job = getResearchJob(job.id)!
      return { ok: true, job, completed: job.status === 'completed' }
    }
  }

  const selectedSection = chooseResearchSection(plan, job.cycleCount, {
    revisitCompleted: job.depth !== 'continuous'
  })
  if (!selectedSection) {
    if (job.depth !== 'continuous') {
      const error = 'Research plan contains no evidence sections; regenerate the plan before publishing.'
      job = updateResearchJob(job.id, {
        status: 'error',
        error,
        nextRunAt: undefined
      })!
      logResearchEvent({ jobId: job.id, kind: 'error', title: 'Research plan needs attention', detail: error })
      return { ok: false, job, completed: false, error }
    }
    await synthesizeResearchJob(job.id, { final: job.depth !== 'continuous', signal })
    job = getResearchJob(job.id)!
    return { ok: true, job, completed: job.status === 'completed' }
  }
  const section = prepareResearchSectionForCycle(selectedSection, job.cycleCount)

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
      { workingDirectory: job.workspaceDir, background: true }
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
    const nextCycleCount = completedResearchCycleCountAfterSuccess(job.cycleCount)
    const state = nextWorkspaceState({
      current: readResearchState(job.workspaceDir),
      jobId: job.id,
      cycleCount: nextCycleCount,
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
    const clockedJob = getResearchJob(job.id) ?? job
    const decisionAt = Date.now()
    const completion = evaluateResearchCompletion({
      job: { ...clockedJob, cycleCount: nextCycleCount, sourceCount: latestSources.length },
      plan,
      coverage,
      now: decisionAt
    })
    const nextRunAt = completion.shouldSynthesize
      ? decisionAt
      : nextResearchCycleAt(
        { ...clockedJob, cycleCount: nextCycleCount, sourceCount: latestSources.length },
        decisionAt
      )
    updateResearchJob(job.id, {
      plan,
      cycleCount: nextCycleCount,
      sourceCount: latestSources.length,
      findingCount: latestClaims.length,
      status: completion.shouldSynthesize ? 'verifying' : 'researching',
      phase: completion.shouldSynthesize ? 'verify' : 'research',
      nextRunAt,
      error: undefined
    })
    logResearchEvent({
      jobId: job.id,
      cycleId: cycle.id,
      kind: 'cycle_completed',
      title: `Cycle ${cycle.cycleIndex} complete · ${sources.length} new sources`,
      detail: `${latestClaims.length} claims · ${Math.round(coverage.coverage * 100)}% verified coverage`
    })
    if (completion.shouldSynthesize) {
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
