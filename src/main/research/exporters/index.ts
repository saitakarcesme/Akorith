import { unlinkSync } from 'fs'
import { buildResearchDocument } from '../document'
import { writeResearchCover } from '../cover'
import {
  getResearchJob,
  listResearchClaims,
  listResearchSources,
  logResearchEvent,
  recordResearchArtifact,
  updateResearchJob
} from '../store'
import type { ResearchArtifact, ResearchOutputFormat } from '../types'
import {
  RESEARCH_FINDINGS_FILE,
  RESEARCH_REPORT_FILE,
  readResearchMarkdown,
  readResearchPlan
} from '../workspace'
import { exportResearchDocx } from './docx'
import { exportResearchMarkdown } from './markdown'
import { exportResearchPdf } from './pdf'
import { validateResearchArtifact } from './validate'
import { exportResearchXlsx } from './xlsx'

export async function exportResearchJob(
  jobId: string,
  formatOverride?: ResearchOutputFormat
): Promise<ResearchArtifact> {
  const job = getResearchJob(jobId)
  if (!job) throw new Error('Research job not found.')
  const format = formatOverride ?? job.outputFormat
  updateResearchJob(job.id, { status: 'exporting', phase: 'export', error: undefined })
  logResearchEvent({ jobId, kind: 'export_started', title: `Creating ${format.toUpperCase()} deliverable` })

  const report = readResearchMarkdown(job.workspaceDir, RESEARCH_REPORT_FILE)
    || readResearchMarkdown(job.workspaceDir, RESEARCH_FINDINGS_FILE)
  const document = buildResearchDocument({
    job,
    plan: job.plan ?? readResearchPlan(job.workspaceDir) ?? undefined,
    reportMarkdown: report,
    claims: listResearchClaims(job.id),
    sources: listResearchSources(job.id)
  })
  const coverPath = writeResearchCover(job.workspaceDir, document)
  const path = await exportByFormat(format, job.workspaceDir, document)
  const validation = await validateResearchArtifact(format, path)
  const artifact = recordResearchArtifact({
    jobId: job.id,
    format,
    title: document.title,
    path,
    coverPath,
    validation
  })
  if (!validation.ok) {
    try { unlinkSync(path) } catch { /* best effort: invalid output remains hidden */ }
    updateResearchJob(job.id, { status: 'error', error: validation.error })
    logResearchEvent({
      jobId,
      kind: 'error',
      title: `${format.toUpperCase()} validation failed`,
      detail: validation.error
    })
    throw new Error(validation.error || 'Research artifact validation failed.')
  }
  logResearchEvent({
    jobId,
    kind: 'artifact_created',
    title: `${format.toUpperCase()} report is ready`,
    detail: `${validation.byteSize.toLocaleString()} bytes · sha256 ${validation.checksum.slice(0, 12)}`
  })
  return artifact
}

async function exportByFormat(
  format: ResearchOutputFormat,
  workspaceDir: string,
  document: ReturnType<typeof buildResearchDocument>
): Promise<string> {
  if (format === 'md') return exportResearchMarkdown(workspaceDir, document)
  if (format === 'pdf') return exportResearchPdf(workspaceDir, document)
  if (format === 'docx') return exportResearchDocx(workspaceDir, document)
  return exportResearchXlsx(workspaceDir, document)
}

export { validateResearchArtifact } from './validate'
export { sanitizeSpreadsheetCell } from './xlsx'
