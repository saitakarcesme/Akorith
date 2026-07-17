import { randomUUID } from 'crypto'
import { statSync } from 'fs'
import { getDb } from '../../db'
import type { ResearchArtifact, ResearchOutputFormat } from '../types'
import { rowToResearchArtifact, type DbRow } from './rows'

export function recordResearchArtifact(input: {
  jobId: string
  format: ResearchOutputFormat
  title: string
  path: string
  coverPath?: string
}): ResearchArtifact {
  const id = randomUUID()
  const createdAt = Date.now()
  const byteSize = statSync(input.path).size
  getDb().prepare(
    `INSERT INTO research_artifacts (
      id, job_id, format, title, path, cover_path, byte_size, created_at
    ) VALUES (
      @id, @job_id, @format, @title, @path, @cover_path, @byte_size, @created_at
    )`
  ).run({
    id,
    job_id: input.jobId,
    format: input.format,
    title: input.title.trim().slice(0, 300),
    path: input.path,
    cover_path: input.coverPath ?? null,
    byte_size: byteSize,
    created_at: createdAt
  })
  getDb().prepare(
    `UPDATE research_jobs SET artifact_path = @path, cover_path = @cover_path,
     updated_at = @updated_at WHERE id = @job_id`
  ).run({
    job_id: input.jobId,
    path: input.path,
    cover_path: input.coverPath ?? null,
    updated_at: createdAt
  })
  return getResearchArtifact(id)!
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
