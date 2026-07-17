import { getDb } from '../../db'
import type { ResearchJob } from '../types'
import { rowToResearchJob, type DbRow } from './rows'

const DEFAULT_LEASE_MS = 5 * 60_000

export function acquireResearchLease(jobId: string, owner: string, leaseMs = DEFAULT_LEASE_MS): boolean {
  const now = Date.now()
  const result = getDb().prepare(
    `UPDATE research_jobs
     SET lease_owner = @owner,
         lease_expires_at = @expires,
         heartbeat_at = @now,
         revision = revision + 1,
         updated_at = @now
     WHERE id = @id
       AND (lease_expires_at IS NULL OR lease_expires_at < @now OR lease_owner = @owner)
       AND status NOT IN ('completed', 'archived', 'paused')
       AND cancel_requested_at IS NULL`
  ).run({ id: jobId, owner, expires: now + Math.max(30_000, leaseMs), now })
  return result.changes === 1
}

export function heartbeatResearchLease(jobId: string, owner: string, leaseMs = DEFAULT_LEASE_MS): boolean {
  const now = Date.now()
  const result = getDb().prepare(
    `UPDATE research_jobs
     SET heartbeat_at = @now, lease_expires_at = @expires, updated_at = @now
     WHERE id = @id AND lease_owner = @owner AND cancel_requested_at IS NULL`
  ).run({ id: jobId, owner, now, expires: now + Math.max(30_000, leaseMs) })
  return result.changes === 1
}

export function releaseResearchLease(jobId: string, owner: string): void {
  getDb().prepare(
    `UPDATE research_jobs
     SET lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = @now
     WHERE id = @id AND lease_owner = @owner`
  ).run({ id: jobId, owner, now: Date.now() })
}

export function requestResearchCancellation(jobId: string): boolean {
  return getDb().prepare(
    `UPDATE research_jobs SET cancel_requested_at = @now, next_run_at = NULL, updated_at = @now
     WHERE id = @id AND status NOT IN ('completed', 'archived')`
  ).run({ id: jobId, now: Date.now() }).changes === 1
}

export function clearResearchCancellation(jobId: string): void {
  getDb().prepare(
    'UPDATE research_jobs SET cancel_requested_at = NULL, updated_at = ? WHERE id = ?'
  ).run(Date.now(), jobId)
}

export function researchCancellationRequested(jobId: string): boolean {
  const row = getDb().prepare('SELECT cancel_requested_at FROM research_jobs WHERE id = ?').get(jobId) as
    | { cancel_requested_at: number | null }
    | undefined
  return row?.cancel_requested_at != null
}

export function listDueResearchJobs(now = Date.now(), limit = 8): ResearchJob[] {
  const rows = getDb().prepare(
    `SELECT * FROM research_jobs
     WHERE status IN ('planning', 'researching', 'verifying', 'synthesizing', 'exporting', 'error')
       AND cancel_requested_at IS NULL
       AND (next_run_at IS NULL OR next_run_at <= @now)
       AND (lease_expires_at IS NULL OR lease_expires_at < @now)
     ORDER BY COALESCE(next_run_at, created_at) ASC
     LIMIT @limit`
  ).all({ now, limit: Math.min(Math.max(limit, 1), 32) }) as DbRow[]
  return rows.map(rowToResearchJob)
}

export function releaseExpiredResearchLeases(now = Date.now()): number {
  return getDb().prepare(
    `UPDATE research_jobs
     SET lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
         next_run_at = @now, updated_at = @now
     WHERE lease_expires_at IS NOT NULL AND lease_expires_at < @now
       AND status NOT IN ('completed', 'paused', 'archived')`
  ).run({ now }).changes
}
