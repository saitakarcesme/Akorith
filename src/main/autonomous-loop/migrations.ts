import type Database from 'better-sqlite3'

const SCOPE = 'autonomous_loop'

interface LoopMigration {
  version: number
  name: string
  up(database: Database.Database): void
}

const MIGRATIONS: readonly LoopMigration[] = [
  {
    version: 1,
    name: 'persistent autonomous loop engine',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS autonomous_loops (
          id TEXT PRIMARY KEY,
          project_name TEXT NOT NULL,
          status TEXT NOT NULL,
          stage TEXT NOT NULL,
          repository_id TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          remote_url TEXT NOT NULL,
          branch TEXT NOT NULL,
          executor_json TEXT NOT NULL,
          planner_json TEXT NOT NULL,
          limits_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER,
          paused_at INTEGER,
          stopped_at INTEGER,
          completed_at INTEGER,
          last_activity_at INTEGER,
          next_cycle_at INTEGER,
          active_cycle_id TEXT,
          consecutive_infrastructure_failures INTEGER NOT NULL DEFAULT 0,
          token_usage_json TEXT NOT NULL,
          commit_count INTEGER NOT NULL DEFAULT 0,
          push_count INTEGER NOT NULL DEFAULT 0,
          successful_tasks INTEGER NOT NULL DEFAULT 0,
          failed_tasks INTEGER NOT NULL DEFAULT 0,
          stop_reason TEXT,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_autonomous_loops_status
          ON autonomous_loops(status, updated_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomous_loops_running_repository
          ON autonomous_loops(repository_id)
          WHERE status IN ('setting_up', 'running', 'pausing', 'paused', 'stopping');

        CREATE TABLE IF NOT EXISTS autonomous_loop_cycles (
          id TEXT PRIMARY KEY,
          loop_id TEXT NOT NULL REFERENCES autonomous_loops(id) ON DELETE CASCADE,
          cycle_index INTEGER NOT NULL,
          status TEXT NOT NULL,
          stage TEXT NOT NULL,
          planned_task_json TEXT,
          executor_catalog_id TEXT NOT NULL,
          executor_provider_id TEXT NOT NULL,
          executor_model TEXT NOT NULL,
          planner_catalog_id TEXT NOT NULL,
          planner_provider_id TEXT NOT NULL,
          planner_model TEXT NOT NULL,
          reviewer_catalog_id TEXT,
          reviewer_provider_id TEXT,
          reviewer_model TEXT,
          repair_attempts INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER,
          finished_at INTEGER,
          duration_ms INTEGER,
          validation_json TEXT,
          review_json TEXT,
          changed_files_json TEXT NOT NULL DEFAULT '[]',
          commit_sha TEXT,
          commit_message TEXT,
          pushed INTEGER NOT NULL DEFAULT 0,
          token_usage_json TEXT NOT NULL,
          summary TEXT,
          error TEXT,
          UNIQUE(loop_id, cycle_index)
        );
        CREATE INDEX IF NOT EXISTS idx_autonomous_loop_cycles_loop
          ON autonomous_loop_cycles(loop_id, cycle_index DESC);

        CREATE TABLE IF NOT EXISTS autonomous_loop_snapshots (
          id TEXT PRIMARY KEY,
          loop_id TEXT NOT NULL REFERENCES autonomous_loops(id) ON DELETE CASCADE,
          cycle_id TEXT REFERENCES autonomous_loop_cycles(id) ON DELETE SET NULL,
          captured_at INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_autonomous_loop_snapshots_loop
          ON autonomous_loop_snapshots(loop_id, captured_at DESC);

        CREATE TABLE IF NOT EXISTS autonomous_loop_inventories (
          id TEXT PRIMARY KEY,
          loop_id TEXT NOT NULL REFERENCES autonomous_loops(id) ON DELETE CASCADE,
          cycle_id TEXT REFERENCES autonomous_loop_cycles(id) ON DELETE SET NULL,
          generated_at INTEGER NOT NULL,
          inventory_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_autonomous_loop_inventories_loop
          ON autonomous_loop_inventories(loop_id, generated_at DESC);

        CREATE TABLE IF NOT EXISTS autonomous_loop_events (
          id TEXT PRIMARY KEY,
          loop_id TEXT NOT NULL REFERENCES autonomous_loops(id) ON DELETE CASCADE,
          cycle_id TEXT REFERENCES autonomous_loop_cycles(id) ON DELETE SET NULL,
          occurred_at INTEGER NOT NULL,
          stage TEXT NOT NULL,
          level TEXT NOT NULL,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          details_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_autonomous_loop_events_loop
          ON autonomous_loop_events(loop_id, occurred_at DESC);

        CREATE TABLE IF NOT EXISTS autonomous_loop_commands (
          id TEXT PRIMARY KEY,
          loop_id TEXT NOT NULL REFERENCES autonomous_loops(id) ON DELETE CASCADE,
          cycle_id TEXT NOT NULL REFERENCES autonomous_loop_cycles(id) ON DELETE CASCADE,
          attempt_index INTEGER NOT NULL,
          command_index INTEGER NOT NULL,
          kind TEXT NOT NULL,
          command TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          exit_code INTEGER,
          timed_out INTEGER NOT NULL DEFAULT 0,
          stdout TEXT NOT NULL,
          stderr TEXT NOT NULL,
          UNIQUE(cycle_id, attempt_index, command_index)
        );
        CREATE INDEX IF NOT EXISTS idx_autonomous_loop_commands_cycle
          ON autonomous_loop_commands(cycle_id, attempt_index, command_index);

        CREATE TABLE IF NOT EXISTS autonomous_loop_model_calls (
          id TEXT PRIMARY KEY,
          loop_id TEXT NOT NULL REFERENCES autonomous_loops(id) ON DELETE CASCADE,
          cycle_id TEXT REFERENCES autonomous_loop_cycles(id) ON DELETE SET NULL,
          occurred_at INTEGER NOT NULL,
          role TEXT NOT NULL,
          attempt_index INTEGER NOT NULL DEFAULT 0,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          catalog_id TEXT NOT NULL,
          location TEXT NOT NULL,
          node_id TEXT,
          duration_ms INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cached_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          estimated INTEGER NOT NULL DEFAULT 0,
          outcome TEXT NOT NULL,
          error_code TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_autonomous_loop_model_calls_loop
          ON autonomous_loop_model_calls(loop_id, occurred_at DESC);

        CREATE TABLE IF NOT EXISTS autonomous_loop_repository_leases (
          repository_id TEXT PRIMARY KEY,
          loop_id TEXT NOT NULL UNIQUE REFERENCES autonomous_loops(id) ON DELETE CASCADE,
          acquired_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          process_id INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_autonomous_loop_repository_leases_expiry
          ON autonomous_loop_repository_leases(expires_at);

        CREATE TABLE IF NOT EXISTS autonomous_loop_legacy_imports (
          source_kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          loop_id TEXT NOT NULL REFERENCES autonomous_loops(id) ON DELETE CASCADE,
          imported_at INTEGER NOT NULL,
          PRIMARY KEY(source_kind, source_id)
        );
      `)
    }
  }
]

function ensureMigrationLedger(database: Database.Database): void {
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

export function applyAutonomousLoopMigrations(database: Database.Database): number[] {
  ensureMigrationLedger(database)
  const applied = new Set(
    (database.prepare('SELECT version FROM schema_migrations WHERE scope = ?').all(SCOPE) as { version: number }[])
      .map((row) => row.version)
  )
  const completed: number[] = []
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    database.transaction(() => {
      migration.up(database)
      database.prepare(
        'INSERT INTO schema_migrations (scope, version, name, applied_at) VALUES (?, ?, ?, ?)'
      ).run(SCOPE, migration.version, migration.name, Date.now())
    })()
    completed.push(migration.version)
  }
  return completed
}
