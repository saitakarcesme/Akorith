import type Database from 'better-sqlite3'
import { validateProbeRecord } from './probes'
import { validateRoutingProfile } from './routing'
import type { ModelCapabilityProbeRecord, ModelCatalog, RoutingProfile } from './types'

export class ModelCatalogStore {
  constructor(private readonly database: Database.Database) {}

  saveProbe(value: unknown): ModelCapabilityProbeRecord {
    const validated = validateProbeRecord(value)
    if (!validated.ok) throw new Error(`Invalid capability probe: ${validated.errors.join('; ')}`)
    const record = validated.record
    this.database.prepare(`
      INSERT INTO model_capability_probes (
        id, catalog_model_id, probe_kind, status, started_at, completed_at, fresh_until,
        provider_id, model_name, source, node_id, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        completed_at=excluded.completed_at,
        fresh_until=excluded.fresh_until,
        record_json=excluded.record_json
    `).run(
      record.id, record.catalogModelId, record.probeKind, record.status, record.startedAt,
      record.completedAt, record.freshUntil, record.providerId, record.modelName,
      record.source, record.nodeId, JSON.stringify(record)
    )
    return record
  }

  listProbes(catalogModelId?: string, limit = 1_000): ModelCapabilityProbeRecord[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 5_000))
    const rows = catalogModelId
      ? this.database.prepare(
          'SELECT record_json FROM model_capability_probes WHERE catalog_model_id = ? ORDER BY started_at DESC LIMIT ?'
        ).all(catalogModelId, bounded)
      : this.database.prepare(
          'SELECT record_json FROM model_capability_probes ORDER BY started_at DESC LIMIT ?'
        ).all(bounded)
    return (rows as { record_json: string }[]).flatMap((row) => {
      try {
        const validated = validateProbeRecord(JSON.parse(row.record_json))
        return validated.ok ? [validated.record] : []
      } catch {
        return []
      }
    })
  }

  pruneExpiredProbes(now = Date.now(), retainMs = 180 * 24 * 60 * 60_000): number {
    const threshold = now - retainMs
    return this.database.prepare(
      'DELETE FROM model_capability_probes WHERE completed_at IS NOT NULL AND completed_at < ?'
    ).run(threshold).changes
  }

  saveRoutingProfile(value: unknown, catalog: ModelCatalog, now = Date.now()): RoutingProfile {
    const validated = validateRoutingProfile(value, catalog, now)
    if (!validated.ok) throw new Error(`Invalid routing profile: ${validated.issues.map((issue) => issue.message).join('; ')}`)
    const profile = validated.profile
    this.database.prepare(`
      INSERT INTO model_routing_profiles (id, name, created_at, updated_at, profile_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, updated_at=excluded.updated_at, profile_json=excluded.profile_json
    `).run(profile.id, profile.name, profile.createdAt, profile.updatedAt, JSON.stringify(profile))
    return profile
  }

  listRoutingProfiles(): RoutingProfile[] {
    return (this.database.prepare(
      'SELECT profile_json FROM model_routing_profiles ORDER BY updated_at DESC'
    ).all() as { profile_json: string }[]).flatMap((row) => {
      try {
        const value = JSON.parse(row.profile_json) as RoutingProfile
        return value?.schemaVersion === 1 ? [value] : []
      } catch {
        return []
      }
    })
  }
}
