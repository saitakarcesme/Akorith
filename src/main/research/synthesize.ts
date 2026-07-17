import { renameSync, writeFileSync } from 'fs'
import { sendMetaPrompt } from '../providers/registry'
import { exportResearchJob } from './exporters'
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
  writeResearchPlan
} from './workspace'

export async function synthesizeResearchJob(
  jobId: string,
  options: { final: boolean; signal?: AbortSignal }
): Promise<ResearchArtifact> {
  const job = getResearchJob(jobId)
  if (!job) throw new Error('Research job not found.')
  const plan = job.plan ?? readResearchPlan(job.workspaceDir)
  if (!plan) throw new Error('Research plan is missing.')
  updateResearchJob(job.id, { status: 'synthesizing', phase: 'synthesize', error: undefined })
  logResearchEvent({ jobId, kind: 'synthesis_started', title: 'Writing the evidence-backed report' })
  const findings = readResearchMarkdown(job.workspaceDir, RESEARCH_FINDINGS_FILE)
  const claims = listResearchClaims(job.id)
  const sources = listResearchSources(job.id)
  let report: string
  try {
    const response = await sendMetaPrompt(
      job.providerId,
      job.model,
      buildResearchSynthesisPrompt({ job, plan, findings, claims, sources }),
      options.signal,
      { workingDirectory: job.workspaceDir }
    )
    report = sanitizeResearchReportCitations(response.text.trim(), sources.length)
    if (!/^#\s+\S/m.test(report)) report = `# ${plan.title}\n\n${report}`
  } catch (error) {
    report = fallbackReport(plan, findings, sources.length, error)
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
  updateResearchJob(job.id, { summary: reportSummary(report) })
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
      title: 'Research completed with a validated deliverable',
      detail: artifact.path
    })
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
  findings: string,
  sourceCount: number,
  error: unknown
): string {
  return `# ${plan.title}

## Executive summary

Akorith preserved the evidence collected during this unattended research. The final editorial pass was unavailable, so this report keeps the cycle findings intact instead of inventing a polished conclusion.

${findings.trim() || 'No accessible evidence was collected.'}

## Limitations and open questions

- ${sourceCount} unique accessible source${sourceCount === 1 ? '' : 's'} were recorded.
- Final synthesis limitation: ${error instanceof Error ? error.message : String(error)}
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
