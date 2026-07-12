import type Database from 'better-sqlite3'
import type { TelemetryBackfillResult } from './types'

export interface SqliteMigration {
  version: number
  name: string
  up(database: Database.Database): void
}

const TELEMETRY_MIGRATION_SCOPE = 'telemetry'
const LEGACY_USAGE_BACKFILL = 'usage_events_v1'

export const TELEMETRY_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: 'unified telemetry events and backfill markers',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_events (
          id                 TEXT PRIMARY KEY,
          ts                 INTEGER NOT NULL,
          created_at         INTEGER NOT NULL,
          kind               TEXT NOT NULL,
          outcome            TEXT NOT NULL,
          correlation_id     TEXT,
          source_key         TEXT,
          provider_id        TEXT,
          model              TEXT,
          execution_location TEXT,
          node_id            TEXT,
          task_type          TEXT,
          reasoning_mode     TEXT,
          duration_ms        INTEGER,
          prompt_tokens      INTEGER NOT NULL DEFAULT 0,
          completion_tokens  INTEGER NOT NULL DEFAULT 0,
          cached_tokens      INTEGER NOT NULL DEFAULT 0,
          cost_usd           REAL NOT NULL DEFAULT 0,
          estimated          INTEGER NOT NULL DEFAULT 0,
          plugin_id          TEXT,
          loop_id            TEXT,
          benchmark_run_id   TEXT,
          repository_id      TEXT,
          entity_id          TEXT,
          metadata_json      TEXT NOT NULL DEFAULT '{}'
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_events_source_key
          ON telemetry_events(source_key) WHERE source_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_ts ON telemetry_events(ts);
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_kind_ts ON telemetry_events(kind, ts);
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_model_ts ON telemetry_events(model, ts);
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_plugin_ts ON telemetry_events(plugin_id, ts);
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_task_ts ON telemetry_events(task_type, ts);
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_correlation ON telemetry_events(correlation_id);

        CREATE TABLE IF NOT EXISTS telemetry_backfill_markers (
          source_name TEXT NOT NULL,
          source_id   TEXT NOT NULL,
          applied_at  INTEGER NOT NULL,
          PRIMARY KEY (source_name, source_id)
        );
      `)
    }
  },
  {
    version: 2,
    name: 'bounded GPU detail samples and durable rollups',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_gpu_samples (
          id                  TEXT PRIMARY KEY,
          ts                  INTEGER NOT NULL,
          node_id             TEXT NOT NULL,
          device_id           TEXT NOT NULL,
          device_name         TEXT NOT NULL,
          utilization_percent REAL,
          memory_used_mb      REAL,
          memory_total_mb     REAL,
          temperature_c       REAL,
          power_watts         REAL,
          model               TEXT,
          process_name        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_telemetry_gpu_samples_ts ON telemetry_gpu_samples(ts);
        CREATE INDEX IF NOT EXISTS idx_telemetry_gpu_samples_device_ts
          ON telemetry_gpu_samples(node_id, device_id, ts);

        CREATE TABLE IF NOT EXISTS telemetry_gpu_rollups (
          bucket_start                INTEGER NOT NULL,
          bucket_ms                   INTEGER NOT NULL,
          node_id                     TEXT NOT NULL,
          device_id                   TEXT NOT NULL,
          device_name                 TEXT NOT NULL,
          sample_count                INTEGER NOT NULL,
          average_utilization_percent REAL,
          peak_utilization_percent    REAL,
          average_memory_used_mb      REAL,
          peak_memory_used_mb         REAL,
          memory_total_mb             REAL,
          average_temperature_c       REAL,
          peak_temperature_c          REAL,
          average_power_watts         REAL,
          peak_power_watts            REAL,
          first_sample_at             INTEGER NOT NULL,
          last_sample_at              INTEGER NOT NULL,
          created_at                  INTEGER NOT NULL,
          PRIMARY KEY (bucket_start, bucket_ms, node_id, device_id)
        );
        CREATE INDEX IF NOT EXISTS idx_telemetry_gpu_rollups_bucket
          ON telemetry_gpu_rollups(bucket_start);
      `)
    }
  }
] as const

function ensureMigrationLedger(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      scope      TEXT NOT NULL,
      version    INTEGER NOT NULL,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY (scope, version)
    );
  `)
}

/** Apply each additive migration once, transactionally and in version order. */
export function applyTelemetryMigrations(database: Database.Database): number[] {
  ensureMigrationLedger(database)
  const applied = new Set(
    (
      database
        .prepare('SELECT version FROM schema_migrations WHERE scope = ? ORDER BY version')
        .all(TELEMETRY_MIGRATION_SCOPE) as { version: number }[]
    ).map((row) => row.version)
  )
  const migrations = [...TELEMETRY_MIGRATIONS].sort((a, b) => a.version - b.version)
  const seen = new Set<number>()
  const newlyApplied: number[] = []
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0 || seen.has(migration.version)) {
      throw new Error(`invalid or duplicate telemetry migration version: ${migration.version}`)
    }
    seen.add(migration.version)
    if (applied.has(migration.version)) continue
    database.transaction(() => {
      migration.up(database)
      database
        .prepare('INSERT INTO schema_migrations (scope, version, name, applied_at) VALUES (?, ?, ?, ?)')
        .run(TELEMETRY_MIGRATION_SCOPE, migration.version, migration.name, Date.now())
    })()
    newlyApplied.push(migration.version)
  }
  return newlyApplied
}

interface LegacyUsageRow {
  id: string
  ts: number
  provider_id: string
  model: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  cost_usd: number | null
  estimated: number
  session_id: string | null
}

function tableExists(database: Database.Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

function locationForLegacyProvider(providerId: string): 'local' | 'cloud' {
  return /local|ollama/i.test(providerId) ? 'local' : 'cloud'
}

/**
 * Idempotently translate old usage rows into a model lifecycle event plus the
 * canonical token event. Per-row markers allow a bounded backfill to resume
 * safely after a crash without duplicating totals.
 */
export function backfillUsageEvents(
  database: Database.Database,
  options: { batchSize?: number; maxRows?: number } = {}
): TelemetryBackfillResult {
  if (!tableExists(database, 'usage_events')) return { source: 'usage_events', processed: 0, remaining: 0 }
  applyTelemetryMigrations(database)
  const batchSize = Math.min(Math.max(Math.trunc(options.batchSize ?? 1_000), 1), 10_000)
  const maxRows = Math.min(Math.max(Math.trunc(options.maxRows ?? 100_000), 1), 1_000_000)
  const select = database.prepare(
    `SELECT u.id, u.ts, u.provider_id, u.model, u.prompt_tokens, u.completion_tokens,
            u.cost_usd, u.estimated, u.session_id
       FROM usage_events u
      WHERE NOT EXISTS (
        SELECT 1 FROM telemetry_backfill_markers b
         WHERE b.source_name = ? AND b.source_id = u.id
      )
      ORDER BY u.ts, u.id
      LIMIT ?`
  )
  const insertEvent = database.prepare(
    `INSERT OR IGNORE INTO telemetry_events (
       id, ts, created_at, kind, outcome, correlation_id, source_key,
       provider_id, model, execution_location, node_id, task_type, reasoning_mode,
       duration_ms, prompt_tokens, completion_tokens, cached_tokens, cost_usd,
       estimated, plugin_id, loop_id, benchmark_run_id, repository_id, entity_id, metadata_json
     ) VALUES (
       @id, @ts, @created_at, @kind, @outcome, @correlation_id, @source_key,
       @provider_id, @model, @execution_location, NULL, 'chat', 'unknown',
       NULL, @prompt_tokens, @completion_tokens, 0, @cost_usd,
       @estimated, NULL, NULL, NULL, NULL, @entity_id, @metadata_json
     )`
  )
  const mark = database.prepare(
    'INSERT OR IGNORE INTO telemetry_backfill_markers (source_name, source_id, applied_at) VALUES (?, ?, ?)'
  )
  let processed = 0
  while (processed < maxRows) {
    const limit = Math.min(batchSize, maxRows - processed)
    const rows = select.all(LEGACY_USAGE_BACKFILL, limit) as LegacyUsageRow[]
    if (rows.length === 0) break
    database.transaction(() => {
      for (const row of rows) {
        const correlationId = `legacy-usage:${row.id}`
        const base = {
          ts: Number.isSafeInteger(row.ts) && row.ts >= 0 ? row.ts : Date.now(),
          created_at: Date.now(),
          outcome: 'completed',
          correlation_id: correlationId,
          provider_id: row.provider_id || null,
          model: row.model,
          execution_location: locationForLegacyProvider(row.provider_id),
          entity_id: row.session_id,
          estimated: row.estimated === 1 ? 1 : 0,
          metadata_json: JSON.stringify({ backfilledFrom: 'usage_events', legacyUsageId: row.id })
        }
        insertEvent.run({
          ...base,
          id: `legacy-usage-completed:${row.id}`,
          kind: 'model_request_completed',
          source_key: `usage_events:${row.id}:completed`,
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0
        })
        insertEvent.run({
          ...base,
          id: `legacy-usage-tokens:${row.id}`,
          kind: 'token_usage',
          source_key: `usage_events:${row.id}:tokens`,
          prompt_tokens: Math.max(0, Math.trunc(row.prompt_tokens ?? 0)),
          completion_tokens: Math.max(0, Math.trunc(row.completion_tokens ?? 0)),
          cost_usd: Math.max(0, row.cost_usd ?? 0)
        })
        mark.run(LEGACY_USAGE_BACKFILL, row.id, Date.now())
      }
    })()
    processed += rows.length
    if (rows.length < limit) break
  }
  const remaining = Number(
    (
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM usage_events u
            WHERE NOT EXISTS (
              SELECT 1 FROM telemetry_backfill_markers b
               WHERE b.source_name = ? AND b.source_id = u.id
            )`
        )
        .get(LEGACY_USAGE_BACKFILL) as { count: number }
    ).count
  )
  return { source: 'usage_events', processed, remaining }
}
