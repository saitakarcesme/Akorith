import { randomUUID } from 'crypto'
import { existsSync, readFileSync, rmSync } from 'fs'
import { shell } from 'electron'
import { exportResearchJob } from './exporters'
import {
  archiveResearchJob,
  clearResearchCancellation,
  createResearchJob,
  deleteResearchJob,
  getResearchArtifact,
  getResearchJob,
  latestResearchCheckpoint,
  listLatestResearchEvents,
  listResearchArtifacts,
  listResearchClaims,
  listResearchCycles,
  listResearchJobs,
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
  ResearchSource
} from './types'
import {
  initializeResearchWorkspace,
  isManagedResearchPath,
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
    startedAt: job.startedAt ?? Date.now(),
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
