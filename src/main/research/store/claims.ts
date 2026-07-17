import { randomUUID } from 'crypto'
import { getDb } from '../../db'
import type {
  ResearchClaim,
  ResearchClaimEvidence,
  ResearchClaimStatus,
  ResearchEvidenceRelation
} from '../types'
import { numberValue, optionalString, type DbRow } from './rows'

function rowToClaim(row: DbRow, evidence: ResearchClaimEvidence[] = []): ResearchClaim {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    cycleId: optionalString(row.cycle_id),
    sectionId: optionalString(row.section_id),
    text: String(row.text),
    confidenceScore: numberValue(row.confidence_score),
    status: String(row.status) as ResearchClaimStatus,
    evidence,
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at)
  }
}

export function recordResearchClaim(input: {
  jobId: string
  cycleId?: string
  sectionId?: string
  text: string
  confidenceScore?: number
  status?: ResearchClaimStatus
}): ResearchClaim {
  const now = Date.now()
  const id = randomUUID()
  const text = input.text.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, 20_000)
  if (!text) throw new Error('Research claim cannot be empty.')
  getDb().prepare(
    `INSERT INTO research_claims (
      id, job_id, cycle_id, section_id, text, confidence_score, status, created_at, updated_at
    ) VALUES (
      @id, @job_id, @cycle_id, @section_id, @text, @confidence_score, @status, @created_at, @updated_at
    )`
  ).run({
    id,
    job_id: input.jobId,
    cycle_id: input.cycleId ?? null,
    section_id: input.sectionId ?? null,
    text,
    confidence_score: Math.max(0, Math.min(1, input.confidenceScore ?? 0.5)),
    status: input.status ?? 'unverified',
    created_at: now,
    updated_at: now
  })
  refreshResearchFindingCount(input.jobId)
  return getResearchClaim(id)!
}

export function linkResearchClaimSource(input: {
  claimId: string
  sourceId: string
  evidence?: string
  relation?: ResearchEvidenceRelation
}): void {
  getDb().prepare(
    `INSERT INTO research_claim_sources (claim_id, source_id, evidence, relation, created_at)
     VALUES (@claim_id, @source_id, @evidence, @relation, @created_at)
     ON CONFLICT(claim_id, source_id, relation) DO UPDATE SET evidence = excluded.evidence`
  ).run({
    claim_id: input.claimId,
    source_id: input.sourceId,
    evidence: input.evidence?.replace(/\u0000/g, '').trim().slice(0, 8_000) ?? null,
    relation: input.relation ?? 'supports',
    created_at: Date.now()
  })
  refreshClaimStatus(input.claimId)
}

export function getResearchClaim(id: string): ResearchClaim | null {
  const row = getDb().prepare('SELECT * FROM research_claims WHERE id = ?').get(id) as DbRow | undefined
  if (!row) return null
  return rowToClaim(row, claimEvidence(id))
}

export function listResearchClaims(jobId: string): ResearchClaim[] {
  const rows = getDb().prepare(
    'SELECT * FROM research_claims WHERE job_id = ? ORDER BY created_at ASC'
  ).all(jobId) as DbRow[]
  return rows.map((row) => rowToClaim(row, claimEvidence(String(row.id))))
}

export function researchClaimCoverage(jobId: string): {
  total: number
  verified: number
  conflicted: number
  unsupported: number
  coverage: number
} {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN status = 'conflicted' THEN 1 ELSE 0 END) AS conflicted,
      SUM(CASE WHEN status = 'unsupported' THEN 1 ELSE 0 END) AS unsupported
     FROM research_claims WHERE job_id = ?`
  ).get(jobId) as DbRow
  const total = numberValue(row.total)
  const verified = numberValue(row.verified)
  return {
    total,
    verified,
    conflicted: numberValue(row.conflicted),
    unsupported: numberValue(row.unsupported),
    coverage: total === 0 ? 0 : verified / total
  }
}

function claimEvidence(claimId: string): ResearchClaimEvidence[] {
  const rows = getDb().prepare(
    'SELECT source_id, evidence, relation FROM research_claim_sources WHERE claim_id = ? ORDER BY created_at ASC'
  ).all(claimId) as DbRow[]
  return rows.map((row) => ({
    sourceId: String(row.source_id),
    evidence: optionalString(row.evidence),
    relation: String(row.relation) as ResearchEvidenceRelation
  }))
}

function refreshClaimStatus(claimId: string): void {
  const rows = getDb().prepare(
    'SELECT relation FROM research_claim_sources WHERE claim_id = ?'
  ).all(claimId) as { relation: ResearchEvidenceRelation }[]
  const supports = rows.some((row) => row.relation === 'supports')
  const contradicts = rows.some((row) => row.relation === 'contradicts')
  const status: ResearchClaimStatus = supports && contradicts
    ? 'conflicted'
    : supports
      ? 'verified'
      : 'unsupported'
  getDb().prepare('UPDATE research_claims SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), claimId)
}

function refreshResearchFindingCount(jobId: string): void {
  const row = getDb().prepare('SELECT COUNT(*) AS count FROM research_claims WHERE job_id = ?')
    .get(jobId) as { count: number }
  getDb().prepare('UPDATE research_jobs SET finding_count = ?, updated_at = ? WHERE id = ?')
    .run(row.count, Date.now(), jobId)
}
