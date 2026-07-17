import { randomUUID } from 'crypto'
import { getDb } from '../../db'
import type { ResearchArtifact, ResearchOutputFormat } from '../types'
import type { ArtifactValidationResult } from '../exporters/validate'
import { rowToResearchArtifact, type DbRow } from './rows'

export function recordResearchArtifact(input: {
  jobId: string
  format: ResearchOutputFormat
  title: string
  path: string
  coverPath?: string
  version?: number
  validation: ArtifactValidationResult
}): ResearchArtifact {
  const id = randomUUID()
  const createdAt = Date.now()
  getDb().prepare(
    `INSERT INTO research_artifacts (
      id, job_id, format, title, path, cover_path, byte_size, status, checksum,
      mime_type, version, page_count, validation_error, created_at
    ) VALUES (
      @id, @job_id, @format, @title, @path, @cover_path, @byte_size, @status,
      @checksum, @mime_type, @version, @page_count, @validation_error, @created_at
    )`
  ).run({
    id,
    job_id: input.jobId,
    format: input.format,
    title: input.title.trim().slice(0, 300),
    path: input.path,
    cover_path: input.coverPath ?? null,
    byte_size: input.validation.byteSize,
    status: input.validation.ok ? 'ready' : 'invalid',
    checksum: input.validation.checksum,
    mime_type: input.validation.mimeType,
    version: Math.max(1, Math.floor(input.version ?? 1)),
    page_count: input.validation.pageCount ?? null,
    validation_error: input.validation.error ?? null,
    created_at: createdAt
  })
  if (input.validation.ok) {
    getDb().prepare(
      `UPDATE research_jobs SET artifact_path = @path, cover_path = @cover_path,
       updated_at = @updated_at WHERE id = @job_id`
    ).run({
      job_id: input.jobId,
      path: input.path,
      cover_path: input.coverPath ?? null,
      updated_at: createdAt
    })
  }
  return getResearchArtifact(id)!
}

export function nextResearchArtifactVersion(jobId: string, format: ResearchOutputFormat): number {
  const row = getDb().prepare(
    'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM research_artifacts WHERE job_id = ? AND format = ?'
  ).get(jobId, format) as { version: number }
  return Math.max(1, Number(row.version) || 1)
}

export function getResearchArtifact(id: string): ResearchArtifact | null {
  const row = getDb().prepare('SELECT * FROM research_artifacts WHERE id = ?').get(id) as DbRow | undefined
  return row ? rowToResearchArtifact(row) : null
}

export function listResearchArtifacts(jobId: string): ResearchArtifact[] {
  const rows = getDb().prepare(
    'SELECT * FROM research_artifacts WHERE job_id = ? ORDER BY created_at DESC'
  ).all(jobId) as DbRow[]
  return rows.map(rowToResearchArtifact)
}

export function latestResearchArtifact(jobId: string): ResearchArtifact | null {
  const row = getDb().prepare(
    'SELECT * FROM research_artifacts WHERE job_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(jobId) as DbRow | undefined
  return row ? rowToResearchArtifact(row) : null
}
