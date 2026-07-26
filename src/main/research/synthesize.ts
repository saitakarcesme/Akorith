import { renameSync, writeFileSync } from 'fs'
import { sendMetaPrompt } from '../providers/registry'
import { buildResearchSynthesisPrompt, sanitizeResearchReportCitations } from './prompts/synthesis'
import {
  getResearchJob,
  listResearchClaims,
  listResearchSources,
  logResearchEvent,
  updateResearchJob
} from './store'
import { RESEARCH_DEPTH_PROFILES, type ResearchArtifact, type ResearchPlan } from './types'
import {
  RESEARCH_FINDINGS_FILE,
  RESEARCH_REPORT_FILE,
  readResearchMarkdown,
  readResearchPlan,
  safeResearchPath,
  writeResearchPlan,
  writeResearchPublication
} from './workspace'
import { recordResearchModelUsage } from './usage'
import { enqueueCompletedResearchDiscordDelivery } from './discord-delivery'
import {
  deduplicateResearchSources,
  rankAndDeduplicateResearchClaims
} from './document'

export async function synthesizeResearchJob(
  jobId: string,
  options: { final: boolean; signal?: AbortSignal }
): Promise<ResearchArtifact> {
  const job = getResearchJob(jobId)
  if (!job) throw new Error('Research job not found.')
  const plan = job.plan ?? readResearchPlan(job.workspaceDir)
  if (!plan) throw new Error('Research plan is missing.')
  updateResearchJob(job.id, { status: 'synthesizing', phase: 'synthesize', error: undefined })
  logResearchEvent({ jobId, kind: 'synthesis_started', title: 'Writing the publication-ready research essay' })
  const findings = readResearchMarkdown(job.workspaceDir, RESEARCH_FINDINGS_FILE)
  const persistedSources = listResearchSources(job.id)
  const sourceDisplay = deduplicateResearchSources(persistedSources)
  const claims = rankAndDeduplicateResearchClaims(listResearchClaims(job.id).map((claim) => ({
    ...claim,
    evidence: claim.evidence.map((evidence) => ({
      ...evidence,
      sourceId: sourceDisplay.redirects.get(evidence.sourceId) ?? evidence.sourceId
    }))
  })))
  const sources = sourceDisplay.sources
  let report: string
  try {
    const response = await sendMetaPrompt(
      job.providerId,
      job.model,
      buildResearchSynthesisPrompt({ job, plan, findings, claims, sources }),
      options.signal,
      { workingDirectory: job.workspaceDir, background: true }
    )
    recordResearchModelUsage({
      job,
      kind: 'research-synthesis',
      turnId: `${job.id}:${job.cycleCount}:${options.final ? 'final' : 'snapshot'}`,
      model: response.model,
      usage: response.usage
    })
    report = sanitizeResearchReportCitations(response.text.trim(), sources.length)
    if (!/^#\s+\S/m.test(report)) report = `# ${plan.title}\n\n${report}`
  } catch (error) {
    report = fallbackReport(plan, claims, sources)
    logResearchEvent({
      jobId,
      kind: 'warning',
      title: 'Final editor was unavailable; Akorith preserved the cited findings',
      detail: error instanceof Error ? error.message : String(error)
    })
  }
  const reportPath = safeResearchPath(job.workspaceDir, RESEARCH_REPORT_FILE)
  const partial = `${reportPath}.partial`
  writeFileSync(partial, `${report.trim()}\n`, 'utf8')
  renameSync(partial, reportPath)
  writeResearchPublication(job.workspaceDir, {
    version: 1,
    jobId: job.id,
    generatedAt: Date.now(),
    reportMarkdown: `${report.trim()}\n`,
    sourceIds: sources.map((source) => source.id)
  })
  updateResearchJob(job.id, { summary: reportSummary(report) })
  const { exportResearchJob } = await import('./exporters')
  const artifact = await exportResearchJob(job.id, undefined, { trackLifecycle: true })
  const now = Date.now()
  if (options.final) {
    updateResearchJob(job.id, {
      status: 'completed',
      phase: 'export',
      completedAt: now,
      nextRunAt: undefined,
      error: undefined
    })
    logResearchEvent({
      jobId,
      kind: 'completed',
      title: 'Research essay completed with a validated publication',
      detail: artifact.path
    })
    enqueueCompletedResearchDiscordDelivery(job.id, artifact.id)
  } else {
    const resetPlan: ResearchPlan = {
      ...plan,
      sections: plan.sections.map((section) => ({ ...section, status: 'pending' }))
    }
    writeResearchPlan(job.workspaceDir, resetPlan)
    updateResearchJob(job.id, {
      plan: resetPlan,
      status: 'researching',
      phase: 'research',
      nextRunAt: now + RESEARCH_DEPTH_PROFILES.continuous.cycleIntervalMs,
      error: undefined
    })
    logResearchEvent({
      jobId,
      kind: 'cycle_completed',
      title: 'Continuous research snapshot published; monitoring continues',
      detail: artifact.path
    })
  }
  return artifact
}

function fallbackReport(
  plan: ResearchPlan,
  claims: ReturnType<typeof listResearchClaims>,
  sources: ReturnType<typeof listResearchSources>
): string {
  const sourceNumber = new Map(sources.map((source, index) => [source.id, index + 1]))
  const citedClaims = claims
    .filter((claim) => claim.evidence.some((evidence) => sourceNumber.has(evidence.sourceId)))
    .map((claim) => {
      const citations = [...new Set(claim.evidence
        .map((evidence) => sourceNumber.get(evidence.sourceId))
        .filter((value): value is number => value !== undefined))]
      return {
        ...claim,
        citation: citations.length > 0 ? ` [${citations.join(', ')}]` : ''
      }
    })
  const abstract = citedClaims.slice(0, 2).map((claim) => `${claim.text}${claim.citation}`).join(' ')
    || 'The available source record did not support a publication-ready conclusion.'
  const sections = plan.sections.map((section) => {
    const paragraphs = citedClaims
      .filter((claim) => claim.sectionId === section.id)
      .map((claim) => `${claim.text}${claim.citation}`)
    return paragraphs.length > 0
      ? `## ${section.title}\n\n${paragraphs.join('\n\n')}`
      : ''
  }).filter(Boolean)
  const analyticalClaims = citedClaims.slice(0, 4)
  const analysis = analyticalClaims.length > 0
    ? analyticalClaims
      .map((claim) => `${claim.text}${claim.citation}`)
      .join(' ')
    : 'The accessible record is too limited for a defensible comparative analysis.'
  const disagreements = citedClaims
    .filter((claim) =>
      claim.status === 'conflicted'
      || claim.evidence.some((evidence) => evidence.relation === 'contradicts')
    )
  const perspectives = disagreements.length > 0
    ? `## Differing views\n\n${disagreements.map((claim) => `${claim.text}${claim.citation}`).join('\n\n')}`
    : ''
  const conclusion = citedClaims.length > 0
    ? `The retained evidence supports the findings above within the scope of the cited sources. ${citedClaims.some((claim) => claim.status === 'conflicted') ? 'Where sources disagree, the disagreement remains unresolved rather than being averaged away.' : ''}`.trim()
    : 'The available evidence is not yet sufficient for a defensible conclusion.'

  return `# ${plan.title}

## Abstract

${abstract}

## Introduction

${plan.thesis}

${sections.join('\n\n') || '## Findings\n\nThe accessible sources did not establish a sufficiently supported finding.'}

## Analysis

${analysis}

${perspectives}

## Conclusion

${conclusion}
`
}

function reportSummary(report: string): string {
  return report
    .replace(/^#{1,6}\s+.*$/gm, '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .find(Boolean)
    ?.slice(0, 2_000) || 'Research report created.'
}
