import { randomUUID } from 'crypto'
import { getDb } from '../db'
import type { ProjectLoop, ProjectLoopMode, ProjectLoopStatus } from './types'

// Phase 48: SQLite store for project loops. All access goes through the shared
// getDb() accessor; rows map to the ProjectLoop domain type.

type Row = Record<string, unknown>

function n(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback
}
function s(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export function rowToLoop(r: Row): ProjectLoop {
  return {
    id: String(r.id),
    title: String(r.title),
    mode: String(r.mode) as ProjectLoopMode,
    status: String(r.status) as ProjectLoopStatus,
    localPath: String(r.local_path),
    repoUrl: s(r.repo_url),
    githubOwner: s(r.github_owner),
    githubName: s(r.github_name),
    idea: s(r.idea),
    autonomy: String(r.autonomy) as ProjectLoop['autonomy'],
    safety: String(r.safety) as ProjectLoop['safety'],
    scheduleKind: String(r.schedule_kind) as ProjectLoop['scheduleKind'],
    scheduleMinutes: n(r.schedule_minutes),
    dailyCommitTarget: n(r.daily_commit_target),
    minCommitsPerRun: n(r.min_commits_per_run),
    maxCommitsPerRun: n(r.max_commits_per_run, 1),
    localModelProvider: String(r.local_model_provider ?? 'local'),
    localModel: s(r.local_model),
    pushEnabled: n(r.push_enabled) === 1,
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
    lastRunAt: r.last_run_at == null ? undefined : n(r.last_run_at),
    nextRunAt: r.next_run_at == null ? undefined : n(r.next_run_at),
    runCount: n(r.run_count),
    commitCount: n(r.commit_count),
    error: s(r.error),
    memorySummary: s(r.memory_summary),
    roadmapSummary: s(r.roadmap_summary)
  }
}

export interface CreateLoopInput {
  title: string
  mode: ProjectLoopMode
  localPath: string
  repoUrl?: string
  githubOwner?: string
  githubName?: string
  idea?: string
  autonomy?: ProjectLoop['autonomy']
  safety?: ProjectLoop['safety']
  scheduleKind?: ProjectLoop['scheduleKind']
  scheduleMinutes?: number
  dailyCommitTarget?: number
  minCommitsPerRun?: number
  maxCommitsPerRun?: number
  localModelProvider?: string
  localModel?: string
  pushEnabled?: boolean
}

export function createLoop(input: CreateLoopInput): ProjectLoop {
  const now = Date.now()
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO project_loops (
        id, title, mode, status, local_path, repo_url, github_owner, github_name, idea,
        autonomy, safety, schedule_kind, schedule_minutes, daily_commit_target,
        min_commits_per_run, max_commits_per_run, local_model_provider, local_model,
        push_enabled, created_at, updated_at, run_count, commit_count
      ) VALUES (
        @id, @title, @mode, 'active', @local_path, @repo_url, @github_owner, @github_name, @idea,
        @autonomy, @safety, @schedule_kind, @schedule_minutes, @daily_commit_target,
        @min_commits_per_run, @max_commits_per_run, @local_model_provider, @local_model,
        @push_enabled, @created_at, @updated_at, 0, 0
      )`
    )
    .run({
      id,
      title: input.title.slice(0, 200),
      mode: input.mode,
      local_path: input.localPath,
      repo_url: input.repoUrl ?? null,
      github_owner: input.githubOwner ?? null,
      github_name: input.githubName ?? null,
      idea: input.idea ?? null,
      autonomy: input.autonomy ?? 'assisted',
      safety: input.safety ?? 'standard',
      schedule_kind: input.scheduleKind ?? 'manual',
      schedule_minutes: input.scheduleMinutes ?? 0,
      daily_commit_target: input.dailyCommitTarget ?? 1,
      min_commits_per_run: input.minCommitsPerRun ?? 0,
      max_commits_per_run: input.maxCommitsPerRun ?? 1,
      local_model_provider: input.localModelProvider ?? 'local',
      local_model: input.localModel ?? null,
      push_enabled: input.pushEnabled ? 1 : 0,
      created_at: now,
      updated_at: now
    })
  return getLoop(id)!
}

export function getLoop(id: string): ProjectLoop | null {
  const row = getDb().prepare('SELECT * FROM project_loops WHERE id = ?').get(id) as Row | undefined
  return row ? rowToLoop(row) : null
}

export function listLoops(): ProjectLoop[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_loops ORDER BY updated_at DESC')
    .all() as Row[]
  return rows.map(rowToLoop)
}
