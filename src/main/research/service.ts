import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'fs'
import { shell } from 'electron'
import { getProject } from '../db'
import { runCli } from '../providers/util'
import {
  normalizeEditablePaths,
  parseAutoresearchCommand,
  parseStoredAutoresearchResult,
  starterExperimentConfig,
  validateMetricPattern
} from './autoresearch-core'
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
  AutoresearchExperiment,
  AutoresearchExperimentConfig,
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
  experiments: AutoresearchExperiment[]
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
  experiments: AutoresearchExperiment[]
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

const MAX_LIVE_AUTORESEARCH_EXPERIMENTS = 100

export function createManagedResearchJob(input: CreateResearchJobInput): ResearchJob {
  const id = randomUUID()
  const workspaceDir = initializeResearchWorkspace(id)
  try {
    const canonicalInput = canonicalizeCreateInput(input)
    const job = createResearchJob(canonicalInput, workspaceDir, id)
    logResearchEvent({
      jobId: job.id,
      kind: 'created',
      title: canonicalInput.autoStart === false
        ? 'Research draft created'
        : job.mode === 'autoresearch'
          ? 'Autoresearch experiment program queued'
          : 'Autonomous research queued',
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
  const cycles = listResearchCycles(
    job.id,
    job.mode === 'autoresearch' ? MAX_LIVE_AUTORESEARCH_EXPERIMENTS : undefined
  )
  return {
    job,
    cycles,
    experiments: researchExperiments(job, cycles),
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
      experiments: researchExperiments(
        job,
        listResearchCycles(
          job.id,
          job.mode === 'autoresearch' ? MAX_LIVE_AUTORESEARCH_EXPERIMENTS : undefined
        )
      ),
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

export async function deleteManagedResearchJob(id: string): Promise<boolean> {
  const job = requireResearchJob(id)
  requestResearchCancellation(id)
  const root = researchRoot()
  if (!isManagedResearchPath(root, job.workspaceDir)) {
    throw new Error('Research workspace is not managed by Akorith.')
  }
  if (
    job.mode === 'autoresearch'
    && job.experimentConfig?.target.kind === 'project'
    && job.experimentState?.repositoryDir
    && isManagedResearchPath(job.workspaceDir, job.experimentState.repositoryDir)
    && existsSync(job.experimentConfig.target.projectPath)
  ) {
    try {
      await runCli(
        'git',
        ['worktree', 'remove', '--force', job.experimentState.repositoryDir],
        { cwd: job.experimentConfig.target.projectPath, timeoutMs: 60_000 }
      )
      await runCli('git', ['worktree', 'prune'], {
        cwd: job.experimentConfig.target.projectPath,
        timeoutMs: 60_000
      })
    } catch {
      // The managed directory is removed below. Git can prune a stale
      // worktree registration the next time this project starts a run.
    }
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

function canonicalizeCreateInput(input: CreateResearchJobInput): CreateResearchJobInput {
  if ((input.mode ?? 'evidence') !== 'autoresearch') return input
  const requested = input.autoresearch
  if (!requested?.target) throw new Error('Choose an Autoresearch target.')

  let experimentConfig: AutoresearchExperimentConfig
  if (requested.target.kind === 'karpathy-starter') {
    experimentConfig = starterExperimentConfig()
  } else {
    const project = getProject(requested.target.projectId)
    if (!project?.path) throw new Error('The selected Akorith project has no local folder.')
    const projectPath = realpathSync.native(project.path)
    if (!statSync(projectPath).isDirectory()) throw new Error('The selected project folder is unavailable.')
    const timeoutMinutes = Number(requested.experimentTimeoutMinutes)
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) {
      throw new Error('Experiment timeout must be between 1 and 120 minutes.')
    }
    experimentConfig = {
      version: 1,
      target: {
        kind: 'project',
        projectId: project.id,
        projectName: project.name,
        projectPath
      },
      command: parseAutoresearchCommand(requested.command ?? ''),
      metric: {
        name: cleanMetricName(requested.metricName),
        pattern: validateMetricPattern(requested.metricPattern ?? ''),
        direction: requested.metricDirection === 'maximize' ? 'maximize' : 'minimize'
      },
      editablePaths: normalizeEditablePaths(requested.editablePaths ?? []),
      experimentTimeoutMs: Math.round(timeoutMinutes * 60_000)
    }
  }
  return {
    ...input,
    mode: 'autoresearch',
    outputFormat: 'md',
    experimentConfig
  }
}

function researchExperiments(job: ResearchJob, cycles: ResearchCycle[]): AutoresearchExperiment[] {
  if (job.mode !== 'autoresearch') return []
  return cycles.flatMap((cycle): AutoresearchExperiment[] => {
    const result = parseStoredAutoresearchResult(cycle)
    if (!result) return []
    return [{
      id: cycle.id,
      jobId: job.id,
      cycleId: cycle.id,
      index: cycle.cycleIndex,
      kind: result.kind,
      status: result.status,
      description: result.description,
      commit: result.commit,
      metric: result.metric,
      previousBest: result.previousBest,
      memoryGb: result.memoryGb,
      durationMs: result.durationMs,
      changedFiles: result.changedFiles,
      logFile: result.logFile,
      error: result.error,
      startedAt: cycle.startedAt,
      endedAt: cycle.endedAt
    }]
  })
}

function cleanMetricName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Metric name is required.')
  const clean = value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  if (!clean) throw new Error('Metric name is required.')
  return clean
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
