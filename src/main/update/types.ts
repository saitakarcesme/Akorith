// Phase 39: in-app source updater for git/dev installs. Read-only check first;
// updates only ever fast-forward `main` after the user confirms. Never resets,
// discards local changes, force-pushes, or runs remote-supplied commands.

export interface UpdateStatus {
  /** 'git' = running from a source checkout; 'packaged' = no git repo here. */
  mode: 'git' | 'packaged'
  runtimeMode: 'dev' | 'source' | 'packaged-windows' | 'packaged-macos' | 'packaged-other'
  platform: NodeJS.Platform
  executablePath: string
  appPath: string
  repoPath?: string
  sourceCheckoutPath?: string
  currentBranch?: string
  /** Short + full HEAD commit. */
  currentCommit?: string
  currentCommitFull?: string
  /** Short origin/main commit (after fetch). */
  remoteMainCommit?: string
  /** Origin URL with any embedded credentials masked. */
  remoteUrl?: string
  behindBy: number
  aheadBy: number
  hasUpdate: boolean
  isDirty: boolean
  dirtyFiles: string[]
  /** True only when a clean fast-forward of main is possible. */
  safeToUpdate: boolean
  canUpdateInstalledApp: boolean
  updateTarget: string
  relaunchTarget?: string
  warnings: string[]
  lastCheckedAt?: number
  appVersion: string
}

export interface UpdateLogEntry {
  command: string
  ok: boolean
  /** Bounded, secret-masked output excerpt. */
  output: string
  at: number
}

export interface UpdateRunOptions {
  runInstall?: boolean
  runBuild?: boolean
}

export interface UpdateRunResult {
  ok: boolean
  status: UpdateStatus
  logs: UpdateLogEntry[]
  error?: string
  restartRecommended: boolean
}
