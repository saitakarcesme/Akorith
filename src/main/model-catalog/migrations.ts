import type Database from 'better-sqlite3'

const SCOPE = 'model_catalog'

export function applyModelCatalogMigrations(database: Database.Database): boolean {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      scope TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY(scope, version)
    );
  `)
  const existing = database.prepare(
    'SELECT 1 FROM schema_migrations WHERE scope = ? AND version = 1'
  ).get(SCOPE)
  if (existing) return false
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS model_capability_probes (
        id TEXT PRIMARY KEY,
        catalog_model_id TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        fresh_until INTEGER,
        provider_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        source TEXT NOT NULL,
        node_id TEXT,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_capability_probes_model
        ON model_capability_probes(catalog_model_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_model_capability_probes_freshness
        ON model_capability_probes(status, fresh_until);

      CREATE TABLE IF NOT EXISTS model_routing_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        profile_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_routing_profiles_updated
        ON model_routing_profiles(updated_at DESC);
    `)
    database.prepare(
      'INSERT INTO schema_migrations (scope, version, name, applied_at) VALUES (?, 1, ?, ?)'
    ).run(SCOPE, 'capability probes and routing profiles', Date.now())
  })()
  return true
}
