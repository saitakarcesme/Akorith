import type Database from 'better-sqlite3'
import type { BenchmarkModelRun, BenchmarkSuite } from './types'
import { validateBenchmarkModelRun, validateBenchmarkSuite } from './validation'

interface JsonRow { suite_json?: string; run_json?: string }

function boundedLimit(value: number, max = 5_000): number {
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), max) : 100
}

export class BenchmarkStore {
  constructor(private readonly database: Database.Database) {}

  saveSuite(value: unknown): BenchmarkSuite {
    const parsed = validateBenchmarkSuite(value)
    if (!parsed.ok) throw new Error(`Invalid benchmark suite: ${parsed.errors.join('; ')}`)
    const suite = parsed.value
    const existing = this.database.prepare(
      'SELECT suite_json FROM benchmark_lab_suites WHERE id = ? AND revision = ?'
    ).get(suite.id, suite.revision) as JsonRow | undefined
    if (existing?.suite_json) {
      const persisted = this.parseSuite(existing)
      if (!persisted || JSON.stringify(persisted) !== JSON.stringify(suite)) {
        throw new Error('A published benchmark suite revision is immutable; publish a new revision instead.')
      }
      return persisted
    }
    this.database.prepare(`
      INSERT INTO benchmark_lab_suites (
        id, revision, schema_version, name, seed, fixture_count, created_at, suite_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(suite.id, suite.revision, suite.schemaVersion, suite.name, suite.seed, suite.fixtures.length, suite.createdAt, JSON.stringify(suite))
    return suite
  }

  getSuite(id: string, revision?: number): BenchmarkSuite | null {
    const row = revision === undefined
      ? this.database.prepare('SELECT suite_json FROM benchmark_lab_suites WHERE id = ? ORDER BY revision DESC LIMIT 1').get(id)
      : this.database.prepare('SELECT suite_json FROM benchmark_lab_suites WHERE id = ? AND revision = ?').get(id, revision)
    return this.parseSuite(row as JsonRow | undefined)
  }

  listSuites(limit = 100): BenchmarkSuite[] {
    return (this.database.prepare('SELECT suite_json FROM benchmark_lab_suites ORDER BY created_at DESC, id, revision DESC LIMIT ?')
      .all(boundedLimit(limit)) as JsonRow[]).flatMap((row) => {
        const suite = this.parseSuite(row)
        return suite ? [suite] : []
      })
  }

  saveModelRun(value: unknown): BenchmarkModelRun {
    const raw = value as Partial<BenchmarkModelRun> | null
    const suite = raw?.suiteId && Number.isSafeInteger(raw.suiteRevision)
      ? this.getSuite(raw.suiteId, raw.suiteRevision)
      : null
    if (!suite) throw new Error('Benchmark run references a suite revision that is not persisted.')
    const parsed = validateBenchmarkModelRun(value, suite)
    if (!parsed.ok) throw new Error(`Invalid benchmark model run: ${parsed.errors.join('; ')}`)
    const run = parsed.value
    const existing = this.getModelRun(run.id)
    if (existing) {
      const sameIdentity =
        existing.suiteId === run.suiteId &&
        existing.suiteRevision === run.suiteRevision &&
        existing.suiteSeed === run.suiteSeed &&
        existing.mode === run.mode &&
        existing.compatibilityKey === run.compatibilityKey &&
        existing.target.catalogModelId === run.target.catalogModelId &&
        existing.target.providerId === run.target.providerId &&
        existing.target.model === run.target.model &&
        existing.target.location === run.target.location &&
        existing.target.nodeId === run.target.nodeId &&
        existing.startedAt === run.startedAt
      if (!sameIdentity) throw new Error('Benchmark model-run identity is immutable.')
      if (existing.status !== 'running' && JSON.stringify(existing) !== JSON.stringify(run)) {
        throw new Error('A terminal benchmark model run is immutable.')
      }
      const priorFixtureIds = existing.fixtureRuns.map((fixture) => fixture.id)
      if (priorFixtureIds.some((id, index) => run.fixtureRuns[index]?.id !== id)) {
        throw new Error('Benchmark fixture-run history is append-only.')
      }
    }
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO benchmark_lab_model_runs (
          id, schema_version, suite_id, suite_revision, suite_seed, mode, catalog_model_id,
          compatibility_key, harness_version, repetition_index, repetition_count,
          provider_id, model, location, node_id, status, started_at, finished_at, updated_at, run_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status=excluded.status,
          finished_at=excluded.finished_at,
          updated_at=excluded.updated_at,
          run_json=excluded.run_json
      `).run(
        run.id, run.schemaVersion, run.suiteId, run.suiteRevision, run.suiteSeed, run.mode,
        run.target.catalogModelId, run.compatibilityKey, run.configuration.harnessVersion,
        run.configuration.repetitionIndex, run.configuration.repetitionCount,
        run.target.providerId, run.target.model, run.target.location,
        run.target.nodeId, run.status, run.startedAt, run.finishedAt, Date.now(), JSON.stringify(run)
      )
      const upsertFixture = this.database.prepare(`
        INSERT INTO benchmark_lab_fixture_runs (
          id, model_run_id, fixture_id, category, status, duration_ms, finished_at,
          evidence_valid, fixture_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status=excluded.status,
          duration_ms=excluded.duration_ms,
          finished_at=excluded.finished_at,
          evidence_valid=excluded.evidence_valid,
          fixture_json=excluded.fixture_json
      `)
      for (const fixture of run.fixtureRuns) {
        upsertFixture.run(
          fixture.id, run.id, fixture.fixtureId, fixture.category, fixture.status,
          fixture.durationMs, fixture.finishedAt, fixture.status === 'completed' && fixture.evidence ? 1 : 0,
          JSON.stringify(fixture)
        )
      }
    })()
    return run
  }

  getModelRun(id: string): BenchmarkModelRun | null {
    const row = this.database.prepare('SELECT run_json FROM benchmark_lab_model_runs WHERE id = ?').get(id) as JsonRow | undefined
    return this.parseRun(row)
  }

  listModelRuns(options: { suiteId?: string; catalogModelId?: string; limit?: number } = {}): BenchmarkModelRun[] {
    const clauses: string[] = []
    const parameters: Array<string | number> = []
    if (options.suiteId) {
      clauses.push('suite_id = ?')
      parameters.push(options.suiteId)
    }
    if (options.catalogModelId) {
      clauses.push('catalog_model_id = ?')
      parameters.push(options.catalogModelId)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    parameters.push(boundedLimit(options.limit ?? 100))
    return (this.database.prepare(`SELECT run_json FROM benchmark_lab_model_runs ${where} ORDER BY started_at DESC LIMIT ?`)
      .all(...parameters) as JsonRow[]).flatMap((row) => {
        const run = this.parseRun(row)
        return run ? [run] : []
      })
  }

  private parseSuite(row: JsonRow | undefined): BenchmarkSuite | null {
    if (!row?.suite_json) return null
    try {
      const parsed = validateBenchmarkSuite(JSON.parse(row.suite_json))
      return parsed.ok ? parsed.value : null
    } catch {
      return null
    }
  }

  private parseRun(row: JsonRow | undefined): BenchmarkModelRun | null {
    if (!row?.run_json) return null
    try {
      const raw = JSON.parse(row.run_json) as Partial<BenchmarkModelRun>
      const suite = typeof raw.suiteId === 'string' && Number.isSafeInteger(raw.suiteRevision)
        ? this.getSuite(raw.suiteId, raw.suiteRevision)
        : null
      if (!suite) return null
      const parsed = validateBenchmarkModelRun(raw, suite)
      return parsed.ok ? parsed.value : null
    } catch {
      return null
    }
  }
}
