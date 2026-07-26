import { unlinkSync } from 'fs'
import { buildResearchDocument, canonicalResearchSourceKey } from '../document'
import { writeResearchCover } from '../cover'
import {
  getResearchJob,
  listResearchClaims,
  listResearchSources,
  logResearchEvent,
  nextResearchArtifactVersion,
  recordResearchArtifact,
  updateResearchJob
} from '../store'
import type { ResearchArtifact, ResearchOutputFormat, ResearchSource } from '../types'
import {
  RESEARCH_FINDINGS_FILE,
  RESEARCH_REPORT_FILE,
  readResearchMarkdown,
  readResearchPlan,
  readResearchPublication,
  researchArtifactPath
} from '../workspace'
import { exportResearchDocx } from './docx'
import { exportResearchHtml } from './html'
import { exportResearchMarkdown } from './markdown'
import { exportResearchPdf } from './pdf'
import { exportResearchPptx } from './pptx'
import { validateResearchArtifact } from './validate'
import { exportResearchXlsx } from './xlsx'

const activeExports = new Map<string, Promise<ResearchArtifact>>()

export async function exportResearchJob(
  jobId: string,
  formatOverride?: ResearchOutputFormat,
  options: { trackLifecycle?: boolean } = {}
): Promise<ResearchArtifact> {
  const previous = activeExports.get(jobId)
  const current = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(() => exportResearchJobLocked(jobId, formatOverride, options))
  activeExports.set(jobId, current)
  try {
    return await current
  } finally {
    if (activeExports.get(jobId) === current) activeExports.delete(jobId)
  }
}

async function exportResearchJobLocked(
  jobId: string,
  formatOverride: ResearchOutputFormat | undefined,
  options: { trackLifecycle?: boolean }
): Promise<ResearchArtifact> {
  const job = getResearchJob(jobId)
  if (!job) throw new Error('Research job not found.')
  const format = formatOverride ?? job.outputFormat
  if (options.trackLifecycle) {
    updateResearchJob(job.id, { status: 'exporting', phase: 'export', error: undefined })
  }
  logResearchEvent({ jobId, kind: 'export_started', title: `Creating ${format.toUpperCase()} deliverable` })

  const publication = readResearchPublication(job.workspaceDir)
  const stablePublication = publication?.jobId === job.id ? publication : null
  const report = stablePublication?.reportMarkdown
    || readResearchMarkdown(job.workspaceDir, RESEARCH_REPORT_FILE)
    || readResearchMarkdown(job.workspaceDir, RESEARCH_FINDINGS_FILE)
  const persistedSources = listResearchSources(job.id)
  const sourcesById = new Map(persistedSources.map((source) => [source.id, source]))
  const sources = stablePublication
    ? stablePublication.sourceIds
      .map((sourceId) => sourcesById.get(sourceId))
      .filter((source): source is ResearchSource => Boolean(source))
    : persistedSources
  const publicationSourceIds = new Set(sources.map((source) => source.id))
  const publicationSourceIdByKey = new Map(
    sources.map((source) => [canonicalResearchSourceKey(source), source.id])
  )
  const claims = listResearchClaims(job.id)
    .filter((claim) => !stablePublication || claim.createdAt <= stablePublication.generatedAt)
    .map((claim) => ({
      ...claim,
      evidence: claim.evidence
        .map((evidence) => {
          const evidenceSource = sourcesById.get(evidence.sourceId)
          const stableSourceId = stablePublication && evidenceSource
            ? publicationSourceIdByKey.get(canonicalResearchSourceKey(evidenceSource))
            : undefined
          return { ...evidence, sourceId: stableSourceId ?? evidence.sourceId }
        })
        .filter((evidence) => publicationSourceIds.has(evidence.sourceId))
    }))
  const document = buildResearchDocument({
    job,
    plan: job.plan ?? readResearchPlan(job.workspaceDir) ?? undefined,
    reportMarkdown: report,
    claims,
    sources,
    generatedAt: stablePublication?.generatedAt
  })
  const version = nextResearchArtifactVersion(job.id, format)
  const coverPath = writeResearchCover(job.workspaceDir, document)
  const path = version === 1
    ? researchArtifactPath(job.workspaceDir, document.title, format)
    : researchArtifactPath(job.workspaceDir, `${document.title}-v${version}`, format)
  await exportByFormat(format, job.workspaceDir, document, path)
  const validation = await validateResearchArtifact(format, path)
  const artifact = recordResearchArtifact({
    jobId: job.id,
    format,
    title: document.title,
    path,
    coverPath,
    version,
    validation
  })
  if (!validation.ok) {
    try { unlinkSync(path) } catch { /* best effort: invalid output remains hidden */ }
    if (options.trackLifecycle) updateResearchJob(job.id, { status: 'error', error: validation.error })
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
  document: ReturnType<typeof buildResearchDocument>,
  outputPath: string
): Promise<string> {
  if (format === 'html') return exportResearchHtml(workspaceDir, document, outputPath)
  if (format === 'md') return exportResearchMarkdown(workspaceDir, document, outputPath)
  if (format === 'pdf') return exportResearchPdf(workspaceDir, document, outputPath)
  if (format === 'docx') return exportResearchDocx(workspaceDir, document, outputPath)
  if (format === 'xlsx') return exportResearchXlsx(workspaceDir, document, outputPath)
  return exportResearchPptx(workspaceDir, document, outputPath)
}

export { validateResearchArtifact } from './validate'
export { sanitizeSpreadsheetCell } from './xlsx'
