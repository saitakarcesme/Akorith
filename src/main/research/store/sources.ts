import { randomUUID } from 'crypto'
import { getDb } from '../../db'
import type { ResearchSource } from '../types'
import {
  canonicalizeResearchUrl,
  estimateSourceCredibility,
  researchContentFingerprint
} from '../source-policy'
import { rowToResearchSource, type DbRow } from './rows'

export interface RecordResearchSourceInput {
  jobId: string
  cycleId?: string
  url: string
  title: string
  publisher?: string
  publishedAt?: string
  excerpt?: string
  relevance?: string
  credibilityScore?: number
  verified?: boolean
}

export function recordResearchSource(input: RecordResearchSourceInput): ResearchSource | null {
  const url = canonicalizeResearchUrl(input.url)
  if (!url) return null
  const excerpt = input.excerpt?.replace(/\u0000/g, '').trim().slice(0, 40_000)
  const contentHash = excerpt ? researchContentFingerprint(excerpt) : undefined
  if (contentHash) {
    const duplicate = getDb().prepare(
      'SELECT * FROM research_sources WHERE job_id = ? AND content_hash = ? LIMIT 1'
    ).get(input.jobId, contentHash) as DbRow | undefined
    if (duplicate) return rowToResearchSource(duplicate)
  }

  const id = randomUUID()
  const accessedAt = Date.now()
  const credibility = Math.max(0, Math.min(1, input.credibilityScore ?? estimateSourceCredibility(url)))
  getDb().prepare(
    `INSERT INTO research_sources (
      id, job_id, cycle_id, url, title, publisher, published_at, accessed_at,
      excerpt, relevance, credibility_score, content_hash, verified
    ) VALUES (
      @id, @job_id, @cycle_id, @url, @title, @publisher, @published_at, @accessed_at,
      @excerpt, @relevance, @credibility_score, @content_hash, @verified
    )
    ON CONFLICT(job_id, url) DO UPDATE SET
      cycle_id = COALESCE(excluded.cycle_id, research_sources.cycle_id),
      title = excluded.title,
      publisher = COALESCE(excluded.publisher, research_sources.publisher),
      published_at = COALESCE(excluded.published_at, research_sources.published_at),
      accessed_at = excluded.accessed_at,
      excerpt = COALESCE(excluded.excerpt, research_sources.excerpt),
      relevance = COALESCE(excluded.relevance, research_sources.relevance),
      credibility_score = MAX(excluded.credibility_score, research_sources.credibility_score),
      content_hash = COALESCE(excluded.content_hash, research_sources.content_hash),
      verified = MAX(excluded.verified, research_sources.verified)`
  ).run({
    id,
    job_id: input.jobId,
    cycle_id: input.cycleId ?? null,
    url,
    title: input.title.replace(/\s+/g, ' ').trim().slice(0, 500) || new URL(url).hostname,
    publisher: input.publisher?.trim().slice(0, 300) ?? null,
    published_at: input.publishedAt?.trim().slice(0, 100) ?? null,
    accessed_at: accessedAt,
    excerpt: excerpt ?? null,
    relevance: input.relevance?.trim().slice(0, 4_000) ?? null,
    credibility_score: credibility,
    content_hash: contentHash ?? null,
    verified: input.verified ? 1 : 0
  })

  const row = getDb().prepare(
    'SELECT * FROM research_sources WHERE job_id = ? AND url = ?'
  ).get(input.jobId, url) as DbRow
  const source = rowToResearchSource(row)
  refreshResearchSourceCount(input.jobId)
  return source
}

export function listResearchSources(jobId: string): ResearchSource[] {
  const rows = getDb().prepare(
    `SELECT * FROM research_sources WHERE job_id = ?
     ORDER BY verified DESC, credibility_score DESC, accessed_at DESC`
  ).all(jobId) as DbRow[]
  return rows.map(rowToResearchSource)
}

export function getResearchSource(id: string): ResearchSource | null {
  const row = getDb().prepare('SELECT * FROM research_sources WHERE id = ?').get(id) as DbRow | undefined
  return row ? rowToResearchSource(row) : null
}

export function markResearchSourceVerified(id: string, verified = true): ResearchSource | null {
  getDb().prepare('UPDATE research_sources SET verified = ? WHERE id = ?').run(verified ? 1 : 0, id)
  const row = getDb().prepare('SELECT * FROM research_sources WHERE id = ?').get(id) as DbRow | undefined
  return row ? rowToResearchSource(row) : null
}

export function refreshResearchSourceCount(jobId: string): number {
  const row = getDb().prepare(
    'SELECT COUNT(*) AS count FROM research_sources WHERE job_id = ?'
  ).get(jobId) as { count: number }
  getDb().prepare(
    'UPDATE research_jobs SET source_count = ?, updated_at = ? WHERE id = ?'
  ).run(row.count, Date.now(), jobId)
  return row.count
}
