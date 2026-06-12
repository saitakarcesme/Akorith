// SQLite persistence — main process only. The renderer reaches this
// exclusively through the validated IPC registered below.
//
// usage_events is a CONTRACT: the dashboard reads it, and
// TODO(phase 6): the router reads usage_events to pick providers by
//                cost/volume. One row per assistant send, from SendResult.usage.

import { app, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import Database from 'better-sqlite3'

let db: Database.Database | null = null

const VALID_ID = /^[\w-]{1,64}$/
const MAX_TITLE = 200

export function dbPath(): string {
  // Co-located with loopex.config.json in userData.
  return join(app.getPath('userData'), 'loopex.db')
}

export function initDb(): void {
  db = new Database(dbPath())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      title       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content     TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model       TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    CREATE TABLE IF NOT EXISTS usage_events (
      id                TEXT PRIMARY KEY,
      ts                INTEGER NOT NULL,
      provider_id       TEXT NOT NULL,
      model             TEXT,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      cost_usd          REAL,
      estimated         INTEGER NOT NULL DEFAULT 0,
      session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_events(provider_id, ts);
  `)
}

export function closeDb(): void {
  db?.close()
  db = null
}

function must(): Database.Database {
  if (!db) throw new Error('database not initialized')
  return db
}

// ---- session / message CRUD (also used by the chat:send handler) ----

export interface SessionRow {
  id: string
  providerId: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface MessageRow {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  providerId: string
  model: string | null
  createdAt: number
}

const toSession = (r: Record<string, unknown>): SessionRow => ({
  id: r.id as string,
  providerId: r.provider_id as string,
  title: r.title as string,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number
})

export function createSession(providerId: string, title: string): SessionRow {
  const now = Date.now()
  const row: SessionRow = { id: randomUUID(), providerId, title, createdAt: now, updatedAt: now }
  must()
    .prepare('INSERT INTO sessions (id, provider_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(row.id, row.providerId, row.title, row.createdAt, row.updatedAt)
  return row
}

export function sessionExists(sessionId: string): boolean {
  return Boolean(must().prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId))
}

export function addMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  providerId: string,
  model?: string
): void {
  const now = Date.now()
  const d = must()
  d.prepare(
    'INSERT INTO messages (id, session_id, role, content, provider_id, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), sessionId, role, content, providerId, model ?? null, now)
  d.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
}

export interface UsageEventInput {
  providerId: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  costUsd?: number
  estimated: boolean
  sessionId?: string
}

/** One row per assistant send — the SendResult.usage contract lands here. */
export function recordUsageEvent(input: UsageEventInput): void {
  must()
    .prepare(
      `INSERT INTO usage_events (id, ts, provider_id, model, prompt_tokens, completion_tokens, cost_usd, estimated, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      Date.now(),
      input.providerId,
      input.model ?? null,
      input.promptTokens ?? null,
      input.completionTokens ?? null,
      input.costUsd ?? null,
      input.estimated ? 1 : 0,
      input.sessionId ?? null
    )
}

// ---- aggregations for the dashboard (and TODO(phase 6): the router) ----

export interface ProviderUsageSummary {
  providerId: string
  events: number
  promptTokens: number
  completionTokens: number
  costUsd: number
  estimated: boolean
}

export interface UsageSummary {
  totalTokens: number
  totalCostUsd: number
  sessionCount: number
  byProvider: ProviderUsageSummary[]
}

export function usageSummary(): UsageSummary {
  const d = must()
  const byProvider = (
    d
      .prepare(
        `SELECT provider_id,
                COUNT(*) AS events,
                SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
                SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
                SUM(COALESCE(cost_usd, 0)) AS cost_usd,
                MAX(estimated) AS estimated
         FROM usage_events
         GROUP BY provider_id
         ORDER BY prompt_tokens + completion_tokens DESC`
      )
      .all() as Record<string, number | string>[]
  ).map((r) => ({
    providerId: r.provider_id as string,
    events: r.events as number,
    promptTokens: (r.prompt_tokens as number) ?? 0,
    completionTokens: (r.completion_tokens as number) ?? 0,
    costUsd: (r.cost_usd as number) ?? 0,
    estimated: r.estimated === 1
  }))
  const sessionCount = (d.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c
  return {
    totalTokens: byProvider.reduce((s, p) => s + p.promptTokens + p.completionTokens, 0),
    totalCostUsd: byProvider.reduce((s, p) => s + p.costUsd, 0),
    sessionCount,
    byProvider
  }
}

export interface RecentProviderUsage {
  events: number
  tokens: number
  costUsd: number
}

/**
 * Per-provider usage recorded since `sinceMs` (Phase 6 router limit-warnings).
 * Based purely on what Loopex itself logged — NOT any official plan limit.
 */
export function recentUsageByProvider(sinceMs: number): Record<string, RecentProviderUsage> {
  const rows = must()
    .prepare(
      `SELECT provider_id,
              COUNT(*) AS events,
              SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)) AS tokens,
              SUM(COALESCE(cost_usd, 0)) AS cost_usd
       FROM usage_events
       WHERE ts >= ?
       GROUP BY provider_id`
    )
    .all(sinceMs) as Record<string, number | string>[]
  const out: Record<string, RecentProviderUsage> = {}
  for (const r of rows) {
    out[r.provider_id as string] = {
      events: (r.events as number) ?? 0,
      tokens: (r.tokens as number) ?? 0,
      costUsd: (r.cost_usd as number) ?? 0
    }
  }
  return out
}

export interface DailyUsageRow {
  day: string // YYYY-MM-DD, local time
  providerId: string
  events: number
  tokens: number
  estimated: boolean
}

export function usageDaily(days: number): DailyUsageRow[] {
  const since = Date.now() - days * 86_400_000
  return (
    must()
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
                provider_id,
                COUNT(*) AS events,
                SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)) AS tokens,
                MAX(estimated) AS estimated
         FROM usage_events
         WHERE ts >= ?
         GROUP BY day, provider_id
         ORDER BY day`
      )
      .all(since) as Record<string, number | string>[]
  ).map((r) => ({
    day: r.day as string,
    providerId: r.provider_id as string,
    events: r.events as number,
    tokens: (r.tokens as number) ?? 0,
    estimated: r.estimated === 1
  }))
}

// ---- IPC ----

export function registerDbIpc(): void {
  ipcMain.handle('history:list', (): SessionRow[] =>
    (must().prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as Record<string, unknown>[]).map(
      toSession
    )
  )

  ipcMain.handle('history:messages', (_event, args: { sessionId: string }) => {
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) return null
    const session = must().prepare('SELECT * FROM sessions WHERE id = ?').get(args.sessionId) as
      | Record<string, unknown>
      | undefined
    if (!session) return null
    const messages = (
      must()
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid')
        .all(args.sessionId) as Record<string, unknown>[]
    ).map(
      (r): MessageRow => ({
        id: r.id as string,
        sessionId: r.session_id as string,
        role: r.role as 'user' | 'assistant',
        content: r.content as string,
        providerId: r.provider_id as string,
        model: (r.model as string | null) ?? null,
        createdAt: r.created_at as number
      })
    )
    return { session: toSession(session), messages }
  })

  ipcMain.handle('history:create', (_event, args: { providerId: string; title: string }) => {
    if (
      typeof args?.providerId !== 'string' ||
      !/^[a-z0-9-]{1,32}$/.test(args.providerId) ||
      typeof args.title !== 'string'
    ) {
      throw new Error('invalid history:create payload')
    }
    return createSession(args.providerId, args.title.slice(0, MAX_TITLE) || 'New chat')
  })

  ipcMain.handle('history:rename', (_event, args: { sessionId: string; title: string }) => {
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId) || typeof args.title !== 'string') {
      return false
    }
    const title = args.title.slice(0, MAX_TITLE).trim()
    if (!title) return false
    must().prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), args.sessionId)
    return true
  })

  ipcMain.handle('history:delete', (_event, args: { sessionId: string }) => {
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) return false
    must().prepare('DELETE FROM sessions WHERE id = ?').run(args.sessionId) // messages cascade
    return true
  })

  ipcMain.handle('usage:summary', () => usageSummary())

  ipcMain.handle('usage:daily', (_event, args: { days: number }) => {
    const days = typeof args?.days === 'number' && Number.isFinite(args.days) ? Math.min(Math.max(args.days, 1), 730) : 270
    return usageDaily(days)
  })
}
