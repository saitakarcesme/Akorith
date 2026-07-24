import { randomUUID } from 'crypto'
import { getDb } from '../../db'
import { numberValue, optionalNumber, optionalString, type DbRow } from './rows'

export const RESEARCH_DISCORD_DELIVERY_STATUSES = [
  'pending',
  'sending',
  'retrying',
  'delivered',
  'failed',
  'needs_review'
] as const

export type ResearchDiscordDeliveryStatus = (typeof RESEARCH_DISCORD_DELIVERY_STATUSES)[number]

export interface ResearchDiscordDelivery {
  id: string
  jobId: string
  artifactId: string
  status: ResearchDiscordDeliveryStatus
  attemptCount: number
  nextAttemptAt?: number
  discordMessageId?: string
  lastError?: string
  createdAt: number
  updatedAt: number
  deliveredAt?: number
}

export interface ResearchDiscordDeliveryCounts {
  pending: number
  delivered: number
  failed: number
  needsReview: number
}

export function enqueueResearchDiscordDelivery(jobId: string, artifactId: string): ResearchDiscordDelivery {
  const now = Date.now()
  getDb().prepare(
    `INSERT INTO research_discord_deliveries (
       id, job_id, artifact_id, status, attempt_count, next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT(artifact_id) DO NOTHING`
  ).run(randomUUID(), jobId, artifactId, now, now, now)
  return getResearchDiscordDeliveryByArtifact(artifactId)!
}

export function getResearchDiscordDelivery(id: string): ResearchDiscordDelivery | null {
  const row = getDb().prepare('SELECT * FROM research_discord_deliveries WHERE id = ?').get(id) as DbRow | undefined
  return row ? rowToResearchDiscordDelivery(row) : null
}

export function getResearchDiscordDeliveryByArtifact(artifactId: string): ResearchDiscordDelivery | null {
  const row = getDb().prepare(
    'SELECT * FROM research_discord_deliveries WHERE artifact_id = ?'
  ).get(artifactId) as DbRow | undefined
  return row ? rowToResearchDiscordDelivery(row) : null
}

export function listResearchDiscordDeliveries(jobId: string, limit = 100): ResearchDiscordDelivery[] {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500)
  const rows = getDb().prepare(
    `SELECT * FROM research_discord_deliveries
      WHERE job_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(jobId, bounded) as DbRow[]
  return rows.map(rowToResearchDiscordDelivery)
}

export function listDueResearchDiscordDeliveries(now = Date.now(), limit = 10): ResearchDiscordDelivery[] {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 50)
  const rows = getDb().prepare(
    `SELECT * FROM research_discord_deliveries
      WHERE status IN ('pending', 'retrying')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY COALESCE(next_attempt_at, created_at), created_at
      LIMIT ?`
  ).all(now, bounded) as DbRow[]
  return rows.map(rowToResearchDiscordDelivery)
}

export function claimResearchDiscordDelivery(id: string, now = Date.now()): ResearchDiscordDelivery | null {
  const changed = getDb().prepare(
    `UPDATE research_discord_deliveries
        SET status = 'sending', attempt_count = attempt_count + 1,
            next_attempt_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'retrying')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`
  ).run(now, id, now)
  return changed.changes === 1 ? getResearchDiscordDelivery(id) : null
}

export function markResearchDiscordDeliveryDelivered(
  id: string,
  discordMessageId: string | undefined,
  now = Date.now()
): ResearchDiscordDelivery | null {
  getDb().prepare(
    `UPDATE research_discord_deliveries
        SET status = 'delivered', discord_message_id = ?, last_error = NULL,
            next_attempt_at = NULL, delivered_at = ?, updated_at = ?
      WHERE id = ? AND status = 'sending'`
  ).run(discordMessageId ?? null, now, now, id)
  return getResearchDiscordDelivery(id)
}

export function markResearchDiscordDeliveryRetry(
  id: string,
  error: string,
  nextAttemptAt: number,
  now = Date.now()
): ResearchDiscordDelivery | null {
  getDb().prepare(
    `UPDATE research_discord_deliveries
        SET status = 'retrying', last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND status = 'sending'`
  ).run(error, nextAttemptAt, now, id)
  return getResearchDiscordDelivery(id)
}

export function markResearchDiscordDeliveryFailed(
  id: string,
  error: string,
  now = Date.now()
): ResearchDiscordDelivery | null {
  getDb().prepare(
    `UPDATE research_discord_deliveries
        SET status = 'failed', last_error = ?, next_attempt_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'sending'`
  ).run(error, now, id)
  return getResearchDiscordDelivery(id)
}

export function markResearchDiscordDeliveryNeedsReview(
  id: string,
  error: string,
  now = Date.now()
): ResearchDiscordDelivery | null {
  getDb().prepare(
    `UPDATE research_discord_deliveries
        SET status = 'needs_review', last_error = ?, next_attempt_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'sending'`
  ).run(error, now, id)
  return getResearchDiscordDelivery(id)
}

/** A request that was in-flight at process exit may already exist in Discord.
 * Do not blindly retry it and create a duplicate; expose it for explicit user
 * review/retry instead. */
export function recoverInterruptedResearchDiscordDeliveries(now = Date.now()): number {
  const changed = getDb().prepare(
    `UPDATE research_discord_deliveries
        SET status = 'needs_review', next_attempt_at = NULL, updated_at = ?,
            last_error = COALESCE(last_error,
              'Akorith closed while Discord delivery was in flight. Check the channel before retrying.')
      WHERE status = 'sending'`
  ).run(now)
  return changed.changes
}

export function retryResearchDiscordDelivery(id: string, now = Date.now()): ResearchDiscordDelivery | null {
  const changed = getDb().prepare(
    `UPDATE research_discord_deliveries
        SET status = 'pending', next_attempt_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'retrying', 'failed', 'needs_review')`
  ).run(now, now, id)
  return changed.changes === 1 ? getResearchDiscordDelivery(id) : null
}

export function researchDiscordDeliveryCounts(): ResearchDiscordDeliveryCounts {
  const rows = getDb().prepare(
    `SELECT status, COUNT(*) AS count
       FROM research_discord_deliveries GROUP BY status`
  ).all() as Array<{ status: string; count: number }>
  const counts = new Map(rows.map((row) => [row.status, Number(row.count) || 0]))
  return {
    pending: (counts.get('pending') ?? 0) + (counts.get('retrying') ?? 0) + (counts.get('sending') ?? 0),
    delivered: counts.get('delivered') ?? 0,
    failed: counts.get('failed') ?? 0,
    needsReview: counts.get('needs_review') ?? 0
  }
}

function rowToResearchDiscordDelivery(row: DbRow): ResearchDiscordDelivery {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    artifactId: String(row.artifact_id),
    status: String(row.status) as ResearchDiscordDeliveryStatus,
    attemptCount: numberValue(row.attempt_count),
    nextAttemptAt: optionalNumber(row.next_attempt_at),
    discordMessageId: optionalString(row.discord_message_id),
    lastError: optionalString(row.last_error),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    deliveredAt: optionalNumber(row.delivered_at)
  }
}
