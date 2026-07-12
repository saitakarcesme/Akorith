export type GitHubTransport = 'https' | 'ssh'

export interface GitHubRepositoryRef {
  kind: 'github'
  owner: string
  repository: string
  transport: GitHubTransport
  cloneUrl: string
  httpsUrl: string
  sshUrl: string
  canonicalId: string
}

export interface LocalRepositoryRemote {
  kind: 'local'
  /** Canonical absolute path. Local remotes are an explicit trusted/test seam. */
  path: string
}

export type RepositoryRemote = GitHubRepositoryRef | LocalRepositoryRemote

export interface GitIdentity {
  name: string
  email: string
}

export interface DetectedCommand {
  kind: 'test' | 'build' | 'lint' | 'typecheck'
  label: string
  executable: string
  args: string[]
  source: string
}

export interface RepositoryTechnologyProfile {
  languages: string[]
  packageManagers: string[]
  manifests: string[]
  scripts: Record<string, string>
  commands: {
    test: DetectedCommand[]
    build: DetectedCommand[]
    lint: DetectedCommand[]
    typecheck: DetectedCommand[]
  }
  scannedFiles: number
  truncated: boolean
}

export type RemoteAuthState = 'not-required' | 'unknown' | 'authenticated' | 'required' | 'failed'

export interface RemoteAccessInspection {
  remoteName: string
  configured: boolean
  url: string | null
  reachable: boolean
  repositoryExists: boolean | null
  authState: RemoteAuthState
  canPush: boolean | null
  defaultBranch: string | null
  errorCode: string | null
  message: string
}

export interface RepositoryInspection {
  path: string
  gitDirectory: string
  branch: string | null
  headSha: string | null
  defaultBranch: string
  dirty: boolean
  conflicts: string[]
  remotes: Record<string, string>
  technology: RepositoryTechnologyProfile
}

export interface RepositoryLeaseInfo {
  token: string
  owner: string
  canonicalPath: string
  acquiredAt: number
  expiresAt: number
}

export interface RepositoryLease {
  readonly info: RepositoryLeaseInfo
  refresh(ttlMs?: number): Promise<RepositoryLeaseInfo>
  release(): Promise<void>
}

export interface CloneRepositoryResult {
  path: string
  remote: RepositoryRemote
  inspection: RepositoryInspection
}

export interface CreateProjectInput {
  name: string
  summary: string
  plan: string
  identity: GitIdentity
  branch?: string
}

export interface CreateProjectResult {
  path: string
  initialCommitSha: string
  inspection: RepositoryInspection
}

export interface CommitPathsResult {
  committed: boolean
  sha: string | null
  paths: string[]
  message: string
}

export interface PushResult {
  pushed: boolean
  remoteName: string
  branch: string
  output: string
}

export interface RepositoryCheckpoint {
  repositoryPath: string
  headSha: string
  branch: string | null
  createdAt: number
}

export interface RepositoryRecoveryReport {
  repositoryPath: string
  operation: 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'
  conflicts: string[]
  dirty: boolean
  recommendedActions: string[]
}

export interface GitHubRepositoryCreateRequest {
  owner: string
  name: string
  description: string
  visibility: 'private' | 'public'
  initialize: boolean
}

export interface GitHubPluginAvailability {
  available: boolean
  authenticated: boolean
  reason: string
}

export interface GitHubRepositoryCreateResult {
  owner: string
  name: string
  httpsUrl: string
  defaultBranch: string | null
}

/** Live creation is supplied only by the connected GitHub marketplace plugin. */
export interface GitHubRepositoryPluginAdapter {
  readonly pluginId: 'github'
  availability(): Promise<GitHubPluginAvailability>
  createRepository(request: GitHubRepositoryCreateRequest, signal?: AbortSignal): Promise<GitHubRepositoryCreateResult>
}
