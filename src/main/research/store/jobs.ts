import { randomUUID } from 'crypto'
import { getDb } from '../../db'
import {
  RESEARCH_DEPTH_PROFILES,
  RESEARCH_DEPTHS,
  RESEARCH_OUTPUT_FORMATS,
  RESEARCH_PHASES,
  RESEARCH_STATUSES,
  type CreateResearchJobInput,
  type ResearchJob
} from '../types'
import { rowToResearchJob, type DbRow } from './rows'
import { recordResearchRequest } from '../usage'

const MAX_PROMPT_LENGTH = 120_000
const MAX_TITLE_LENGTH = 160

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/).find(Boolean) ?? 'Untitled research'
  return normalizeResearchTitle(firstLine).slice(0, 80) || 'Untitled research'
}

function normalizeResearchTitle(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function validateCreateResearchJobInput(input: CreateResearchJobInput): void {
  if (!input || typeof input !== 'object') throw new Error('invalid research input')
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error('Research request must be between 1 and 120,000 characters.')
  }
  if (typeof input.providerId !== 'string' || !/^[a-z0-9-]{1,32}$/.test(input.providerId)) {
    throw new Error('invalid research provider')
  }
  if (input.model !== undefined && !/^[\w.:/-]{1,64}$/.test(input.model)) {
    throw new Error('invalid research model')
  }
  if (!RESEARCH_DEPTHS.includes(input.depth)) throw new Error('invalid research depth')
  if (!RESEARCH_OUTPUT_FORMATS.includes(input.outputFormat)) throw new Error('invalid research output format')
}

export function createResearchJob(
  input: CreateResearchJobInput,
  workspaceDir: string,
  id = randomUUID()
): ResearchJob {
  validateCreateResearchJobInput(input)
  const now = Date.now()
  const profile = RESEARCH_DEPTH_PROFILES[input.depth]
  const title = (normalizeResearchTitle(input.title ?? '') || titleFromPrompt(input.prompt)).slice(0, MAX_TITLE_LENGTH)
  const status = input.autoStart === false ? 'draft' : 'planning'
  getDb().prepare(
    `INSERT INTO research_jobs (
      id, title, prompt, status, phase, provider_id, model, depth, output_format,
      target_duration_ms, max_cycles, source_target, cycle_count, source_count,
      finding_count, workspace_dir, created_at, updated_at, started_at, next_run_at
    ) VALUES (
      @id, @title, @prompt, @status, 'understand', @provider_id, @model, @depth, @output_format,
      @target_duration_ms, @max_cycles, @source_target, 0, 0, 0, @workspace_dir,
      @created_at, @updated_at, @started_at, @next_run_at
    )`
  ).run({
    id,
    title,
    prompt: input.prompt.trim(),
    status,
    provider_id: input.providerId,
    model: input.model ?? null,
    depth: input.depth,
    output_format: input.outputFormat,
    target_duration_ms: profile.targetDurationMs,
    max_cycles: profile.maxCycles,
    source_target: profile.sourceTarget,
    workspace_dir: workspaceDir,
    created_at: now,
    updated_at: now,
    started_at: input.autoStart === false ? null : now,
    next_run_at: input.autoStart === false ? null : now
  })
  const job = getResearchJob(id)!
  recordResearchRequest(job)
  return job
}

export function getResearchJob(id: string): ResearchJob | null {
  const row = getDb().prepare('SELECT * FROM research_jobs WHERE id = ?').get(id) as DbRow | undefined
  return row ? rowToResearchJob(row) : null
}

export function listResearchJobs(options: { includeArchived?: boolean; limit?: number } = {}): ResearchJob[] {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1_000)
  const rows = options.includeArchived
    ? getDb().prepare('SELECT * FROM research_jobs ORDER BY updated_at DESC LIMIT ?').all(limit)
    : getDb().prepare("SELECT * FROM research_jobs WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT ?").all(limit)
  return (rows as DbRow[]).map(rowToResearchJob)
}

const UPDATE_COLUMNS: Record<string, string> = {
  title: 'title',
  status: 'status',
  phase: 'phase',
  providerId: 'provider_id',
  model: 'model',
  depth: 'depth',
  outputFormat: 'output_format',
  targetDurationMs: 'target_duration_ms',
  maxCycles: 'max_cycles',
  sourceTarget: 'source_target',
  cycleCount: 'cycle_count',
  sourceCount: 'source_count',
  findingCount: 'finding_count',
  artifactPath: 'artifact_path',
  coverPath: 'cover_path',
  plan: 'plan_json',
  summary: 'summary',
  error: 'error',
  startedAt: 'started_at',
  completedAt: 'completed_at',
  nextRunAt: 'next_run_at'
}

export function updateResearchJob(id: string, patch: Partial<ResearchJob>): ResearchJob | null {
  if ('status' in patch && patch.status !== undefined && !RESEARCH_STATUSES.includes(patch.status)) {
    throw new Error('invalid research status')
  }
  if ('phase' in patch && patch.phase !== undefined && !RESEARCH_PHASES.includes(patch.phase)) {
    throw new Error('invalid research phase')
  }
  if ('depth' in patch && patch.depth !== undefined && !RESEARCH_DEPTHS.includes(patch.depth)) {
    throw new Error('invalid research depth')
  }
  if ('outputFormat' in patch && patch.outputFormat !== undefined && !RESEARCH_OUTPUT_FORMATS.includes(patch.outputFormat)) {
    throw new Error('invalid research output format')
  }
  const sets: string[] = []
  const params: Record<string, unknown> = { id, updated_at: Date.now() }
  for (const [key, column] of Object.entries(UPDATE_COLUMNS)) {
    if (!(key in patch)) continue
    let value = (patch as Record<string, unknown>)[key]
    if (key === 'plan') value = value == null ? null : JSON.stringify(value)
    if (key === 'title' && typeof value === 'string') {
      value = normalizeResearchTitle(value).slice(0, MAX_TITLE_LENGTH) || 'Untitled research'
    }
    sets.push(`${column} = @${column}`)
    params[column] = value ?? null
  }
  if (sets.length === 0) return getResearchJob(id)
  getDb().prepare(
    `UPDATE research_jobs SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`
  ).run(params)
  return getResearchJob(id)
}

export function archiveResearchJob(id: string): ResearchJob | null {
  return updateResearchJob(id, { status: 'archived', nextRunAt: undefined })
}

export function deleteResearchJob(id: string): boolean {
  return getDb().prepare('DELETE FROM research_jobs WHERE id = ?').run(id).changes > 0
}

export function countResearchJobs(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS count FROM research_jobs').get() as { count: number }
  return row.count
}
