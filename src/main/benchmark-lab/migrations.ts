import type Database from 'better-sqlite3'

export interface BenchmarkMigration {
  version: number
  name: string
  up(database: Database.Database): void
}

const SCOPE = 'benchmark_lab'

export const BENCHMARK_MIGRATIONS: readonly BenchmarkMigration[] = [
  {
    version: 1,
    name: 'versioned benchmark suites and model runs',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS benchmark_lab_suites (
          id            TEXT NOT NULL,
          revision      INTEGER NOT NULL,
          schema_version INTEGER NOT NULL,
          name          TEXT NOT NULL,
          seed          INTEGER NOT NULL,
          fixture_count INTEGER NOT NULL,
          created_at    INTEGER NOT NULL,
          suite_json    TEXT NOT NULL,
          PRIMARY KEY (id, revision)
        );
        CREATE INDEX IF NOT EXISTS idx_benchmark_lab_suites_created
          ON benchmark_lab_suites(created_at DESC);

        CREATE TABLE IF NOT EXISTS benchmark_lab_model_runs (
          id               TEXT PRIMARY KEY,
          schema_version   INTEGER NOT NULL,
          suite_id         TEXT NOT NULL,
          suite_revision   INTEGER NOT NULL,
          suite_seed       INTEGER NOT NULL,
          mode             TEXT NOT NULL,
          compatibility_key TEXT NOT NULL,
          harness_version  TEXT NOT NULL,
          repetition_index INTEGER NOT NULL,
          repetition_count INTEGER NOT NULL,
          catalog_model_id TEXT NOT NULL,
          provider_id      TEXT NOT NULL,
          model            TEXT NOT NULL,
          location         TEXT NOT NULL,
          node_id          TEXT,
          status           TEXT NOT NULL,
          started_at       INTEGER NOT NULL,
          finished_at      INTEGER,
          updated_at       INTEGER NOT NULL,
          run_json         TEXT NOT NULL,
          FOREIGN KEY (suite_id, suite_revision)
            REFERENCES benchmark_lab_suites(id, revision)
        );
        CREATE INDEX IF NOT EXISTS idx_benchmark_lab_runs_suite
          ON benchmark_lab_model_runs(suite_id, suite_revision, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_benchmark_lab_runs_model
          ON benchmark_lab_model_runs(catalog_model_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_benchmark_lab_runs_status
          ON benchmark_lab_model_runs(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_benchmark_lab_runs_compatibility
          ON benchmark_lab_model_runs(suite_id, suite_revision, suite_seed, compatibility_key);

        CREATE TABLE IF NOT EXISTS benchmark_lab_fixture_runs (
          id             TEXT PRIMARY KEY,
          model_run_id   TEXT NOT NULL,
          fixture_id     TEXT NOT NULL,
          category       TEXT NOT NULL,
          status         TEXT NOT NULL,
          duration_ms    REAL NOT NULL,
          finished_at    INTEGER NOT NULL,
          evidence_valid INTEGER NOT NULL,
          fixture_json   TEXT NOT NULL,
          FOREIGN KEY (model_run_id) REFERENCES benchmark_lab_model_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_benchmark_lab_fixture_runs_model
          ON benchmark_lab_fixture_runs(model_run_id, category);
      `)
    }
  }
] as const

function ensureLedger(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      scope TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY(scope, version)
    );
  `)
}

export function applyBenchmarkMigrations(database: Database.Database): number[] {
  ensureLedger(database)
  const applied = new Set(
    (database.prepare('SELECT version FROM schema_migrations WHERE scope = ?').all(SCOPE) as { version: number }[])
      .map((row) => row.version)
  )
  const seen = new Set<number>()
  const newlyApplied: number[] = []
  for (const migration of [...BENCHMARK_MIGRATIONS].sort((left, right) => left.version - right.version)) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1 || seen.has(migration.version)) {
      throw new Error(`Invalid or duplicate benchmark migration version ${migration.version}.`)
    }
    seen.add(migration.version)
    if (applied.has(migration.version)) continue
    database.transaction(() => {
      migration.up(database)
      database.prepare('INSERT INTO schema_migrations (scope, version, name, applied_at) VALUES (?, ?, ?, ?)')
        .run(SCOPE, migration.version, migration.name, Date.now())
    })()
    newlyApplied.push(migration.version)
  }
  return newlyApplied
}
