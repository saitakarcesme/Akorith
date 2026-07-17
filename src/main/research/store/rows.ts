import type {
  ResearchArtifact,
  ResearchCycle,
  ResearchEvent,
  ResearchJob,
  ResearchPlan,
  ResearchSource
} from '../types'

export type DbRow = Record<string, unknown>

export function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function optionalNumber(value: unknown): number | undefined {
  return value == null ? undefined : numberValue(value)
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

export function rowToResearchJob(row: DbRow): ResearchJob {
  return {
    id: String(row.id),
    title: String(row.title),
    prompt: String(row.prompt),
    status: String(row.status) as ResearchJob['status'],
    phase: String(row.phase) as ResearchJob['phase'],
    providerId: String(row.provider_id),
    model: optionalString(row.model),
    depth: String(row.depth) as ResearchJob['depth'],
    outputFormat: String(row.output_format) as ResearchJob['outputFormat'],
    targetDurationMs: numberValue(row.target_duration_ms),
    maxCycles: numberValue(row.max_cycles),
    sourceTarget: numberValue(row.source_target),
    cycleCount: numberValue(row.cycle_count),
    sourceCount: numberValue(row.source_count),
    findingCount: numberValue(row.finding_count),
    workspaceDir: String(row.workspace_dir),
    artifactPath: optionalString(row.artifact_path),
    coverPath: optionalString(row.cover_path),
    plan: parseJson<ResearchPlan>(row.plan_json),
    summary: optionalString(row.summary),
    error: optionalString(row.error),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    startedAt: optionalNumber(row.started_at),
    completedAt: optionalNumber(row.completed_at),
    nextRunAt: optionalNumber(row.next_run_at)
  }
}

export function rowToResearchCycle(row: DbRow): ResearchCycle {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    cycleIndex: numberValue(row.cycle_index),
    phase: String(row.phase) as ResearchCycle['phase'],
    status: String(row.status) as ResearchCycle['status'],
    objective: String(row.objective),
    result: optionalString(row.result),
    sourceCount: numberValue(row.source_count),
    findingCount: numberValue(row.finding_count),
    promptTokens: optionalNumber(row.prompt_tokens),
    completionTokens: optionalNumber(row.completion_tokens),
    startedAt: numberValue(row.started_at),
    endedAt: optionalNumber(row.ended_at),
    error: optionalString(row.error)
  }
}

export function rowToResearchEvent(row: DbRow): ResearchEvent {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    cycleId: optionalString(row.cycle_id),
    kind: String(row.kind) as ResearchEvent['kind'],
    title: String(row.title),
    detail: optionalString(row.detail),
    createdAt: numberValue(row.created_at)
  }
}

export function rowToResearchSource(row: DbRow): ResearchSource {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    cycleId: optionalString(row.cycle_id),
    url: String(row.url),
    title: String(row.title),
    publisher: optionalString(row.publisher),
    publishedAt: optionalString(row.published_at),
    accessedAt: numberValue(row.accessed_at),
    excerpt: optionalString(row.excerpt),
    relevance: optionalString(row.relevance),
    credibilityScore: optionalNumber(row.credibility_score),
    contentHash: optionalString(row.content_hash),
    verified: numberValue(row.verified) === 1
  }
}

export function rowToResearchArtifact(row: DbRow): ResearchArtifact {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    format: String(row.format) as ResearchArtifact['format'],
    title: String(row.title),
    path: String(row.path),
    coverPath: optionalString(row.cover_path),
    byteSize: numberValue(row.byte_size),
    createdAt: numberValue(row.created_at)
  }
}
