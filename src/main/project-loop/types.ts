// Phase 48: project-focused Loop — autonomously grow local & GitHub projects with
// local models. These are the durable domain types stored in SQLite (new tables,
// additive; the old macro/agentic loop data is left readable).

export type ProjectLoopMode =
  | 'project_builder' // start from an idea, scaffold + grow
  | 'repo_grower' // existing local repo, add features
  | 'github_loop' // clone/link a GitHub URL, improve locally
  | 'maintenance' // docs/tests/refactor/deps/polish

export type ProjectLoopStatus = 'active' | 'paused' | 'needs_review' | 'error' | 'completed' | 'archived'

export type ProjectLoopAutonomy = 'manual' | 'assisted' | 'auto'

export type ProjectLoopSafety = 'strict' | 'standard' | 'open'

export type ProjectLoopScheduleKind = 'manual' | 'interval' | 'daily'

export interface ProjectLoop {
  id: string
  title: string
  mode: ProjectLoopMode
  status: ProjectLoopStatus
  /** Absolute local working path of the project/repo. */
  localPath: string
  /** Optional GitHub URL the loop was created from. */
  repoUrl?: string
  githubOwner?: string
  githubName?: string
  /** The idea text when mode is project_builder. */
  idea?: string
  autonomy: ProjectLoopAutonomy
  safety: ProjectLoopSafety
  scheduleKind: ProjectLoopScheduleKind
  scheduleMinutes: number
  dailyCommitTarget: number
  minCommitsPerRun: number
  maxCommitsPerRun: number
  localModelProvider: string
  localModel?: string
  pushEnabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  nextRunAt?: number
  runCount: number
  commitCount: number
  error?: string
  memorySummary?: string
  roadmapSummary?: string
}

export type ProjectLoopRunStatus = 'pending' | 'running' | 'success' | 'no_change' | 'failed' | 'rejected'

export interface ProjectLoopRun {
  id: string
  loopId: string
  runIndex: number
  status: ProjectLoopRunStatus
  startedAt: number
  endedAt?: number
  model?: string
  objective?: string
  summary?: string
  filesChanged: number
  commandsRun: number
  testsRun: number
  commitsCreated: number
  validationResult?: string
  nextStep?: string
  error?: string
}

export type ProjectLoopEventKind =
  | 'created'
  | 'goal_understood'
  | 'run_started'
  | 'inspected'
  | 'planned'
  | 'execution_started'
  | 'patch_proposed'
  | 'patch_validated'
  | 'patch_rejected'
  | 'patch_applied'
  | 'validation_run'
  | 'committed'
  | 'synced'
  | 'pushed'
  | 'analysis_started'
  | 'analyzed'
  | 'replanned'
  | 'goal_completed'
  | 'run_succeeded'
  | 'run_failed'
  | 'paused'
  | 'resumed'
  | 'archived'
  | 'error'
  | 'note'

export interface ProjectLoopEvent {
  id: string
  loopId: string
  runId?: string
  kind: ProjectLoopEventKind
  message: string
  detail?: string
  createdAt: number
}

export interface ProjectLoopCommit {
  id: string
  loopId: string
  runId?: string
  sha: string
  message: string
  filesChanged: number
  createdAt: number
  validationSummary?: string
}

export type BacklogItemStatus = 'open' | 'in_progress' | 'done' | 'dropped'

export interface ProjectLoopBacklogItem {
  id: string
  loopId: string
  title: string
  detail?: string
  category?: string
  priority: number
  status: BacklogItemStatus
  createdAt: number
  updatedAt: number
}

export type LoopMemoryKind = 'decision' | 'fact' | 'preference' | 'risk' | 'roadmap' | 'note'

export interface ProjectLoopMemory {
  id: string
  loopId: string
  kind: LoopMemoryKind
  content: string
  importance: number
  createdAt: number
  updatedAt: number
}
