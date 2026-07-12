import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { RepositoryError, asRepositoryError, classifyGitFailure } from './errors'
import {
  addOrValidateRemote,
  commitExplicitPaths,
  detectDefaultBranch,
  inspectRemoteAccess,
  inspectRepository,
  pushNonForce
} from './git'
import { RepositoryLeaseManager } from './locks'
import { assertPathWithinRoot, canonicalExistingPath, remoteArgument } from './paths'
import {
  abortInProgressOperation,
  createRepositoryCheckpoint,
  inspectRepositoryRecovery,
  restoreExplicitPathsToCheckpoint
} from './recovery'
import { ExecFileCommandRunner, runGit, type CommandRunner } from './runner'
import type {
  CloneRepositoryResult,
  CommitPathsResult,
  CreateProjectInput,
  CreateProjectResult,
  GitHubRepositoryCreateRequest,
  GitHubRepositoryCreateResult,
  GitHubRepositoryPluginAdapter,
  PushResult,
  RemoteAccessInspection,
  RepositoryCheckpoint,
  RepositoryInspection,
  RepositoryRecoveryReport,
  RepositoryRemote
} from './types'
import { parseGitHubRepositoryUrl, safeRepositorySlug, validateBranchName } from './url'

export interface RepositoryServiceOptions {
  managedRoot: string
  lockRoot?: string
  runner?: CommandRunner
  leaseManager?: RepositoryLeaseManager
  githubAdapter?: GitHubRepositoryPluginAdapter
}

function validateIdentity(input: CreateProjectInput['identity']): void {
  if (!input.name.trim() || input.name.length > 100 || /[\0\r\n<>]/.test(input.name)) {
    throw new RepositoryError('git-command-failed', 'Git identity name is invalid.', {
      operation: 'validate Git identity',
      recoverable: true
    })
  }
  if (input.email.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(input.email)) {
    throw new RepositoryError('git-command-failed', 'Git identity email is invalid.', {
      operation: 'validate Git identity',
      recoverable: true
    })
  }
}

function boundedText(value: string, label: string, maxBytes: number): string {
  const trimmed = value.trim()
  if (!trimmed || /\0/.test(trimmed) || Buffer.byteLength(trimmed, 'utf8') > maxBytes) {
    throw new RepositoryError('git-command-failed', `${label} is empty or exceeds its safe size limit.`, {
      operation: `validate ${label.toLowerCase()}`,
      recoverable: true
    })
  }
  return trimmed
}

export class RepositoryService {
  readonly runner: CommandRunner
  readonly leases: RepositoryLeaseManager
  private readonly configuredManagedRoot: string
  private readonly configuredHooksPath: string
  private readonly githubAdapter?: GitHubRepositoryPluginAdapter
  private preparation: Promise<{ managedRoot: string; hooksPath: string }> | null = null

  constructor(options: RepositoryServiceOptions) {
    this.configuredManagedRoot = resolve(options.managedRoot)
    this.configuredHooksPath = join(this.configuredManagedRoot, '.akorith-empty-hooks')
    this.runner = options.runner ?? new ExecFileCommandRunner()
    this.leases = options.leaseManager ?? new RepositoryLeaseManager(
      resolve(options.lockRoot ?? join(this.configuredManagedRoot, '.akorith-locks'))
    )
    this.githubAdapter = options.githubAdapter
  }

  async prepare(): Promise<{ managedRoot: string; hooksPath: string }> {
    if (!this.preparation) {
      this.preparation = (async () => {
        await mkdir(this.configuredManagedRoot, { recursive: true })
        await mkdir(this.configuredHooksPath, { recursive: true })
        const managedRoot = await canonicalExistingPath(this.configuredManagedRoot)
        const hooksPath = await canonicalExistingPath(this.configuredHooksPath)
        const entries = await readdir(hooksPath)
        if (entries.length > 0) {
          throw new RepositoryError('unsafe-path', 'The managed Git hooks suppression directory is not empty.', {
            operation: 'prepare repository service'
          })
        }
        return { managedRoot, hooksPath }
      })()
    }
    return this.preparation
  }

  private async allocateWorkspace(label: string): Promise<string> {
    const { managedRoot } = await this.prepare()
    const slug = safeRepositorySlug(label)
    for (let attempt = 0; attempt < 10; attempt++) {
      const path = join(managedRoot, `${slug}-${randomUUID().slice(0, 8)}`)
      try {
        await mkdir(path, { recursive: false })
        const contained = await assertPathWithinRoot(managedRoot, path, { mustExist: true })
        if (dirname(contained.path) !== contained.root) throw new Error('Managed workspace must be a direct child.')
        return contained.path
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
    }
    throw new RepositoryError('already-exists', 'Could not allocate a unique managed workspace.', {
      operation: 'allocate managed workspace',
      recoverable: true
    })
  }

  private async removeAllocatedWorkspace(path: string): Promise<void> {
    const { managedRoot } = await this.prepare()
    const contained = await assertPathWithinRoot(managedRoot, path, { mustExist: true })
    if (dirname(contained.path) !== contained.root || !/-[0-9a-f]{8}$/i.test(basename(contained.path))) {
      throw new RepositoryError('unsafe-path', 'Refusing to remove a folder that is not an allocated managed workspace.', {
        operation: 'rollback managed workspace'
      })
    }
    await rm(contained.path, { recursive: true, force: true })
  }

  async cloneGitHub(url: string, signal?: AbortSignal): Promise<CloneRepositoryResult> {
    return this.cloneRemote(parseGitHubRepositoryUrl(url), signal)
  }

  /** Local remotes are accepted only as a pre-canonicalized typed value, primarily for tests/offline workflows. */
  async cloneRemote(remote: RepositoryRemote, signal?: AbortSignal): Promise<CloneRepositoryResult> {
    const { managedRoot, hooksPath } = await this.prepare()
    const label = remote.kind === 'github' ? remote.repository : basename(remote.path).replace(/\.git$/i, '')
    const workspace = await this.allocateWorkspace(label)
    const lease = await this.leases.acquire(workspace, { owner: 'clone repository', ttlMs: 10 * 60 * 1_000 })
    try {
      const cloned = await runGit(
        this.runner,
        managedRoot,
        [
          '-c', `core.hooksPath=${hooksPath}`,
          'clone', '--no-tags', '--no-recurse-submodules', '--origin', 'origin', '--',
          remoteArgument(remote), basename(workspace)
        ],
        { timeoutMs: 300_000, signal, env: { GIT_LFS_SKIP_SMUDGE: '1' } }
      )
      if (!cloned.ok) throw classifyGitFailure(cloned, 'clone repository')
      const resolved = await canonicalExistingPath(workspace)
      await assertPathWithinRoot(managedRoot, resolved, { mustExist: true })
      await addOrValidateRemote(this.runner, resolved, remote)
      return { path: resolved, remote, inspection: await inspectRepository(this.runner, resolved) }
    } catch (error) {
      await this.removeAllocatedWorkspace(workspace).catch(() => undefined)
      throw asRepositoryError(error, 'clone repository')
    } finally {
      await lease.release().catch(() => undefined)
    }
  }

  async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    const name = boundedText(input.name, 'Project name', 200)
    const summary = boundedText(input.summary, 'Project summary', 8_000)
    const plan = boundedText(input.plan, 'Project plan', 64 * 1024)
    validateIdentity(input.identity)
    const branch = validateBranchName(input.branch ?? 'main')
    const { hooksPath } = await this.prepare()
    const workspace = await this.allocateWorkspace(name)
    const lease = await this.leases.acquire(workspace, { owner: 'create project' })
    try {
      const initialized = await runGit(this.runner, workspace, ['init', '-b', branch])
      if (!initialized.ok) throw classifyGitFailure(initialized, 'initialize repository')
      const identityName = await runGit(this.runner, workspace, ['config', '--local', 'user.name', input.identity.name.trim()])
      if (!identityName.ok) throw classifyGitFailure(identityName, 'configure Git identity name')
      const identityEmail = await runGit(this.runner, workspace, ['config', '--local', 'user.email', input.identity.email.trim()])
      if (!identityEmail.ok) throw classifyGitFailure(identityEmail, 'configure Git identity email')

      const readme = `# ${name}\n\n${summary}\n`
      const projectPlan = `# Project plan\n\n${plan}\n`
      await writeFile(join(workspace, 'README.md'), readme, { encoding: 'utf8', flag: 'wx' })
      await writeFile(join(workspace, 'PLAN.md'), projectPlan, { encoding: 'utf8', flag: 'wx' })
      const committed = await commitExplicitPaths(
        this.runner,
        workspace,
        ['README.md', 'PLAN.md'],
        `chore: initialize ${name}`,
        { hooksPath }
      )
      if (!committed.sha) throw new RepositoryError('invalid-response', 'Initial commit did not return a revision.', {
        operation: 'create project'
      })
      return { path: workspace, initialCommitSha: committed.sha, inspection: await inspectRepository(this.runner, workspace) }
    } catch (error) {
      await this.removeAllocatedWorkspace(workspace).catch(() => undefined)
      throw asRepositoryError(error, 'create project')
    } finally {
      await lease.release().catch(() => undefined)
    }
  }

  /** Create a user-owned project as one direct child of an explicitly selected parent directory. */
  async createProjectInParent(parentPath: string, input: CreateProjectInput): Promise<CreateProjectResult> {
    const name = boundedText(input.name, 'Project name', 200)
    const summary = boundedText(input.summary, 'Project summary', 8_000)
    const plan = boundedText(input.plan, 'Project plan', 64 * 1024)
    validateIdentity(input.identity)
    const branch = validateBranchName(input.branch ?? 'main')
    const parent = await canonicalExistingPath(parentPath)
    const workspaceCandidate = join(parent, safeRepositorySlug(name))
    let workspace: string | null = null
    try {
      await mkdir(workspaceCandidate, { recursive: false })
      const contained = await assertPathWithinRoot(parent, workspaceCandidate, { mustExist: true })
      if (dirname(contained.path) !== contained.root) {
        throw new RepositoryError('unsafe-path', 'New projects must be direct children of the selected parent.', {
          operation: 'create project in selected parent'
        })
      }
      workspace = contained.path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new RepositoryError('already-exists', 'A folder with this project name already exists in the selected parent.', {
          operation: 'create project in selected parent', recoverable: true, cause: error
        })
      }
      throw asRepositoryError(error, 'create project in selected parent')
    }

    const { hooksPath } = await this.prepare()
    const lease = await this.leases.acquire(workspace, { owner: 'create project in selected parent' })
    try {
      const initialized = await runGit(this.runner, workspace, ['init', '-b', branch])
      if (!initialized.ok) throw classifyGitFailure(initialized, 'initialize repository')
      const identityName = await runGit(this.runner, workspace, ['config', '--local', 'user.name', input.identity.name.trim()])
      if (!identityName.ok) throw classifyGitFailure(identityName, 'configure Git identity name')
      const identityEmail = await runGit(this.runner, workspace, ['config', '--local', 'user.email', input.identity.email.trim()])
      if (!identityEmail.ok) throw classifyGitFailure(identityEmail, 'configure Git identity email')
      await writeFile(join(workspace, 'README.md'), `# ${name}\n\n${summary}\n`, { encoding: 'utf8', flag: 'wx' })
      await writeFile(join(workspace, 'PLAN.md'), `# Project plan\n\n${plan}\n`, { encoding: 'utf8', flag: 'wx' })
      const committed = await commitExplicitPaths(
        this.runner, workspace, ['README.md', 'PLAN.md'], `chore: initialize ${name}`, { hooksPath }
      )
      if (!committed.sha) {
        throw new RepositoryError('invalid-response', 'Initial commit did not return a revision.', {
          operation: 'create project in selected parent'
        })
      }
      return { path: workspace, initialCommitSha: committed.sha, inspection: await inspectRepository(this.runner, workspace) }
    } catch (error) {
      const contained = await assertPathWithinRoot(parent, workspace, { mustExist: true }).catch(() => null)
      if (contained && dirname(contained.path) === contained.root) {
        await rm(contained.path, { recursive: true, force: true }).catch(() => undefined)
      }
      throw asRepositoryError(error, 'create project in selected parent')
    } finally {
      await lease.release().catch(() => undefined)
    }
  }

  async inspect(repositoryPath: string): Promise<RepositoryInspection> {
    return inspectRepository(this.runner, repositoryPath)
  }

  async inspectRemote(repositoryPath: string, remoteName = 'origin'): Promise<RemoteAccessInspection> {
    const { hooksPath } = await this.prepare()
    const lease = await this.leases.acquire(repositoryPath, { owner: 'inspect remote push permission' })
    try {
      return await inspectRemoteAccess(this.runner, repositoryPath, { remoteName, checkPush: true, hooksPath })
    } finally {
      await lease.release()
    }
  }

  async addRemote(
    repositoryPath: string,
    remote: RepositoryRemote,
    options: { name?: string; replaceMismatched?: boolean } = {}
  ): Promise<string> {
    const lease = await this.leases.acquire(repositoryPath, { owner: 'configure repository remote' })
    try {
      return await addOrValidateRemote(this.runner, repositoryPath, remote, options)
    } finally {
      await lease.release()
    }
  }

  async commit(
    repositoryPath: string,
    paths: readonly string[],
    message: string
  ): Promise<CommitPathsResult> {
    const { hooksPath } = await this.prepare()
    const lease = await this.leases.acquire(repositoryPath, { owner: 'commit explicit paths' })
    try {
      return await commitExplicitPaths(this.runner, repositoryPath, paths, message, { hooksPath })
    } finally {
      await lease.release()
    }
  }

  async push(
    repositoryPath: string,
    options: { branch?: string; remoteName?: string; setUpstream?: boolean } = {}
  ): Promise<PushResult> {
    const { hooksPath } = await this.prepare()
    const lease = await this.leases.acquire(repositoryPath, { owner: 'push repository' })
    try {
      const branch = options.branch ?? await detectDefaultBranch(this.runner, repositoryPath, options.remoteName ?? 'origin', false)
      return await pushNonForce(this.runner, repositoryPath, branch, {
        remoteName: options.remoteName,
        setUpstream: options.setUpstream,
        hooksPath
      })
    } finally {
      await lease.release()
    }
  }

  async checkpoint(repositoryPath: string): Promise<RepositoryCheckpoint> {
    return createRepositoryCheckpoint(this.runner, repositoryPath)
  }

  async inspectRecovery(repositoryPath: string): Promise<RepositoryRecoveryReport> {
    return inspectRepositoryRecovery(this.runner, repositoryPath)
  }

  async restore(
    repositoryPath: string,
    checkpoint: RepositoryCheckpoint,
    paths: readonly string[]
  ): Promise<string[]> {
    const lease = await this.leases.acquire(repositoryPath, { owner: 'restore checkpoint paths' })
    try {
      return await restoreExplicitPathsToCheckpoint(this.runner, repositoryPath, checkpoint, paths)
    } finally {
      await lease.release()
    }
  }

  async abortRecovery(repositoryPath: string): Promise<RepositoryRecoveryReport> {
    const lease = await this.leases.acquire(repositoryPath, { owner: 'abort Git recovery operation' })
    try {
      return await abortInProgressOperation(this.runner, repositoryPath)
    } finally {
      await lease.release()
    }
  }

  async createGitHubRepository(
    request: GitHubRepositoryCreateRequest,
    signal?: AbortSignal
  ): Promise<GitHubRepositoryCreateResult> {
    const expected = parseGitHubRepositoryUrl(`https://github.com/${request.owner}/${request.name}`)
    const description = request.description.trim().slice(0, 350)
    if (!this.githubAdapter) {
      throw new RepositoryError('authentication-required', 'Connect and authenticate the GitHub plugin before creating a repository.', {
        operation: 'create GitHub repository',
        recoverable: true
      })
    }
    const availability = await this.githubAdapter.availability()
    if (!availability.available || !availability.authenticated) {
      throw new RepositoryError('authentication-required', 'The GitHub plugin is unavailable or not authenticated.', {
        operation: 'create GitHub repository',
        recoverable: true,
        detail: availability.reason.slice(0, 1_000)
      })
    }
    let result: GitHubRepositoryCreateResult
    try {
      result = await this.githubAdapter.createRepository({ ...request, description }, signal)
    } catch (error) {
      throw new RepositoryError('adapter-unavailable', 'The GitHub plugin could not create the repository.', {
        operation: 'create GitHub repository',
        recoverable: true,
        cause: error,
        detail: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000)
      })
    }
    const returned = parseGitHubRepositoryUrl(result.httpsUrl)
    if (returned.transport !== 'https' || returned.canonicalId !== expected.canonicalId) {
      throw new RepositoryError('invalid-response', 'GitHub plugin returned a repository that does not match the request.', {
        operation: 'create GitHub repository'
      })
    }
    if (result.defaultBranch) validateBranchName(result.defaultBranch)
    return { ...result, owner: returned.owner, name: returned.repository, httpsUrl: returned.httpsUrl }
  }
}
