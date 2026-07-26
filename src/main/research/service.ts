import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync, rmSync } from 'fs'
import { shell } from 'electron'
import {
  archiveResearchJob,
  clearResearchCancellation,
  createResearchJob,
  deleteResearchJob,
  getResearchArtifact,
  getResearchJob,
  latestResearchEventCursor,
  latestResearchCheckpoint,
  listLatestResearchEventSummaries,
  listLatestResearchEvents,
  listResearchArtifacts,
  listResearchClaims,
  listResearchCycles,
  listResearchJobs,
  listResearchSourceSummaries,
  listResearchSources,
  logResearchEvent,
  requestResearchCancellation,
  updateResearchJob
} from './store'
import type {
  CreateResearchJobInput,
  ResearchArtifact,
  ResearchCheckpoint,
  ResearchClaim,
  ResearchCycle,
  ResearchEvent,
  ResearchJob,
  ResearchOutputFormat,
  ResearchSource,
  ResearchStatus
} from './types'
import {
  initializeResearchWorkspace,
  isManagedResearchPath,
  readResearchMarkdown,
  readResearchPublication,
  RESEARCH_REPORT_FILE,
  researchRoot
} from './workspace'

export interface ResearchJobDetail {
  job: ResearchJob
  cycles: ResearchCycle[]
  events: ResearchEvent[]
  sources: ResearchSource[]
  claims: ResearchClaim[]
  artifacts: ResearchArtifact[]
  checkpoint: ResearchCheckpoint | null
}

export interface ResearchLiveDetail {
  job: ResearchJob
  events: ResearchEvent[]
  sources: ResearchSource[]
  artifacts: ResearchArtifact[]
  running: boolean
}

export interface ResearchPollResponse {
  version: string
  unchanged: boolean
  status: ResearchStatus
  running: boolean
  detail?: ResearchLiveDetail
}

export interface ResearchEssayPreview {
  jobId: string
  version: string
  title: string
  summary: string
  markdown: string
  citations: Array<{
    number: number
    sourceId: string
    label: string
  }>
}

export function createManagedResearchJob(input: CreateResearchJobInput): ResearchJob {
  const id = randomUUID()
  const workspaceDir = initializeResearchWorkspace(id)
  try {
    const job = createResearchJob(input, workspaceDir, id)
    logResearchEvent({
      jobId: job.id,
      kind: 'created',
      title: input.autoStart === false ? 'Research draft created' : 'Autonomous research queued',
      detail: `${job.depth} · ${job.outputFormat.toUpperCase()} · ${job.providerId}${job.model ? ` / ${job.model}` : ''}`
    })
    return job
  } catch (error) {
    rmSync(workspaceDir, { recursive: true, force: true })
    throw error
  }
}

export function getResearchJobDetail(id: string): ResearchJobDetail {
  const job = requireResearchJob(id)
  return {
    job,
    cycles: listResearchCycles(job.id),
    events: listLatestResearchEvents(job.id, 500),
    sources: listResearchSources(job.id),
    claims: listResearchClaims(job.id),
    artifacts: listResearchArtifacts(job.id),
    checkpoint: latestResearchCheckpoint(job.id)
  }
}

function researchPollVersion(job: ResearchJob, latestEventId: string | undefined, running: boolean): string {
  return [
    job.revision,
    job.updatedAt,
    job.activeElapsedMs,
    job.activeAccountingAt ?? 0,
    job.status,
    job.phase,
    job.cycleCount,
    job.sourceCount,
    job.findingCount,
    latestEventId ?? 'none',
    running ? 1 : 0
  ].join('.')
}

/**
 * Small, conditional snapshot for the live Research surface. The full detail
 * path above remains intact for main-process synthesis/export and compatibility.
 */
export function pollResearchJob(id: string, running: boolean, knownVersion?: string): ResearchPollResponse {
  const job = requireResearchJob(id)
  const latestEvent = latestResearchEventCursor(job.id)
  const version = researchPollVersion(job, latestEvent?.id, running)
  if (knownVersion === version) {
    return { version, unchanged: true, status: job.status, running }
  }
  return {
    version,
    unchanged: false,
    status: job.status,
    running,
    detail: {
      job,
      events: listLatestResearchEventSummaries(job.id, 80),
      sources: listResearchSourceSummaries(job.id),
      artifacts: listResearchArtifacts(job.id),
      running
    }
  }
}

/**
 * Read the canonical essay from Akorith's managed Research workspace without
 * exposing a filesystem path to the renderer. Source numbering intentionally
 * uses the same ordered source list supplied to the synthesis prompt.
 */
export function getResearchEssayPreview(id: string): ResearchEssayPreview | null {
  const job = requireResearchJob(id)
  if (job.status !== 'completed' && job.status !== 'archived') return null
  if (!isManagedResearchPath(researchRoot(), job.workspaceDir)) {
    throw new Error('Research workspace is not managed by Akorith.')
  }
  const publication = readResearchPublication(job.workspaceDir)
  const stablePublication = publication?.jobId === job.id ? publication : null
  const markdown = (
    stablePublication?.reportMarkdown
    || readResearchMarkdown(job.workspaceDir, RESEARCH_REPORT_FILE)
  ).trim()
  if (!markdown || /^#\s+Research report\s*$/i.test(markdown)) return null
  const persistedSources = listResearchSources(job.id)
  const sourcesById = new Map(persistedSources.map((source) => [source.id, source]))
  const sources = stablePublication
    ? stablePublication.sourceIds.map((sourceId) => sourcesById.get(sourceId)).filter((source): source is ResearchSource => Boolean(source))
    : persistedSources
  const revisionInput = stablePublication
    ? `${stablePublication.generatedAt}\0${stablePublication.sourceIds.join('\0')}\0${markdown}`
    : markdown
  return {
    jobId: job.id,
    version: createHash('sha256').update(revisionInput).digest('hex').slice(0, 16),
    title: /^#\s+(.+?)\s*$/m.exec(markdown)?.[1]?.replace(/[*_`]/g, '').trim()
      || job.plan?.title
      || job.title,
    summary: job.summary || firstEssayParagraph(markdown),
    markdown,
    citations: sources.map((source, index) => ({
      number: index + 1,
      sourceId: source.id,
      label: `${source.publisher || sourceHostname(source.url)}. ${source.title}`
    }))
  }
}

export function listResearchLibrary(): ResearchJob[] {
  return listResearchJobs({ includeArchived: false, limit: 1_000 })
}

export function startResearchJob(id: string): ResearchJob {
  const job = requireResearchJob(id)
  if (job.status === 'completed' || job.status === 'archived') {
    throw new Error(`Research is already ${job.status}.`)
  }
  clearResearchCancellation(job.id)
  const status = job.plan ? 'researching' : 'planning'
  const resumed = updateResearchJob(job.id, {
    status,
    phase: job.plan ? 'research' : 'understand',
    nextRunAt: Date.now(),
    error: undefined
  })!
  logResearchEvent({ jobId: job.id, kind: 'resumed', title: 'Autonomous research resumed' })
  return resumed
}

export function pauseResearchJob(id: string): ResearchJob {
  const job = requireResearchJob(id)
  requestResearchCancellation(job.id)
  const paused = updateResearchJob(job.id, {
    status: 'paused',
    nextRunAt: undefined,
    error: undefined
  })!
  logResearchEvent({ jobId: job.id, kind: 'paused', title: 'Research paused safely after its current operation' })
  return paused
}

export function archiveManagedResearchJob(id: string): ResearchJob {
  requireResearchJob(id)
  requestResearchCancellation(id)
  const archived = archiveResearchJob(id)
  if (!archived) throw new Error('Research could not be archived.')
  return archived
}

export function deleteManagedResearchJob(id: string): boolean {
  const job = requireResearchJob(id)
  requestResearchCancellation(id)
  const root = researchRoot()
  if (!isManagedResearchPath(root, job.workspaceDir)) {
    throw new Error('Research workspace is not managed by Akorith.')
  }
  const deleted = deleteResearchJob(id)
  if (deleted) {
    rmSync(job.workspaceDir, { recursive: true, force: true })
  }
  return deleted
}

export async function exportManagedResearchJob(
  id: string,
  format?: ResearchOutputFormat
): Promise<ResearchArtifact> {
  requireResearchJob(id)
  const { exportResearchJob } = await import('./exporters')
  return exportResearchJob(id, format)
}

export async function openResearchArtifact(id: string): Promise<void> {
  const { artifact } = requireManagedArtifact(id)
  const error = await shell.openPath(artifact.path)
  if (error) throw new Error(error)
}

export function revealResearchArtifact(id: string): void {
  const { artifact } = requireManagedArtifact(id)
  shell.showItemInFolder(artifact.path)
}

export function researchCoverDataUrl(id: string): string | null {
  const job = requireResearchJob(id)
  if (!job.coverPath || !existsSync(job.coverPath) || !isManagedResearchPath(job.workspaceDir, job.coverPath)) {
    return null
  }
  const data = readFileSync(job.coverPath)
  return `data:image/svg+xml;base64,${data.toString('base64')}`
}

function requireResearchJob(id: string): ResearchJob {
  if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) throw new Error('invalid research job id')
  const job = getResearchJob(id)
  if (!job) throw new Error('Research job not found.')
  return job
}

function firstEssayParagraph(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+.*$/gm, '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .find(Boolean)
    ?.slice(0, 2_000) || 'Research completed.'
}

function sourceHostname(value: string): string {
  try {
    return new URL(value).hostname
  } catch {
    return 'Source'
  }
}

function requireManagedArtifact(id: string): { job: ResearchJob; artifact: ResearchArtifact } {
  if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) throw new Error('invalid research artifact id')
  const artifact = getResearchArtifact(id)
  if (!artifact) throw new Error('Research artifact is unavailable.')
  const job = requireResearchJob(artifact.jobId)
  if (!existsSync(artifact.path) || !isManagedResearchPath(job.workspaceDir, artifact.path)) {
    throw new Error('Research artifact is unavailable.')
  }
  return { job, artifact }
}
