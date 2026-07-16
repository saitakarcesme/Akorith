// SQLite persistence — main process only. The renderer reaches this
// exclusively through the validated IPC registered below.
//
// usage_events is a CONTRACT: the dashboard reads it, and
// TODO(phase 6): the router reads usage_events to pick providers by
//                cost/volume. One row per assistant send, from SendResult.usage.

import { app, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'crypto'
import { createRequire } from 'module'
import { basename, isAbsolute, join, resolve, sep } from 'path'
import { mkdirSync, statSync } from 'fs'
import type Database from 'better-sqlite3'
import type { MacroExecutorType, MacroMode, MacroStatus } from './loops/types'
import { publicChatAttachments, removeSessionAttachments } from './chat-attachments'

let db: Database.Database | null = null
let dbInitPromise: Promise<void> | null = null
const require = createRequire(__filename)

const VALID_ID = /^[\w-]{1,64}$/
const MAX_TITLE = 200
const MAX_PROJECT_NAME = 120
const MAX_PROJECT_PATH = 2_000
const MAX_PROJECT_META = 48
const SAFE_PROJECT_DIR_NAME = /^[^/\\:*?"<>|\0\r\n]{1,120}$/

interface StoredGeneratedFile {
  path: string
  content: string
}

export function dbPath(): string {
  // Co-located with loopex.config.json in userData.
  return join(app.getPath('userData'), 'loopex.db')
}

export function initDb(): void {
  if (db) return
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const nextDb = new Database(dbPath())
  db = nextDb
  try {
    nextDb.pragma('journal_mode = WAL')
    nextDb.pragma('foreign_keys = ON')
    nextDb.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT,
      color       TEXT,
      icon        TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at);
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      title       TEXT NOT NULL,
      project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
      pinned      INTEGER NOT NULL DEFAULT 0,
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
      attachments TEXT,
      metadata    TEXT,
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
    CREATE TABLE IF NOT EXISTS test_runs (
      id           TEXT PRIMARY KEY,
      ts           INTEGER NOT NULL,
      source_repo  TEXT NOT NULL,
      target_desc  TEXT,
      provider_id  TEXT,
      model        TEXT,
      framework    TEXT,
      passed       INTEGER,
      failed       INTEGER,
      errored      INTEGER,
      duration_ms  INTEGER,
      exit_code    INTEGER,
      tokens       INTEGER,
      attempts     INTEGER,
      sandbox_path TEXT,
      generated_files TEXT,
      raw_output   TEXT,
      status       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_test_runs_ts ON test_runs(ts);
    CREATE TABLE IF NOT EXISTS evaluations (
      id               TEXT PRIMARY KEY,
      ts               INTEGER NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('single', 'comparison')),
      test_run_ids     TEXT NOT NULL,
      judge_model      TEXT,
      dimension_scores TEXT NOT NULL,
      weights          TEXT NOT NULL,
      total_score      REAL NOT NULL,
      rationale        TEXT,
      pdf_path         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_evaluations_ts ON evaluations(ts);
    CREATE TABLE IF NOT EXISTS benchmark_entries (
      id               TEXT PRIMARY KEY,
      signature        TEXT NOT NULL UNIQUE,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      challenge_id     TEXT NOT NULL,
      challenge_label  TEXT NOT NULL,
      category         TEXT NOT NULL,
      metric           TEXT NOT NULL,
      model            TEXT NOT NULL,
      provider_id      TEXT,
      score            INTEGER,
      rank             INTEGER,
      status           TEXT,
      duration_ms      INTEGER,
      tokens           INTEGER,
      run_id           TEXT,
      source           TEXT,
      summary          TEXT,
      prompt           TEXT,
      artifact_preview TEXT,
      artifact_path    TEXT,
      media_type       TEXT,
      media_url        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_entries_updated ON benchmark_entries(updated_at);
    CREATE INDEX IF NOT EXISTS idx_benchmark_entries_category ON benchmark_entries(category, updated_at);
    CREATE TABLE IF NOT EXISTS macro_sessions (
      id                    TEXT PRIMARY KEY,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      status                TEXT NOT NULL,
      goal                  TEXT NOT NULL,
      planner_provider      TEXT NOT NULL,
      planner_model         TEXT,
      target_terminal       TEXT NOT NULL,
      max_iterations        INTEGER NOT NULL,
      good_enough_threshold INTEGER NOT NULL,
      include_repo_digest   INTEGER NOT NULL DEFAULT 0,
      repo_digest_snapshot  TEXT,
      final_score           REAL,
      stop_reason           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_macro_sessions_updated ON macro_sessions(updated_at);
    CREATE TABLE IF NOT EXISTS macro_turns (
      id                      TEXT PRIMARY KEY,
      session_id              TEXT NOT NULL REFERENCES macro_sessions(id) ON DELETE CASCADE,
      turn_index              INTEGER NOT NULL,
      created_at              INTEGER NOT NULL,
      status                  TEXT NOT NULL,
      proposal                TEXT,
      edited_proposal         TEXT,
      sent_prompt             TEXT,
      executor_result_summary TEXT,
      planner_rationale       TEXT,
      expected_result         TEXT,
      confidence_score        REAL,
      good_enough_score       REAL,
      risk_level              TEXT,
      provider_used           TEXT,
      model_used              TEXT,
      error                   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_macro_turns_session ON macro_turns(session_id, turn_index);
    CREATE TABLE IF NOT EXISTS loop_targets (
      id          TEXT PRIMARY KEY,
      loop_id     TEXT NOT NULL REFERENCES macro_sessions(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      ref         TEXT,
      label       TEXT,
      metadata    TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loop_targets_loop ON loop_targets(loop_id);
    CREATE TABLE IF NOT EXISTS loop_runs (
      id                 TEXT PRIMARY KEY,
      loop_id            TEXT NOT NULL REFERENCES macro_sessions(id) ON DELETE CASCADE,
      run_index          INTEGER NOT NULL,
      started_at         INTEGER NOT NULL,
      ended_at           INTEGER,
      status             TEXT NOT NULL,
      provider_id        TEXT,
      model              TEXT,
      summary            TEXT,
      actions_taken      TEXT,
      files_changed      TEXT,
      commands_executed  TEXT,
      test_build_results TEXT,
      commits_created    TEXT,
      next_suggested_step TEXT,
      error              TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_loop_runs_loop ON loop_runs(loop_id, run_index);
    CREATE TABLE IF NOT EXISTS loop_events (
      id          TEXT PRIMARY KEY,
      loop_id     TEXT NOT NULL REFERENCES macro_sessions(id) ON DELETE CASCADE,
      run_id      TEXT REFERENCES loop_runs(id) ON DELETE SET NULL,
      ts          INTEGER NOT NULL,
      type        TEXT NOT NULL,
      message     TEXT NOT NULL,
      severity    TEXT NOT NULL DEFAULT 'info',
      metadata    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_loop_events_loop ON loop_events(loop_id, ts);
    CREATE TABLE IF NOT EXISTS loop_templates (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      description TEXT,
      prompt      TEXT NOT NULL,
      settings    TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_artifacts (
      id          TEXT PRIMARY KEY,
      loop_id     TEXT NOT NULL REFERENCES macro_sessions(id) ON DELETE CASCADE,
      run_id      TEXT REFERENCES loop_runs(id) ON DELETE SET NULL,
      kind        TEXT NOT NULL,
      path        TEXT,
      title       TEXT,
      content     TEXT,
      metadata    TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loop_artifacts_loop ON loop_artifacts(loop_id, created_at);
    CREATE TABLE IF NOT EXISTS loop_reports (
      id          TEXT PRIMARY KEY,
      loop_id     TEXT NOT NULL REFERENCES macro_sessions(id) ON DELETE CASCADE,
      run_id      TEXT REFERENCES loop_runs(id) ON DELETE SET NULL,
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      summary     TEXT,
      content     TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loop_reports_loop ON loop_reports(loop_id, created_at);

    -- Phase 48: project-focused Loop (new, additive; old macro/loop tables remain).
    CREATE TABLE IF NOT EXISTS project_loops (
      id                   TEXT PRIMARY KEY,
      title                TEXT NOT NULL,
      mode                 TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'active',
      local_path           TEXT NOT NULL,
      repo_url             TEXT,
      github_owner         TEXT,
      github_name          TEXT,
      idea                 TEXT,
      autonomy             TEXT NOT NULL DEFAULT 'assisted',
      safety               TEXT NOT NULL DEFAULT 'standard',
      schedule_kind        TEXT NOT NULL DEFAULT 'manual',
      schedule_minutes     INTEGER NOT NULL DEFAULT 0,
      daily_commit_target  INTEGER NOT NULL DEFAULT 1,
      min_commits_per_run  INTEGER NOT NULL DEFAULT 0,
      max_commits_per_run  INTEGER NOT NULL DEFAULT 1,
      local_model_provider TEXT NOT NULL DEFAULT 'local',
      local_model          TEXT,
      push_enabled         INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      last_run_at          INTEGER,
      next_run_at          INTEGER,
      run_count            INTEGER NOT NULL DEFAULT 0,
      commit_count         INTEGER NOT NULL DEFAULT 0,
      error                TEXT,
      memory_summary       TEXT,
      roadmap_summary      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_project_loops_status ON project_loops(status, updated_at);

    CREATE TABLE IF NOT EXISTS project_loop_runs (
      id                TEXT PRIMARY KEY,
      loop_id           TEXT NOT NULL REFERENCES project_loops(id) ON DELETE CASCADE,
      run_index         INTEGER NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      started_at        INTEGER NOT NULL,
      ended_at          INTEGER,
      model             TEXT,
      objective         TEXT,
      summary           TEXT,
      files_changed     INTEGER NOT NULL DEFAULT 0,
      commands_run      INTEGER NOT NULL DEFAULT 0,
      tests_run         INTEGER NOT NULL DEFAULT 0,
      commits_created   INTEGER NOT NULL DEFAULT 0,
      validation_result TEXT,
      next_step         TEXT,
      error             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_project_loop_runs_loop ON project_loop_runs(loop_id, run_index);

    CREATE TABLE IF NOT EXISTS project_loop_events (
      id         TEXT PRIMARY KEY,
      loop_id    TEXT NOT NULL REFERENCES project_loops(id) ON DELETE CASCADE,
      run_id     TEXT REFERENCES project_loop_runs(id) ON DELETE SET NULL,
      kind       TEXT NOT NULL,
      message    TEXT NOT NULL,
      detail     TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_loop_events_loop ON project_loop_events(loop_id, created_at);

    CREATE TABLE IF NOT EXISTS project_loop_commits (
      id                 TEXT PRIMARY KEY,
      loop_id            TEXT NOT NULL REFERENCES project_loops(id) ON DELETE CASCADE,
      run_id             TEXT REFERENCES project_loop_runs(id) ON DELETE SET NULL,
      sha                TEXT NOT NULL,
      message            TEXT NOT NULL,
      files_changed      INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL,
      validation_summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_project_loop_commits_loop ON project_loop_commits(loop_id, created_at);

    CREATE TABLE IF NOT EXISTS project_loop_backlog_items (
      id         TEXT PRIMARY KEY,
      loop_id    TEXT NOT NULL REFERENCES project_loops(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      detail     TEXT,
      category   TEXT,
      priority   INTEGER NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_loop_backlog_loop ON project_loop_backlog_items(loop_id, priority);

    CREATE TABLE IF NOT EXISTS project_loop_memories (
      id         TEXT PRIMARY KEY,
      loop_id    TEXT NOT NULL REFERENCES project_loops(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      content    TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_loop_memories_loop ON project_loop_memories(loop_id, importance);

    -- Phase 50: Companions — long-memory local personalities (no actions).
    CREATE TABLE IF NOT EXISTS companions (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      tagline    TEXT NOT NULL DEFAULT '',
      tags       TEXT NOT NULL DEFAULT '[]',
      builtin    INTEGER NOT NULL DEFAULT 0,
      model      TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS companion_sessions (
      id            TEXT PRIMARY KEY,
      companion_id  TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      title         TEXT NOT NULL DEFAULT 'New conversation',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_companion_sessions_c ON companion_sessions(companion_id, updated_at);
    CREATE TABLE IF NOT EXISTS companion_messages (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL REFERENCES companion_sessions(id) ON DELETE CASCADE,
      companion_id TEXT NOT NULL,
      role         TEXT NOT NULL,
      content      TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_companion_messages_s ON companion_messages(session_id, created_at);
    CREATE TABLE IF NOT EXISTS companion_memories (
      id               TEXT PRIMARY KEY,
      companion_id     TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      type             TEXT NOT NULL,
      title            TEXT NOT NULL,
      content          TEXT NOT NULL,
      importance       INTEGER NOT NULL DEFAULT 3,
      confidence       REAL NOT NULL DEFAULT 0.6,
      source_session_id TEXT,
      pinned           INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      last_used_at     INTEGER,
      archived_at      INTEGER,
      tags             TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_companion_memories_c ON companion_memories(companion_id, importance);
    CREATE TABLE IF NOT EXISTS companion_memory_events (
      id           TEXT PRIMARY KEY,
      companion_id TEXT NOT NULL,
      memory_id    TEXT,
      kind         TEXT NOT NULL,
      detail       TEXT,
      created_at   INTEGER NOT NULL
    );

    -- Phase 52: Agents — reusable local action shortcuts (permissioned).
    CREATE TABLE IF NOT EXISTS action_agents (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL,
      description          TEXT NOT NULL DEFAULT '',
      icon                 TEXT NOT NULL DEFAULT 'bolt',
      category             TEXT NOT NULL DEFAULT 'general',
      template_id          TEXT NOT NULL DEFAULT 'blank',
      local_model_provider TEXT NOT NULL DEFAULT 'local',
      local_model          TEXT,
      allowed_root         TEXT,
      permission_mode      TEXT NOT NULL DEFAULT 'preview',
      allow_commands       INTEGER NOT NULL DEFAULT 0,
      builtin              INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      last_run_at          INTEGER,
      run_count            INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS action_agent_runs (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL REFERENCES action_agents(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'planning',
      started_at    INTEGER NOT NULL,
      ended_at      INTEGER,
      input         TEXT,
      summary       TEXT,
      risk_level    TEXT,
      files_changed INTEGER NOT NULL DEFAULT 0,
      commands_run  INTEGER NOT NULL DEFAULT 0,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_action_agent_runs_a ON action_agent_runs(agent_id, started_at);
    CREATE TABLE IF NOT EXISTS action_agent_events (
      id         TEXT PRIMARY KEY,
      run_id     TEXT NOT NULL REFERENCES action_agent_runs(id) ON DELETE CASCADE,
      agent_id   TEXT NOT NULL,
      kind       TEXT NOT NULL,
      message    TEXT NOT NULL,
      detail     TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_action_agent_events_r ON action_agent_events(run_id, created_at);
    CREATE TABLE IF NOT EXISTS action_agent_artifacts (
      id         TEXT PRIMARY KEY,
      run_id     TEXT NOT NULL REFERENCES action_agent_runs(id) ON DELETE CASCADE,
      agent_id   TEXT NOT NULL,
      kind       TEXT NOT NULL,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
  ensureColumn('test_runs', 'generated_files', 'TEXT')
  ensureColumn('benchmark_entries', 'artifact_path', 'TEXT')
  ensureColumn('sessions', 'project_id', 'TEXT')
  ensureColumn('sessions', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('messages', 'attachments', 'TEXT')
  ensureColumn('messages', 'metadata', 'TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at);')
  // Phase 14.2 conversation memory: a cached summary of older (non-verbatim)
  // turns plus how many messages it covers, so we never re-summarize each send.
  ensureColumn('sessions', 'context_summary', 'TEXT')
  ensureColumn('sessions', 'context_summary_count', 'INTEGER NOT NULL DEFAULT 0')
  // Phase 11 agentic-loop audit columns (safe additive migrations).
  ensureColumn('macro_sessions', 'mode', "TEXT NOT NULL DEFAULT 'approval'")
  ensureColumn('macro_sessions', 'auto_actions', 'TEXT')
  ensureColumn('macro_sessions', 'pause_reason', 'TEXT')
  ensureColumn('macro_turns', 'summarizer_confidence', 'REAL')
  ensureColumn('macro_turns', 'permission_detection', 'TEXT')
  ensureColumn('macro_turns', 'terminal_snapshot_meta', 'TEXT')
  ensureColumn('macro_turns', 'auto_action', 'TEXT')
  ensureColumn('macro_turns', 'result_status', 'TEXT')
  // Phase 19 closed-loop critic columns (measured grade of the actual result).
  ensureColumn('macro_turns', 'critic_score', 'REAL')
  ensureColumn('macro_turns', 'critic_verdict', 'TEXT')
  ensureColumn('macro_turns', 'critic_review', 'TEXT')
  // Phase 20 autonomous workspace loop: per-session build dir, auto-commit flag,
  // and a metered meta-call token budget ("till the tokens are gone").
  ensureColumn('macro_sessions', 'workspace_dir', 'TEXT')
  ensureColumn('macro_sessions', 'auto_commit', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('macro_sessions', 'token_budget', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('macro_sessions', 'tokens_used', 'INTEGER NOT NULL DEFAULT 0')
  // Phase 21 Loop section: a plain-language label for the loop card.
  ensureColumn('macro_sessions', 'title', 'TEXT')
  // Phase 22 fully-automatic loop + steering: the user's chosen next direction
  // (consumed by the next plan) and the planner's 3 suggested directions per turn.
  ensureColumn('macro_sessions', 'pending_steering', 'TEXT')
  ensureColumn('macro_turns', 'next_options', 'TEXT')
  // Loop systems: remember the user's loop intent and optional cadence.
  ensureColumn('macro_sessions', 'loop_intent', 'TEXT')
  ensureColumn('macro_sessions', 'cadence_minutes', 'INTEGER NOT NULL DEFAULT 0')
  // Phase 23.2 Loop Operations Center: durable product-level metadata for
  // schedules, targets, autonomy/safety, reports, commit behavior, and archives.
  ensureColumn('macro_sessions', 'loop_type', 'TEXT')
  ensureColumn('macro_sessions', 'target_type', 'TEXT')
  ensureColumn('macro_sessions', 'target_ref', 'TEXT')
  ensureColumn('macro_sessions', 'schedule_kind', 'TEXT')
  ensureColumn('macro_sessions', 'schedule_detail', 'TEXT')
  ensureColumn('macro_sessions', 'next_run_at', 'INTEGER')
  ensureColumn('macro_sessions', 'stop_condition', 'TEXT')
  ensureColumn('macro_sessions', 'max_runs', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('macro_sessions', 'max_commits', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('macro_sessions', 'run_count', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('macro_sessions', 'commit_behavior', 'TEXT')
  ensureColumn('macro_sessions', 'push_enabled', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('macro_sessions', 'test_commands', 'TEXT')
  ensureColumn('macro_sessions', 'report_format', 'TEXT')
  ensureColumn('macro_sessions', 'safety_level', 'TEXT')
  ensureColumn('macro_sessions', 'latest_result', 'TEXT')
  ensureColumn('macro_sessions', 'archived_at', 'INTEGER')
  // Phase 27 Local Executor Loop: local/Ollama executors produce structured
  // patch attempts that Akorith validates before any commit.
  ensureColumn('macro_sessions', 'executor_type', "TEXT NOT NULL DEFAULT 'pty'")
  ensureColumn('macro_sessions', 'executor_provider', 'TEXT')
  ensureColumn('macro_sessions', 'executor_model', 'TEXT')
  ensureColumn('macro_sessions', 'last_attempt_status', 'TEXT')
  ensureColumn('macro_sessions', 'last_validation_result', 'TEXT')
  ensureColumn('macro_sessions', 'last_commit_message', 'TEXT')
  } catch (err) {
    nextDb.close()
    db = null
    throw err
  }
}

export function closeDb(): void {
  db?.close()
  db = null
  dbInitPromise = null
}

function must(): Database.Database {
  if (!db) throw new Error('database not initialized')
  return db
}

function ready(): boolean {
  return db !== null
}

export function isDbReady(): boolean {
  return ready()
}

/** Phase 48: shared DB accessor so feature modules (project-loop, companions,
 *  action-agents) can own their own store files without bloating db.ts. */
export function getDb(): Database.Database {
  return must()
}

export async function ensureDbReady(): Promise<void> {
  if (ready()) return
  if (process.env.AKORITH_SKIP_DB_INIT === '1') {
    throw new Error('database initialization skipped by AKORITH_SKIP_DB_INIT')
  }
  dbInitPromise ??= Promise.resolve()
    .then(() => {
      if (!ready()) initDb()
    })
    .finally(() => {
      dbInitPromise = null
    })
  await dbInitPromise
}

function ensureColumn(table: string, column: string, ddl: string): void {
  const columns = must().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (columns.some((c) => c.name === column)) return
  must().prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run()
}

// ---- session / message CRUD (also used by the chat:send handler) ----

export interface SessionRow {
  id: string
  providerId: string
  title: string
  projectId: string | null
  pinned: boolean
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
  attachments: StoredMessageAttachment[]
  metadata: StoredMessageMetadata | null
  createdAt: number
}

export interface StoredMessageMetadata {
  startedAt?: number
  endedAt?: number
  usage?: {
    promptTokens?: number
    completionTokens?: number
    costUsd?: number
    estimated: boolean
  }
  changes?: {
    files: Array<{ status: string; path: string; staged: boolean; additions: number; deletions: number }>
    additions: number
    deletions: number
    truncated: boolean
  }
}

export interface StoredMessageAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  kind: 'image' | 'document' | 'code' | 'file'
  path: string
}

function parseStoredAttachments(value: unknown): StoredMessageAttachment[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const rows = JSON.parse(value) as unknown
    if (!Array.isArray(rows)) return []
    return rows.filter((row): row is StoredMessageAttachment => Boolean(
      row && typeof row === 'object' &&
      typeof (row as StoredMessageAttachment).id === 'string' &&
      typeof (row as StoredMessageAttachment).name === 'string' &&
      typeof (row as StoredMessageAttachment).mimeType === 'string' &&
      typeof (row as StoredMessageAttachment).size === 'number' &&
      typeof (row as StoredMessageAttachment).path === 'string' &&
      ['image', 'document', 'code', 'file'].includes((row as StoredMessageAttachment).kind)
    ))
  } catch {
    return []
  }
}

function parseMessageMetadata(value: unknown): StoredMessageMetadata | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const metadata = JSON.parse(value) as StoredMessageMetadata
    return metadata && typeof metadata === 'object' ? metadata : null
  } catch {
    return null
  }
}

const toSession = (r: Record<string, unknown>): SessionRow => ({
  id: r.id as string,
  providerId: r.provider_id as string,
  title: r.title as string,
  projectId: (r.project_id as string | null) ?? null,
  pinned: Number(r.pinned ?? 0) === 1,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number
})

export function projectExists(projectId: string): boolean {
  if (!VALID_ID.test(projectId)) return false
  return Boolean(must().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId))
}

export function createSession(providerId: string, title: string, projectId?: string | null): SessionRow {
  const now = Date.now()
  const safeProjectId = projectId && projectExists(projectId) ? projectId : null
  const row: SessionRow = {
    id: randomUUID(),
    providerId,
    title,
    projectId: safeProjectId,
    pinned: false,
    createdAt: now,
    updatedAt: now
  }
  must()
    .prepare(
      'INSERT INTO sessions (id, provider_id, title, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(row.id, row.providerId, row.title, row.projectId, row.createdAt, row.updatedAt)
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
  model?: string,
  attachments: StoredMessageAttachment[] = [],
  metadata?: StoredMessageMetadata
): void {
  const now = Date.now()
  const d = must()
  d.prepare(
    'INSERT INTO messages (id, session_id, role, content, provider_id, model, attachments, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), sessionId, role, content, providerId, model ?? null, attachments.length ? JSON.stringify(attachments) : null, metadata ? JSON.stringify(metadata) : null, now)
  d.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
}

// ---- Phase 14.2 conversation memory helpers ----

/** All messages for a session in chronological order (used to assemble context). */
export function getSessionMessages(sessionId: string): MessageRow[] {
  return (
    must()
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid')
      .all(sessionId) as Record<string, unknown>[]
  ).map(
    (r): MessageRow => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      role: r.role as 'user' | 'assistant',
      content: r.content as string,
      providerId: r.provider_id as string,
      model: (r.model as string | null) ?? null,
      attachments: parseStoredAttachments(r.attachments),
      metadata: parseMessageMetadata(r.metadata),
      createdAt: r.created_at as number
    })
  )
}

/** The cached older-context summary and how many messages it covers. */
export function getContextSummary(sessionId: string): { summary: string | null; count: number } {
  const row = must()
    .prepare('SELECT context_summary, context_summary_count FROM sessions WHERE id = ?')
    .get(sessionId) as { context_summary: string | null; context_summary_count: number } | undefined
  return { summary: row?.context_summary ?? null, count: row?.context_summary_count ?? 0 }
}

export function setContextSummary(sessionId: string, summary: string, count: number): void {
  must()
    .prepare('UPDATE sessions SET context_summary = ?, context_summary_count = ? WHERE id = ?')
    .run(summary, count, sessionId)
}

/** Reset context for ONE session: delete its messages + clear the cached summary. */
export function clearSessionMessages(sessionId: string): void {
  const d = must()
  d.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
  d.prepare('UPDATE sessions SET context_summary = NULL, context_summary_count = 0, updated_at = ? WHERE id = ?').run(
    Date.now(),
    sessionId
  )
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

// ---- projects (Phase 9.1 sidebar workspace folders) ----

export interface ProjectRow {
  id: string
  name: string
  path: string | null
  color: string | null
  icon: string | null
  createdAt: number
  updatedAt: number
}

const toProject = (r: Record<string, unknown>): ProjectRow => ({
  id: r.id as string,
  name: r.name as string,
  path: (r.path as string | null) ?? null,
  color: (r.color as string | null) ?? null,
  icon: (r.icon as string | null) ?? null,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number
})

function cleanOptionalText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, max)
  return trimmed || null
}

function cleanProjectPath(value: unknown): string | null {
  const path = cleanOptionalText(value, MAX_PROJECT_PATH)
  if (!path || /[\0\r\n]/.test(path) || !isAbsolute(path)) return null
  try {
    return statSync(path).isDirectory() ? path : null
  } catch {
    return null
  }
}

function projectNameFromPath(path: string): string {
  return basename(path).trim().slice(0, MAX_PROJECT_NAME) || 'Project'
}

export function listProjects(): ProjectRow[] {
  return (
    must().prepare('SELECT * FROM projects ORDER BY updated_at DESC, name COLLATE NOCASE').all() as Record<
      string,
      unknown
    >[]
  ).map(toProject)
}

/** Phase 35: read-only session list for the controller API (metadata only). */
export function listSessions(): SessionRow[] {
  if (!ready()) return []
  return (must().prepare('SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC').all() as Record<string, unknown>[]).map(
    toSession
  )
}

/** Phase 39: per-provider recorded usage since a timestamp (for usage-limit windows). */
export function getProviderUsageSince(sinceTs: number): { providerId: string; events: number; tokens: number }[] {
  if (!ready()) return []
  const rows = must()
    .prepare(
      `SELECT provider_id AS providerId, COUNT(*) AS events,
              COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS tokens
       FROM usage_events WHERE ts >= ? GROUP BY provider_id`
    )
    .all(sinceTs) as Record<string, unknown>[]
  return rows.map((r) => ({
    providerId: String(r.providerId),
    events: Number(r.events) || 0,
    tokens: Number(r.tokens) || 0
  }))
}

export function createProject(input: {
  name: string
  path?: string | null
  color?: string | null
  icon?: string | null
}): ProjectRow {
  const now = Date.now()
  const name = input.name.trim().slice(0, MAX_PROJECT_NAME) || 'Untitled project'
  const row: ProjectRow = {
    id: randomUUID(),
    name,
    path: cleanProjectPath(input.path),
    color: cleanOptionalText(input.color, MAX_PROJECT_META),
    icon: cleanOptionalText(input.icon, MAX_PROJECT_META),
    createdAt: now,
    updatedAt: now
  }
  must()
    .prepare(
      `INSERT INTO projects (id, name, path, color, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.id, row.name, row.path, row.color, row.icon, row.createdAt, row.updatedAt)
  return row
}

export function getProject(projectId: string): ProjectRow | null {
  if (!VALID_ID.test(projectId)) return null
  const row = must().prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | Record<string, unknown>
    | undefined
  return row ? toProject(row) : null
}

export function getSessionProjectContext(sessionId: string): { projectName: string; projectPath: string } | null {
  if (!VALID_ID.test(sessionId)) return null
  const row = must()
    .prepare(
      `SELECT p.name, p.path
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`
    )
    .get(sessionId) as { name: string; path: string | null } | undefined
  const projectPath = cleanProjectPath(row?.path)
  if (!row || !projectPath) return null
  return {
    projectName: row.name.trim().slice(0, MAX_PROJECT_NAME) || projectNameFromPath(projectPath),
    projectPath
  }
}

function findProjectByPath(path: string): ProjectRow | null {
  const row = must().prepare('SELECT * FROM projects WHERE path = ? ORDER BY updated_at DESC LIMIT 1').get(path) as
    | Record<string, unknown>
    | undefined
  return row ? toProject(row) : null
}

export function ensureProjectForPath(path: string, name?: string, projectId?: string | null): ProjectRow {
  const safePath = cleanProjectPath(path)
  if (!safePath) throw new Error('selected folder is not a valid directory')
  if (projectId) {
    const updated = updateProject(projectId, { path: safePath, name: name || undefined })
    if (updated) return updated
  }
  const existing = findProjectByPath(safePath)
  if (existing) return existing
  return createProject({
    name: name?.trim() || projectNameFromPath(safePath),
    path: safePath,
    color: null,
    icon: 'folder'
  })
}

export function updateProject(
  projectId: string,
  patch: Partial<Pick<ProjectRow, 'name' | 'path' | 'color' | 'icon'>>
): ProjectRow | null {
  if (!VALID_ID.test(projectId)) return null
  const current = must().prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | Record<string, unknown>
    | undefined
  if (!current) return null
  const row = toProject(current)
  const next = {
    name: patch.name !== undefined ? patch.name.trim().slice(0, MAX_PROJECT_NAME) || row.name : row.name,
    path: patch.path !== undefined ? cleanProjectPath(patch.path) : row.path,
    color: patch.color !== undefined ? cleanOptionalText(patch.color, MAX_PROJECT_META) : row.color,
    icon: patch.icon !== undefined ? cleanOptionalText(patch.icon, MAX_PROJECT_META) : row.icon
  }
  must()
    .prepare('UPDATE projects SET name = ?, path = ?, color = ?, icon = ?, updated_at = ? WHERE id = ?')
    .run(next.name, next.path, next.color, next.icon, Date.now(), projectId)
  const updated = must().prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | Record<string, unknown>
    | undefined
  return updated ? toProject(updated) : null
}

/**
 * Phase 14.3: remove a project from Akorith's local list. This deletes the
 * project row and its workspace chats (messages cascade) — it NEVER touches the
 * folder on disk. Returns false for an unknown/invalid id.
 */
export function deleteProject(projectId: string): boolean {
  if (!VALID_ID.test(projectId)) return false
  const d = must()
  if (!d.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return false
  const tx = d.transaction((id: string) => {
    // Remove this project's workspace chats first so they do not linger as
    // orphaned general chats (the FK is ON DELETE SET NULL). Messages cascade.
    d.prepare('DELETE FROM sessions WHERE project_id = ?').run(id)
    d.prepare('DELETE FROM projects WHERE id = ?').run(id)
  })
  tx(projectId)
  return true
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
 * Based purely on what Akorith itself logged — NOT any official plan limit.
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

// ---- test runs (Phase 7; Phase 8 evaluations consume these rows) ----

export interface TestRunRow {
  id: string
  ts: number
  sourceRepo: string
  targetDesc: string | null
  providerId: string | null
  model: string | null
  framework: string | null
  passed: number | null
  failed: number | null
  errored: number | null
  durationMs: number | null
  exitCode: number | null
  tokens: number | null
  attempts: number | null
  sandboxPath: string | null
  generatedFiles: StoredGeneratedFile[] | null
  rawOutput: string | null
  status: string | null
}

const RAW_OUTPUT_CAP = 60_000
const GENERATED_FILES_CAP = 500_000

function serializeGeneratedFiles(files: StoredGeneratedFile[] | null | undefined): string | null {
  if (!files || files.length === 0) return null
  const safe = files.slice(0, 20).map((f) => ({
    path: String(f.path).slice(0, 1_000),
    content: String(f.content)
  }))
  const json = JSON.stringify(safe)
  return Buffer.byteLength(json, 'utf8') <= GENERATED_FILES_CAP ? json : JSON.stringify(safe.map((f) => ({
    path: f.path,
    content: f.content.slice(0, Math.max(0, Math.floor(GENERATED_FILES_CAP / safe.length) - 200))
  })))
}

function parseGeneratedFiles(raw: unknown): StoredGeneratedFile[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed
      .filter(
        (f): f is StoredGeneratedFile =>
          typeof f?.path === 'string' && typeof f?.content === 'string'
      )
      .slice(0, 20)
  } catch {
    return null
  }
}

export function createTestRun(row: Omit<TestRunRow, 'id' | 'ts'> & { id?: string; ts?: number }): TestRunRow {
  const full: TestRunRow = {
    id: row.id ?? randomUUID(),
    ts: row.ts ?? Date.now(),
    sourceRepo: row.sourceRepo,
    targetDesc: row.targetDesc ?? null,
    providerId: row.providerId ?? null,
    model: row.model ?? null,
    framework: row.framework ?? null,
    passed: row.passed ?? null,
    failed: row.failed ?? null,
    errored: row.errored ?? null,
    durationMs: row.durationMs ?? null,
    exitCode: row.exitCode ?? null,
    tokens: row.tokens ?? null,
    attempts: row.attempts ?? null,
    sandboxPath: row.sandboxPath ?? null,
    generatedFiles: row.generatedFiles ?? null,
    rawOutput: row.rawOutput != null ? row.rawOutput.slice(0, RAW_OUTPUT_CAP) : null,
    status: row.status ?? null
  }
  const generatedFiles = serializeGeneratedFiles(full.generatedFiles)
  must()
    .prepare(
      `INSERT INTO test_runs
        (id, ts, source_repo, target_desc, provider_id, model, framework,
         passed, failed, errored, duration_ms, exit_code, tokens, attempts,
         sandbox_path, generated_files, raw_output, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      full.id,
      full.ts,
      full.sourceRepo,
      full.targetDesc,
      full.providerId,
      full.model,
      full.framework,
      full.passed,
      full.failed,
      full.errored,
      full.durationMs,
      full.exitCode,
      full.tokens,
      full.attempts,
      full.sandboxPath,
      generatedFiles,
      full.rawOutput,
      full.status
    )
  return full
}

const toTestRun = (r: Record<string, unknown>): TestRunRow => ({
  id: r.id as string,
  ts: r.ts as number,
  sourceRepo: r.source_repo as string,
  targetDesc: (r.target_desc as string | null) ?? null,
  providerId: (r.provider_id as string | null) ?? null,
  model: (r.model as string | null) ?? null,
  framework: (r.framework as string | null) ?? null,
  passed: (r.passed as number | null) ?? null,
  failed: (r.failed as number | null) ?? null,
  errored: (r.errored as number | null) ?? null,
  durationMs: (r.duration_ms as number | null) ?? null,
  exitCode: (r.exit_code as number | null) ?? null,
  tokens: (r.tokens as number | null) ?? null,
  attempts: (r.attempts as number | null) ?? null,
  sandboxPath: (r.sandbox_path as string | null) ?? null,
  generatedFiles: parseGeneratedFiles(r.generated_files),
  rawOutput: (r.raw_output as string | null) ?? null,
  status: (r.status as string | null) ?? null
})

export function listTestRuns(limit = 50): TestRunRow[] {
  const lim = Math.min(Math.max(limit, 1), 500)
  return (must().prepare('SELECT * FROM test_runs ORDER BY ts DESC LIMIT ?').all(lim) as Record<string, unknown>[]).map(
    toTestRun
  )
}

export function getTestRunsByIds(ids: string[]): TestRunRow[] {
  const safe = ids.filter((id) => VALID_ID.test(id)).slice(0, 50)
  if (safe.length === 0) return []
  const placeholders = safe.map(() => '?').join(', ')
  return (
    must().prepare(`SELECT * FROM test_runs WHERE id IN (${placeholders})`).all(...safe) as Record<string, unknown>[]
  ).map(toTestRun)
}

// ---- evaluations (Phase 8: ISAScore + PDF reports) ----

export type EvaluationKind = 'single' | 'comparison'

export interface EvaluationRow {
  id: string
  ts: number
  kind: EvaluationKind
  testRunIds: string[]
  judgeModel: string | null
  dimensionScores: unknown
  weights: unknown
  totalScore: number
  rationale: string | null
  pdfPath: string | null
}

function parseJsonField(raw: unknown, fallback: unknown): unknown {
  if (typeof raw !== 'string') return fallback
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return fallback
  }
}

const toEvaluation = (r: Record<string, unknown>): EvaluationRow => ({
  id: r.id as string,
  ts: r.ts as number,
  kind: r.kind as EvaluationKind,
  testRunIds: parseJsonField(r.test_run_ids, []) as string[],
  judgeModel: (r.judge_model as string | null) ?? null,
  dimensionScores: parseJsonField(r.dimension_scores, {}),
  weights: parseJsonField(r.weights, {}),
  totalScore: Number(r.total_score ?? 0),
  rationale: (r.rationale as string | null) ?? null,
  pdfPath: (r.pdf_path as string | null) ?? null
})

export function createEvaluation(row: Omit<EvaluationRow, 'id' | 'ts'> & { id?: string; ts?: number }): EvaluationRow {
  const full: EvaluationRow = {
    id: row.id ?? randomUUID(),
    ts: row.ts ?? Date.now(),
    kind: row.kind,
    testRunIds: row.testRunIds,
    judgeModel: row.judgeModel ?? null,
    dimensionScores: row.dimensionScores,
    weights: row.weights,
    totalScore: row.totalScore,
    rationale: row.rationale ?? null,
    pdfPath: row.pdfPath ?? null
  }
  must()
    .prepare(
      `INSERT INTO evaluations
       (id, ts, kind, test_run_ids, judge_model, dimension_scores, weights, total_score, rationale, pdf_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      full.id,
      full.ts,
      full.kind,
      JSON.stringify(full.testRunIds),
      full.judgeModel,
      JSON.stringify(full.dimensionScores),
      JSON.stringify(full.weights),
      full.totalScore,
      full.rationale,
      full.pdfPath
    )
  return full
}

export function getEvaluation(id: string): EvaluationRow | null {
  if (!VALID_ID.test(id)) return null
  const row = must().prepare('SELECT * FROM evaluations WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? toEvaluation(row) : null
}

export function listEvaluations(limit = 50): EvaluationRow[] {
  const lim = Math.min(Math.max(limit, 1), 500)
  return (
    must().prepare('SELECT * FROM evaluations ORDER BY ts DESC LIMIT ?').all(lim) as Record<string, unknown>[]
  ).map(toEvaluation)
}

export function setEvaluationPdfPath(id: string, pdfPath: string): EvaluationRow | null {
  if (!VALID_ID.test(id)) return null
  must().prepare('UPDATE evaluations SET pdf_path = ? WHERE id = ?').run(pdfPath, id)
  return getEvaluation(id)
}

// ---- macro loop sessions/turns (Phase 9) ----

export type { MacroExecutorType, MacroMode, MacroStatus } from './loops/types'

export interface MacroSessionRow {
  id: string
  createdAt: number
  updatedAt: number
  status: MacroStatus
  goal: string
  plannerProvider: string
  plannerModel: string | null
  targetTerminal: string
  maxIterations: number
  goodEnoughThreshold: number
  includeRepoDigest: boolean
  repoDigestSnapshot: string | null
  finalScore: number | null
  stopReason: string | null
  /** Phase 11 agentic loop. */
  mode: MacroMode
  /** JSON audit trail of automatic actions (sends, auto-answers, pauses). */
  autoActions: string | null
  pauseReason: string | null
  /** Phase 20 autonomous workspace loop. */
  workspaceDir: string | null
  autoCommit: boolean
  /** Metered meta-call token budget; 0 = unlimited. */
  tokenBudget: number
  tokensUsed: number
  /** Phase 21: plain-language label shown on the loop card. */
  title: string | null
  /** Phase 22: the user's chosen next direction, consumed by the next plan. */
  pendingSteering: string | null
  /** Monitoring/build cadence metadata for the Loop section. */
  loopIntent: string | null
  cadenceMinutes: number
  /** Phase 23.2 Loop Operations Center metadata. */
  loopType: string | null
  targetType: string | null
  targetRef: string | null
  scheduleKind: string | null
  scheduleDetail: string | null
  nextRunAt: number | null
  stopCondition: string | null
  maxRuns: number
  maxCommits: number
  runCount: number
  commitBehavior: string | null
  pushEnabled: boolean
  testCommands: string | null
  reportFormat: string | null
  safetyLevel: string | null
  latestResult: string | null
  archivedAt: number | null
  /** Phase 27 Local Executor Loop. */
  executorType: MacroExecutorType
  executorProvider: string | null
  executorModel: string | null
  lastAttemptStatus: string | null
  lastValidationResult: string | null
  lastCommitMessage: string | null
}

export interface MacroTurnRow {
  id: string
  sessionId: string
  turnIndex: number
  createdAt: number
  status: string
  proposal: string | null
  editedProposal: string | null
  sentPrompt: string | null
  executorResultSummary: string | null
  plannerRationale: string | null
  expectedResult: string | null
  confidenceScore: number | null
  goodEnoughScore: number | null
  riskLevel: string | null
  providerUsed: string | null
  modelUsed: string | null
  error: string | null
  /** Phase 11 agentic loop (JSON / metrics). */
  summarizerConfidence: number | null
  permissionDetection: string | null
  terminalSnapshotMeta: string | null
  autoAction: string | null
  resultStatus: string | null
  /** Phase 19 critic: measured grade of the actual result. */
  criticScore: number | null
  criticVerdict: string | null
  /** JSON-serialized CriticReview. */
  criticReview: string | null
  /** Phase 22: JSON array of 3 suggested next directions for steering. */
  nextOptions: string | null
}

export interface MacroSessionWithTurns {
  session: MacroSessionRow
  turns: MacroTurnRow[]
}

const toMacroSession = (r: Record<string, unknown>): MacroSessionRow => ({
  id: r.id as string,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
  status: r.status as MacroStatus,
  goal: r.goal as string,
  plannerProvider: r.planner_provider as string,
  plannerModel: (r.planner_model as string | null) ?? null,
  targetTerminal: r.target_terminal as string,
  maxIterations: r.max_iterations as number,
  goodEnoughThreshold: r.good_enough_threshold as number,
  includeRepoDigest: r.include_repo_digest === 1,
  repoDigestSnapshot: (r.repo_digest_snapshot as string | null) ?? null,
  finalScore: (r.final_score as number | null) ?? null,
  stopReason: (r.stop_reason as string | null) ?? null,
  mode: (r.mode as MacroMode | null) === 'auto' ? 'auto' : 'approval',
  autoActions: (r.auto_actions as string | null) ?? null,
  pauseReason: (r.pause_reason as string | null) ?? null,
  workspaceDir: (r.workspace_dir as string | null) ?? null,
  autoCommit: r.auto_commit === 1,
  tokenBudget: (r.token_budget as number | null) ?? 0,
  tokensUsed: (r.tokens_used as number | null) ?? 0,
  title: (r.title as string | null) ?? null,
  pendingSteering: (r.pending_steering as string | null) ?? null,
  loopIntent: (r.loop_intent as string | null) ?? null,
  cadenceMinutes: (r.cadence_minutes as number | null) ?? 0,
  loopType: (r.loop_type as string | null) ?? null,
  targetType: (r.target_type as string | null) ?? null,
  targetRef: (r.target_ref as string | null) ?? null,
  scheduleKind: (r.schedule_kind as string | null) ?? null,
  scheduleDetail: (r.schedule_detail as string | null) ?? null,
  nextRunAt: (r.next_run_at as number | null) ?? null,
  stopCondition: (r.stop_condition as string | null) ?? null,
  maxRuns: (r.max_runs as number | null) ?? 0,
  maxCommits: (r.max_commits as number | null) ?? 0,
  runCount: (r.run_count as number | null) ?? 0,
  commitBehavior: (r.commit_behavior as string | null) ?? null,
  pushEnabled: r.push_enabled === 1,
  testCommands: (r.test_commands as string | null) ?? null,
  reportFormat: (r.report_format as string | null) ?? null,
  safetyLevel: (r.safety_level as string | null) ?? null,
  latestResult: (r.latest_result as string | null) ?? null,
  archivedAt: (r.archived_at as number | null) ?? null,
  executorType: (r.executor_type as MacroExecutorType | null) === 'local' ? 'local' : 'pty',
  executorProvider: (r.executor_provider as string | null) ?? null,
  executorModel: (r.executor_model as string | null) ?? null,
  lastAttemptStatus: (r.last_attempt_status as string | null) ?? null,
  lastValidationResult: (r.last_validation_result as string | null) ?? null,
  lastCommitMessage: (r.last_commit_message as string | null) ?? null
})

const toMacroTurn = (r: Record<string, unknown>): MacroTurnRow => ({
  id: r.id as string,
  sessionId: r.session_id as string,
  turnIndex: r.turn_index as number,
  createdAt: r.created_at as number,
  status: r.status as string,
  proposal: (r.proposal as string | null) ?? null,
  editedProposal: (r.edited_proposal as string | null) ?? null,
  sentPrompt: (r.sent_prompt as string | null) ?? null,
  executorResultSummary: (r.executor_result_summary as string | null) ?? null,
  plannerRationale: (r.planner_rationale as string | null) ?? null,
  expectedResult: (r.expected_result as string | null) ?? null,
  confidenceScore: (r.confidence_score as number | null) ?? null,
  goodEnoughScore: (r.good_enough_score as number | null) ?? null,
  riskLevel: (r.risk_level as string | null) ?? null,
  providerUsed: (r.provider_used as string | null) ?? null,
  modelUsed: (r.model_used as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  summarizerConfidence: (r.summarizer_confidence as number | null) ?? null,
  permissionDetection: (r.permission_detection as string | null) ?? null,
  terminalSnapshotMeta: (r.terminal_snapshot_meta as string | null) ?? null,
  autoAction: (r.auto_action as string | null) ?? null,
  resultStatus: (r.result_status as string | null) ?? null,
  criticScore: (r.critic_score as number | null) ?? null,
  criticVerdict: (r.critic_verdict as string | null) ?? null,
  criticReview: (r.critic_review as string | null) ?? null,
  nextOptions: (r.next_options as string | null) ?? null
})

function touchMacroSession(sessionId: string, status?: MacroStatus): void {
  if (status) {
    must().prepare('UPDATE macro_sessions SET updated_at = ?, status = ? WHERE id = ?').run(Date.now(), status, sessionId)
  } else {
    must().prepare('UPDATE macro_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId)
  }
}

export function createMacroSession(input: {
  goal: string
  plannerProvider: string
  plannerModel?: string
  targetTerminal: string
  maxIterations: number
  goodEnoughThreshold: number
  includeRepoDigest: boolean
  mode?: MacroMode
  workspaceDir?: string | null
  autoCommit?: boolean
  tokenBudget?: number
  title?: string | null
  loopIntent?: string | null
  cadenceMinutes?: number
  loopType?: string | null
  targetType?: string | null
  targetRef?: string | null
  scheduleKind?: string | null
  scheduleDetail?: string | null
  nextRunAt?: number | null
  stopCondition?: string | null
  maxRuns?: number
  maxCommits?: number
  commitBehavior?: string | null
  pushEnabled?: boolean
  testCommands?: string | null
  reportFormat?: string | null
  safetyLevel?: string | null
  latestResult?: string | null
  executorType?: MacroExecutorType
  executorProvider?: string | null
  executorModel?: string | null
}): MacroSessionRow {
  const now = Date.now()
  const row: MacroSessionRow = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: 'idle',
    goal: input.goal,
    plannerProvider: input.plannerProvider,
    plannerModel: input.plannerModel ?? null,
    targetTerminal: input.targetTerminal,
    maxIterations: input.maxIterations,
    goodEnoughThreshold: input.goodEnoughThreshold,
    includeRepoDigest: input.includeRepoDigest,
    repoDigestSnapshot: null,
    finalScore: null,
    stopReason: null,
    mode: input.mode === 'auto' ? 'auto' : 'approval',
    autoActions: null,
    pauseReason: null,
    workspaceDir: input.workspaceDir ?? null,
    autoCommit: input.autoCommit ?? false,
    tokenBudget: Math.max(0, Math.floor(input.tokenBudget ?? 0)),
    tokensUsed: 0,
    title: input.title ?? null,
    pendingSteering: null,
    loopIntent: input.loopIntent ?? null,
    cadenceMinutes: Math.max(0, Math.floor(input.cadenceMinutes ?? 0)),
    loopType: input.loopType ?? input.loopIntent ?? null,
    targetType: input.targetType ?? (input.workspaceDir ? 'project' : null),
    targetRef: input.targetRef ?? input.workspaceDir ?? null,
    scheduleKind: input.scheduleKind ?? (input.cadenceMinutes && input.cadenceMinutes > 0 ? 'recurring' : 'continuous'),
    scheduleDetail: input.scheduleDetail ?? null,
    nextRunAt: input.nextRunAt ?? null,
    stopCondition: input.stopCondition ?? null,
    maxRuns: Math.max(0, Math.floor(input.maxRuns ?? 0)),
    maxCommits: Math.max(0, Math.floor(input.maxCommits ?? 0)),
    runCount: 0,
    commitBehavior: input.commitBehavior ?? (input.autoCommit ? 'commit' : 'none'),
    pushEnabled: input.pushEnabled ?? false,
    testCommands: input.testCommands ?? null,
    reportFormat: input.reportFormat ?? 'summary',
    safetyLevel: input.safetyLevel ?? 'balanced',
    latestResult: input.latestResult ?? null,
    archivedAt: null,
    executorType: input.executorType === 'local' ? 'local' : 'pty',
    executorProvider: input.executorProvider ?? (input.executorType === 'local' ? 'local' : null),
    executorModel: input.executorModel ?? null,
    lastAttemptStatus: null,
    lastValidationResult: null,
    lastCommitMessage: null
  }
  must()
    .prepare(
      `INSERT INTO macro_sessions
       (id, created_at, updated_at, status, goal, planner_provider, planner_model, target_terminal,
        max_iterations, good_enough_threshold, include_repo_digest, repo_digest_snapshot, final_score, stop_reason,
        mode, auto_actions, pause_reason, workspace_dir, auto_commit, token_budget, tokens_used, title,
        loop_intent, cadence_minutes, loop_type, target_type, target_ref, schedule_kind, schedule_detail,
        next_run_at, stop_condition, max_runs, max_commits, run_count, commit_behavior, push_enabled,
        test_commands, report_format, safety_level, latest_result, archived_at,
        executor_type, executor_provider, executor_model, last_attempt_status, last_validation_result, last_commit_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.createdAt,
      row.updatedAt,
      row.status,
      row.goal,
      row.plannerProvider,
      row.plannerModel,
      row.targetTerminal,
      row.maxIterations,
      row.goodEnoughThreshold,
      row.includeRepoDigest ? 1 : 0,
      row.repoDigestSnapshot,
      row.finalScore,
      row.stopReason,
      row.mode,
      row.autoActions,
      row.pauseReason,
      row.workspaceDir,
      row.autoCommit ? 1 : 0,
      row.tokenBudget,
      row.tokensUsed,
      row.title,
      row.loopIntent,
      row.cadenceMinutes,
      row.loopType,
      row.targetType,
      row.targetRef,
      row.scheduleKind,
      row.scheduleDetail,
      row.nextRunAt,
      row.stopCondition,
      row.maxRuns,
      row.maxCommits,
      row.runCount,
      row.commitBehavior,
      row.pushEnabled ? 1 : 0,
      row.testCommands,
      row.reportFormat,
      row.safetyLevel,
      row.latestResult,
      row.archivedAt,
      row.executorType,
      row.executorProvider,
      row.executorModel,
      row.lastAttemptStatus,
      row.lastValidationResult,
      row.lastCommitMessage
    )
  return row
}

export function updateMacroSession(
  sessionId: string,
  patch: Partial<
    Pick<
      MacroSessionRow,
      | 'status'
      | 'repoDigestSnapshot'
      | 'finalScore'
      | 'stopReason'
      | 'mode'
      | 'autoActions'
      | 'pauseReason'
      | 'tokensUsed'
      | 'pendingSteering'
      | 'plannerProvider'
      | 'plannerModel'
      | 'targetTerminal'
      | 'nextRunAt'
      | 'runCount'
      | 'latestResult'
      | 'pushEnabled'
      | 'archivedAt'
      | 'executorType'
      | 'executorProvider'
      | 'executorModel'
      | 'lastAttemptStatus'
      | 'lastValidationResult'
      | 'lastCommitMessage'
    >
  >
): MacroSessionRow | null {
  if (!VALID_ID.test(sessionId)) return null
  const current = getMacroSession(sessionId)
  if (!current) return null
  const next = {
    status: patch.status ?? current.status,
    repoDigestSnapshot: patch.repoDigestSnapshot ?? current.repoDigestSnapshot,
    finalScore: patch.finalScore ?? current.finalScore,
    stopReason: patch.stopReason ?? current.stopReason,
    mode: patch.mode ?? current.mode,
    autoActions: patch.autoActions !== undefined ? patch.autoActions : current.autoActions,
    pauseReason: patch.pauseReason !== undefined ? patch.pauseReason : current.pauseReason,
    tokensUsed: patch.tokensUsed ?? current.tokensUsed,
    pendingSteering: patch.pendingSteering !== undefined ? patch.pendingSteering : current.pendingSteering,
    plannerProvider: patch.plannerProvider ?? current.plannerProvider,
    plannerModel: patch.plannerModel !== undefined ? patch.plannerModel : current.plannerModel,
    targetTerminal: patch.targetTerminal ?? current.targetTerminal,
    nextRunAt: patch.nextRunAt !== undefined ? patch.nextRunAt : current.nextRunAt,
    runCount: patch.runCount ?? current.runCount,
    latestResult: patch.latestResult !== undefined ? patch.latestResult : current.latestResult,
    pushEnabled: patch.pushEnabled ?? current.pushEnabled,
    archivedAt: patch.archivedAt !== undefined ? patch.archivedAt : current.archivedAt,
    executorType: patch.executorType ?? current.executorType,
    executorProvider: patch.executorProvider !== undefined ? patch.executorProvider : current.executorProvider,
    executorModel: patch.executorModel !== undefined ? patch.executorModel : current.executorModel,
    lastAttemptStatus: patch.lastAttemptStatus !== undefined ? patch.lastAttemptStatus : current.lastAttemptStatus,
    lastValidationResult: patch.lastValidationResult !== undefined ? patch.lastValidationResult : current.lastValidationResult,
    lastCommitMessage: patch.lastCommitMessage !== undefined ? patch.lastCommitMessage : current.lastCommitMessage
  }
  must()
    .prepare(
      `UPDATE macro_sessions
       SET updated_at = ?, status = ?, repo_digest_snapshot = ?, final_score = ?, stop_reason = ?,
           mode = ?, auto_actions = ?, pause_reason = ?, tokens_used = ?, pending_steering = ?,
           planner_provider = ?, planner_model = ?, target_terminal = ?, next_run_at = ?,
           run_count = ?, latest_result = ?, push_enabled = ?, archived_at = ?,
           executor_type = ?, executor_provider = ?, executor_model = ?,
           last_attempt_status = ?, last_validation_result = ?, last_commit_message = ?
       WHERE id = ?`
    )
    .run(
      Date.now(),
      next.status,
      next.repoDigestSnapshot,
      next.finalScore,
      next.stopReason,
      next.mode,
      next.autoActions,
      next.pauseReason,
      next.tokensUsed,
      next.pendingSteering,
      next.plannerProvider,
      next.plannerModel,
      next.targetTerminal,
      next.nextRunAt,
      next.runCount,
      next.latestResult,
      next.pushEnabled ? 1 : 0,
      next.archivedAt,
      next.executorType,
      next.executorProvider,
      next.executorModel,
      next.lastAttemptStatus,
      next.lastValidationResult,
      next.lastCommitMessage,
      sessionId
    )
  return getMacroSession(sessionId)
}

export function getMacroSession(sessionId: string): MacroSessionRow | null {
  if (!VALID_ID.test(sessionId)) return null
  const row = must().prepare('SELECT * FROM macro_sessions WHERE id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined
  return row ? toMacroSession(row) : null
}

export function listMacroSessions(limit = 20): MacroSessionRow[] {
  const lim = Math.min(Math.max(limit, 1), 100)
  return (
    must().prepare('SELECT * FROM macro_sessions ORDER BY updated_at DESC LIMIT ?').all(lim) as Record<string, unknown>[]
  ).map(toMacroSession)
}

export function archiveMacroSession(sessionId: string): MacroSessionRow | null {
  if (!VALID_ID.test(sessionId)) return null
  const current = getMacroSession(sessionId)
  if (!current) return null
  return updateMacroSession(sessionId, {
    status: current.status === 'completed' || current.status === 'stopped' || current.status === 'error'
      ? current.status
      : 'stopped',
    stopReason: current.stopReason ?? 'archived',
    pauseReason: null,
    archivedAt: Date.now()
  })
}

export function deleteMacroSession(sessionId: string): boolean {
  if (!VALID_ID.test(sessionId)) return false
  const d = must()
  if (!d.prepare('SELECT 1 FROM macro_sessions WHERE id = ?').get(sessionId)) return false
  d.prepare('DELETE FROM macro_sessions WHERE id = ?').run(sessionId)
  return true
}

export interface LoopRunRecordInput {
  loopId: string
  runIndex: number
  startedAt: number
  endedAt?: number | null
  status: string
  providerId?: string | null
  model?: string | null
  summary?: string | null
  actionsTaken?: unknown
  filesChanged?: string[] | null
  commandsExecuted?: string[] | null
  testBuildResults?: string | null
  commitsCreated?: string[] | null
  nextSuggestedStep?: string | null
  error?: string | null
}

export interface LoopRunRow {
  id: string
  loopId: string
  runIndex: number
  startedAt: number
  endedAt: number | null
  status: string
  providerId: string | null
  model: string | null
  summary: string | null
  actionsTaken: unknown
  filesChanged: string[] | null
  commandsExecuted: string[] | null
  testBuildResults: string | null
  commitsCreated: string[] | null
  nextSuggestedStep: string | null
  error: string | null
}

export interface LoopEventRow {
  id: string
  loopId: string
  runId: string | null
  ts: number
  type: string
  message: string
  severity: 'info' | 'success' | 'warning' | 'error'
  metadata: unknown
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function parseJsonValue(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function parseStringArray(raw: unknown): string[] | null {
  const parsed = parseJsonValue(raw)
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : null
}

function toLoopRun(r: Record<string, unknown>): LoopRunRow {
  return {
    id: r.id as string,
    loopId: r.loop_id as string,
    runIndex: (r.run_index as number) ?? 0,
    startedAt: (r.started_at as number) ?? 0,
    endedAt: (r.ended_at as number | null) ?? null,
    status: (r.status as string) ?? 'unknown',
    providerId: (r.provider_id as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    actionsTaken: parseJsonValue(r.actions_taken),
    filesChanged: parseStringArray(r.files_changed),
    commandsExecuted: parseStringArray(r.commands_executed),
    testBuildResults: (r.test_build_results as string | null) ?? null,
    commitsCreated: parseStringArray(r.commits_created),
    nextSuggestedStep: (r.next_suggested_step as string | null) ?? null,
    error: (r.error as string | null) ?? null
  }
}

function toLoopEvent(r: Record<string, unknown>): LoopEventRow {
  const severity = r.severity === 'success' || r.severity === 'warning' || r.severity === 'error' ? r.severity : 'info'
  return {
    id: r.id as string,
    loopId: r.loop_id as string,
    runId: (r.run_id as string | null) ?? null,
    ts: (r.ts as number) ?? 0,
    type: (r.type as string) ?? 'event',
    message: (r.message as string) ?? '',
    severity,
    metadata: parseJsonValue(r.metadata)
  }
}

export function recordLoopRun(input: LoopRunRecordInput): string | null {
  if (!VALID_ID.test(input.loopId)) return null
  const id = randomUUID()
  const endedAt = input.endedAt ?? Date.now()
  must()
    .prepare(
      `INSERT INTO loop_runs
       (id, loop_id, run_index, started_at, ended_at, status, provider_id, model, summary,
        actions_taken, files_changed, commands_executed, test_build_results, commits_created,
        next_suggested_step, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.loopId,
      input.runIndex,
      input.startedAt,
      endedAt,
      input.status,
      input.providerId ?? null,
      input.model ?? null,
      input.summary ?? null,
      jsonOrNull(input.actionsTaken),
      jsonOrNull(input.filesChanged ?? null),
      jsonOrNull(input.commandsExecuted ?? null),
      input.testBuildResults ?? null,
      jsonOrNull(input.commitsCreated ?? null),
      input.nextSuggestedStep ?? null,
      input.error ?? null
    )
  const current = getMacroSession(input.loopId)
  if (current) {
    updateMacroSession(input.loopId, {
      runCount: Math.max(current.runCount, input.runIndex),
      latestResult: input.summary ?? input.error ?? current.latestResult,
      nextRunAt: current.cadenceMinutes > 0 ? endedAt + current.cadenceMinutes * 60_000 : null
    })
  }
  return id
}

export function listLoopRuns(loopId: string, limit = 50): LoopRunRow[] {
  if (!VALID_ID.test(loopId)) return []
  return (
    must()
      .prepare('SELECT * FROM loop_runs WHERE loop_id = ? ORDER BY run_index DESC, started_at DESC LIMIT ?')
      .all(loopId, Math.max(1, Math.min(200, Math.floor(limit)))) as Record<string, unknown>[]
  ).map(toLoopRun)
}

export function recordLoopEvent(input: {
  loopId: string
  runId?: string | null
  type: string
  message: string
  severity?: 'info' | 'success' | 'warning' | 'error'
  metadata?: unknown
}): void {
  if (!VALID_ID.test(input.loopId)) return
  const now = Date.now()
  must()
    .prepare(
      `INSERT INTO loop_events (id, loop_id, run_id, ts, type, message, severity, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      input.loopId,
      input.runId ?? null,
      now,
      input.type.slice(0, 80),
      input.message.slice(0, 2_000),
      input.severity ?? 'info',
      jsonOrNull(input.metadata)
    )
  updateMacroSession(input.loopId, { latestResult: input.message })
}

export function listLoopEvents(loopId: string, limit = 80): LoopEventRow[] {
  if (!VALID_ID.test(loopId)) return []
  return (
    must()
      .prepare('SELECT * FROM loop_events WHERE loop_id = ? ORDER BY ts DESC LIMIT ?')
      .all(loopId, Math.max(1, Math.min(250, Math.floor(limit)))) as Record<string, unknown>[]
  ).map(toLoopEvent)
}

export function listMacroTurns(sessionId: string): MacroTurnRow[] {
  if (!VALID_ID.test(sessionId)) return []
  return (
    must()
      .prepare('SELECT * FROM macro_turns WHERE session_id = ? ORDER BY turn_index, created_at')
      .all(sessionId) as Record<string, unknown>[]
  ).map(toMacroTurn)
}

export function getMacroState(sessionId: string): MacroSessionWithTurns | null {
  const session = getMacroSession(sessionId)
  if (!session) return null
  return { session, turns: listMacroTurns(session.id) }
}

export function createMacroTurn(input: {
  sessionId: string
  turnIndex: number
  status: string
  proposal?: string
  plannerRationale?: string
  expectedResult?: string
  confidenceScore?: number
  goodEnoughScore?: number
  riskLevel?: string
  providerUsed?: string
  modelUsed?: string
  error?: string
}): MacroTurnRow {
  const now = Date.now()
  const row: MacroTurnRow = {
    id: randomUUID(),
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    createdAt: now,
    status: input.status,
    proposal: input.proposal ?? null,
    editedProposal: null,
    sentPrompt: null,
    executorResultSummary: null,
    plannerRationale: input.plannerRationale ?? null,
    expectedResult: input.expectedResult ?? null,
    confidenceScore: input.confidenceScore ?? null,
    goodEnoughScore: input.goodEnoughScore ?? null,
    riskLevel: input.riskLevel ?? null,
    providerUsed: input.providerUsed ?? null,
    modelUsed: input.modelUsed ?? null,
    error: input.error ?? null,
    summarizerConfidence: null,
    permissionDetection: null,
    terminalSnapshotMeta: null,
    autoAction: null,
    resultStatus: null,
    criticScore: null,
    criticVerdict: null,
    criticReview: null,
    nextOptions: null
  }
  must()
    .prepare(
      `INSERT INTO macro_turns
       (id, session_id, turn_index, created_at, status, proposal, edited_proposal, sent_prompt,
        executor_result_summary, planner_rationale, expected_result, confidence_score, good_enough_score,
        risk_level, provider_used, model_used, error,
        summarizer_confidence, permission_detection, terminal_snapshot_meta, auto_action, result_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.sessionId,
      row.turnIndex,
      row.createdAt,
      row.status,
      row.proposal,
      row.editedProposal,
      row.sentPrompt,
      row.executorResultSummary,
      row.plannerRationale,
      row.expectedResult,
      row.confidenceScore,
      row.goodEnoughScore,
      row.riskLevel,
      row.providerUsed,
      row.modelUsed,
      row.error,
      row.summarizerConfidence,
      row.permissionDetection,
      row.terminalSnapshotMeta,
      row.autoAction,
      row.resultStatus
    )
  touchMacroSession(input.sessionId)
  return row
}

export function updateMacroTurn(
  turnId: string,
  patch: Partial<
    Pick<
      MacroTurnRow,
      | 'status'
      | 'proposal'
      | 'editedProposal'
      | 'sentPrompt'
      | 'executorResultSummary'
      | 'plannerRationale'
      | 'expectedResult'
      | 'confidenceScore'
      | 'goodEnoughScore'
      | 'riskLevel'
      | 'providerUsed'
      | 'modelUsed'
      | 'error'
      | 'summarizerConfidence'
      | 'permissionDetection'
      | 'terminalSnapshotMeta'
      | 'autoAction'
      | 'resultStatus'
      | 'criticScore'
      | 'criticVerdict'
      | 'criticReview'
      | 'nextOptions'
    >
  >
): MacroTurnRow | null {
  if (!VALID_ID.test(turnId)) return null
  const current = must().prepare('SELECT * FROM macro_turns WHERE id = ?').get(turnId) as
    | Record<string, unknown>
    | undefined
  if (!current) return null
  const row = toMacroTurn(current)
  const next = { ...row, ...patch }
  must()
    .prepare(
      `UPDATE macro_turns
       SET status = ?, proposal = ?, edited_proposal = ?, sent_prompt = ?, executor_result_summary = ?,
           planner_rationale = ?, expected_result = ?, confidence_score = ?, good_enough_score = ?,
           risk_level = ?, provider_used = ?, model_used = ?, error = ?,
           summarizer_confidence = ?, permission_detection = ?, terminal_snapshot_meta = ?,
           auto_action = ?, result_status = ?, critic_score = ?, critic_verdict = ?, critic_review = ?,
           next_options = ?
       WHERE id = ?`
    )
    .run(
      next.status,
      next.proposal,
      next.editedProposal,
      next.sentPrompt,
      next.executorResultSummary,
      next.plannerRationale,
      next.expectedResult,
      next.confidenceScore,
      next.goodEnoughScore,
      next.riskLevel,
      next.providerUsed,
      next.modelUsed,
      next.error,
      next.summarizerConfidence,
      next.permissionDetection,
      next.terminalSnapshotMeta,
      next.autoAction,
      next.resultStatus,
      next.criticScore,
      next.criticVerdict,
      next.criticReview,
      next.nextOptions,
      turnId
    )
  touchMacroSession(row.sessionId)
  const updated = must().prepare('SELECT * FROM macro_turns WHERE id = ?').get(turnId) as Record<string, unknown> | undefined
  return updated ? toMacroTurn(updated) : null
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

type ProjectDialogResponse =
  | { ok: true; project: ProjectRow }
  | { ok: false; cancelled?: boolean; error: string }

async function openProjectFolder(projectId?: string | null): Promise<ProjectDialogResponse> {
  const result = await dialog.showOpenDialog({
    title: 'Open Project',
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true, error: 'cancelled' }
  try {
    return { ok: true, project: ensureProjectForPath(result.filePaths[0], undefined, projectId ?? null) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

type DirPickResponse = { ok: true; path: string } | { ok: false; cancelled?: boolean; error: string }

/** Standalone parent-folder picker so the Create Project modal can show the
 *  chosen directory before committing. Main-process only; validates the path. */
async function pickProjectDirectory(): Promise<DirPickResponse> {
  const result = await dialog.showOpenDialog({
    title: 'Choose Parent Folder',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true, error: 'cancelled' }
  const path = cleanProjectPath(result.filePaths[0])
  if (!path) return { ok: false, error: 'selected folder is not a valid directory' }
  return { ok: true, path }
}

async function createProjectFolder(
  name: string,
  projectId?: string | null,
  parentPath?: string | null
): Promise<ProjectDialogResponse> {
  const safeName = name.trim().slice(0, MAX_PROJECT_NAME)
  if (!safeName || safeName === '.' || safeName === '..' || !SAFE_PROJECT_DIR_NAME.test(safeName)) {
    return { ok: false, error: 'project name cannot contain path separators or reserved characters' }
  }
  // A pre-picked parent (from the modal) skips the dialog; otherwise prompt.
  let selectedParent: string
  if (typeof parentPath === 'string' && parentPath.trim().length > 0) {
    selectedParent = parentPath
  } else {
    const result = await dialog.showOpenDialog({
      title: 'Choose Parent Folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true, error: 'cancelled' }
    selectedParent = result.filePaths[0]
  }
  try {
    const parent = cleanProjectPath(selectedParent)
    if (!parent) return { ok: false, error: 'selected parent is not a valid directory' }
    const target = resolve(parent, safeName)
    const parentWithSep = parent.endsWith(sep) ? parent : `${parent}${sep}`
    if (!target.startsWith(parentWithSep)) return { ok: false, error: 'project folder must be inside the selected parent' }
    try {
      mkdirSync(target)
    } catch (err) {
      try {
        if (!statSync(target).isDirectory()) throw err
      } catch {
        throw err
      }
    }
    return { ok: true, project: ensureProjectForPath(target, safeName, projectId ?? null) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---- IPC ----

export function registerDbIpc(): void {
  ipcMain.handle('history:list', async (): Promise<SessionRow[]> => {
    await ensureDbReady()
    return listSessions()
  })

  ipcMain.handle('history:messages', async (_event, args: { sessionId: string }) => {
    await ensureDbReady()
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) return null
    const session = must().prepare('SELECT * FROM sessions WHERE id = ?').get(args.sessionId) as
      | Record<string, unknown>
      | undefined
    if (!session) return null
    const storedMessages = (
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
        attachments: parseStoredAttachments(r.attachments),
        metadata: parseMessageMetadata(r.metadata),
        createdAt: r.created_at as number
      })
    )
    const messages = await Promise.all(storedMessages.map(async (message) => ({
      ...message,
      attachments: await publicChatAttachments(message.attachments)
    })))
    return { session: toSession(session), messages }
  })

  ipcMain.handle('history:create', async (_event, args: { providerId: string; title: string; projectId?: string | null }) => {
    await ensureDbReady()
    if (
      typeof args?.providerId !== 'string' ||
      !/^[a-z0-9-]{1,32}$/.test(args.providerId) ||
      typeof args.title !== 'string' ||
      (args.projectId !== undefined &&
        args.projectId !== null &&
        (typeof args.projectId !== 'string' || !VALID_ID.test(args.projectId)))
    ) {
      throw new Error('invalid history:create payload')
    }
    return createSession(args.providerId, args.title.slice(0, MAX_TITLE) || 'New chat', args.projectId ?? null)
  })

  ipcMain.handle('history:rename', async (_event, args: { sessionId: string; title: string }) => {
    await ensureDbReady()
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId) || typeof args.title !== 'string') {
      return false
    }
    const title = args.title.slice(0, MAX_TITLE).trim()
    if (!title) return false
    must().prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), args.sessionId)
    return true
  })

  ipcMain.handle('history:pin', async (_event, args: { sessionId: string; pinned: boolean }) => {
    await ensureDbReady()
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId) || typeof args.pinned !== 'boolean') {
      return false
    }
    must().prepare('UPDATE sessions SET pinned = ?, updated_at = ? WHERE id = ?').run(args.pinned ? 1 : 0, Date.now(), args.sessionId)
    return true
  })

  ipcMain.handle('history:delete', async (_event, args: { sessionId: string }) => {
    await ensureDbReady()
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) return false
    must().prepare('DELETE FROM sessions WHERE id = ?').run(args.sessionId) // messages cascade
    await removeSessionAttachments(args.sessionId)
    return true
  })

  // Phase 14.2: reset context for the active session only (keep the session row).
  ipcMain.handle('history:clearMessages', async (_event, args: { sessionId: string }) => {
    await ensureDbReady()
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) return false
    if (!sessionExists(args.sessionId)) return false
    clearSessionMessages(args.sessionId)
    await removeSessionAttachments(args.sessionId)
    return true
  })

  ipcMain.handle('usage:summary', async () => {
    await ensureDbReady()
    return usageSummary()
  })

  ipcMain.handle('usage:daily', async (_event, args: { days: number }) => {
    await ensureDbReady()
    const days = typeof args?.days === 'number' && Number.isFinite(args.days) ? Math.min(Math.max(args.days, 1), 730) : 270
    return usageDaily(days)
  })

  ipcMain.handle('projects:list', async (): Promise<ProjectRow[]> => {
    await ensureDbReady()
    return listProjects()
  })

  ipcMain.handle('projects:openFolder', async (_event, args: { projectId?: string | null }) => {
    await ensureDbReady()
    if (args?.projectId !== undefined && args.projectId !== null && (typeof args.projectId !== 'string' || !VALID_ID.test(args.projectId))) {
      return { ok: false, error: 'invalid projects:openFolder payload' } satisfies ProjectDialogResponse
    }
    return openProjectFolder(args?.projectId ?? null)
  })

  ipcMain.handle('projects:pickDirectory', async () => {
    await ensureDbReady()
    return pickProjectDirectory()
  })

  ipcMain.handle(
    'projects:createFolder',
    async (_event, args: { name: string; projectId?: string | null; parentPath?: string | null }) => {
      await ensureDbReady()
      if (
        typeof args?.name !== 'string' ||
        args.name.length > MAX_PROJECT_NAME ||
        (args.projectId !== undefined &&
          args.projectId !== null &&
          (typeof args.projectId !== 'string' || !VALID_ID.test(args.projectId))) ||
        (args.parentPath !== undefined &&
          args.parentPath !== null &&
          (typeof args.parentPath !== 'string' || args.parentPath.length > MAX_PROJECT_PATH))
      ) {
        return { ok: false, error: 'invalid projects:createFolder payload' } satisfies ProjectDialogResponse
      }
      return createProjectFolder(args.name, args.projectId ?? null, args.parentPath ?? null)
    }
  )

  ipcMain.handle(
    'projects:create',
    async (_event, args: { name: string; path?: string | null; color?: string | null; icon?: string | null }) => {
      await ensureDbReady()
      if (
        typeof args?.name !== 'string' ||
        args.name.trim().length === 0 ||
        args.name.length > MAX_PROJECT_NAME ||
        (args.path !== undefined &&
          args.path !== null &&
          (typeof args.path !== 'string' || args.path.length > MAX_PROJECT_PATH)) ||
        (args.color !== undefined &&
          args.color !== null &&
          (typeof args.color !== 'string' || args.color.length > MAX_PROJECT_META)) ||
        (args.icon !== undefined &&
          args.icon !== null &&
          (typeof args.icon !== 'string' || args.icon.length > MAX_PROJECT_META))
      ) {
        throw new Error('invalid projects:create payload')
      }
      return createProject(args)
    }
  )

  ipcMain.handle(
    'projects:update',
    async (
      _event,
      args: { projectId: string; patch: Partial<Pick<ProjectRow, 'name' | 'path' | 'color' | 'icon'>> }
    ) => {
      await ensureDbReady()
      if (
        typeof args?.projectId !== 'string' ||
        !VALID_ID.test(args.projectId) ||
        typeof args.patch !== 'object' ||
        !args.patch
      ) {
        return null
      }
      const patch = args.patch
      if (
        (patch.name !== undefined && (typeof patch.name !== 'string' || patch.name.length > MAX_PROJECT_NAME)) ||
        (patch.path !== undefined &&
          patch.path !== null &&
          (typeof patch.path !== 'string' || patch.path.length > MAX_PROJECT_PATH)) ||
        (patch.color !== undefined &&
          patch.color !== null &&
          (typeof patch.color !== 'string' || patch.color.length > MAX_PROJECT_META)) ||
        (patch.icon !== undefined &&
          patch.icon !== null &&
          (typeof patch.icon !== 'string' || patch.icon.length > MAX_PROJECT_META))
      ) {
        return null
      }
      return updateProject(args.projectId, patch)
    }
  )

  // Phase 14.3: remove a project from Akorith. Deletes the project + its
  // workspace chats from the local DB only; the folder on disk is untouched.
  ipcMain.handle('projects:delete', async (_event, args: { projectId: string }) => {
    await ensureDbReady()
    if (typeof args?.projectId !== 'string' || !VALID_ID.test(args.projectId)) return false
    return deleteProject(args.projectId)
  })

  // Phase 14.4: reveal a project's folder in Finder/Explorer. Read-only OS
  // action on the stored path — never writes, never runs a command.
  ipcMain.handle('projects:reveal', async (_event, args: { projectId: string }) => {
    await ensureDbReady()
    if (typeof args?.projectId !== 'string' || !VALID_ID.test(args.projectId)) {
      return { ok: false, error: 'invalid projects:reveal payload' }
    }
    const project = getProject(args.projectId)
    if (!project?.path) return { ok: false, error: 'project has no folder on disk' }
    shell.showItemInFolder(project.path)
    return { ok: true }
  })
}
