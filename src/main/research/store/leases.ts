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
         started_at = COALESCE(started_at, @now),
         active_accounted_at = @now,
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

export function releaseResearchLease(jobId: string, owner: string, now = Date.now()): void {
  getDb().prepare(
    `UPDATE research_jobs
     SET active_elapsed_ms = active_elapsed_ms + CASE
           WHEN active_accounted_at IS NULL THEN 0
           ELSE MIN(15000, MAX(0, @now - active_accounted_at))
         END,
         active_accounted_at = NULL,
         lease_owner = NULL,
         lease_expires_at = NULL,
         heartbeat_at = NULL,
         updated_at = @now
     WHERE id = @id AND lease_owner = @owner`
  ).run({ id: jobId, owner, now })
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
         active_accounted_at = NULL, next_run_at = @now, updated_at = @now
     WHERE lease_expires_at IS NOT NULL AND lease_expires_at < @now
       AND status NOT IN ('completed', 'paused', 'archived')`
  ).run({ now }).changes
}

/**
 * Persist active scheduler time in short checkpoints. Because elapsed time is
 * accumulated while the app is alive, a closed app, a crash, or a machine
 * sleep cannot consume a one-hour/twelve-hour research promise.
 */
export function checkpointResearchActiveClocks(now = Date.now()): number {
  return getDb().prepare(
    `UPDATE research_jobs
     SET active_elapsed_ms = active_elapsed_ms + MIN(15000, MAX(0, @now - active_accounted_at)),
         active_accounted_at = @now
     WHERE active_accounted_at IS NOT NULL
       AND status IN ('planning', 'researching', 'verifying', 'synthesizing', 'exporting')`
  ).run({ now }).changes
}

/** Discard stale pre-shutdown anchors; the next lease/direct run starts a fresh segment. */
export function resumeResearchActiveClocks(): number {
  return getDb().prepare(
    `UPDATE research_jobs
     SET active_accounted_at = NULL
     WHERE active_accounted_at IS NOT NULL`
  ).run().changes
}

/** Freeze all clocks before the scheduler stops. */
export function freezeResearchActiveClocks(now = Date.now()): number {
  return getDb().prepare(
    `UPDATE research_jobs
     SET active_elapsed_ms = active_elapsed_ms + CASE
           WHEN active_accounted_at IS NULL THEN 0
           ELSE MIN(15000, MAX(0, @now - active_accounted_at))
         END,
         active_accounted_at = NULL
     WHERE active_accounted_at IS NOT NULL`
  ).run({ now }).changes
}

/** Start/restart one clock for direct runner calls and leased retries. */
export function startResearchActiveClock(jobId: string, now = Date.now()): boolean {
  return getDb().prepare(
    `UPDATE research_jobs
     SET started_at = COALESCE(started_at, @now),
         active_accounted_at = @now,
         updated_at = @now
     WHERE id = @id
       AND status IN ('planning', 'researching', 'verifying', 'synthesizing', 'exporting', 'error')`
  ).run({ id: jobId, now }).changes === 1
}
