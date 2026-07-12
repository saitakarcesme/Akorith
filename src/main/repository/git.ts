import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { detectRepositoryTechnology } from './detect'
import { RepositoryError, classifyGitFailure } from './errors'
import {
  canonicalExistingPath,
  isCanonicalPathContained,
  remoteArgument,
  resolveRepositoryPath
} from './paths'
import { runGit, type CommandRunner, type CommandResult } from './runner'
import type {
  CommitPathsResult,
  LocalRepositoryRemote,
  PushResult,
  RemoteAccessInspection,
  RepositoryInspection,
  RepositoryRemote
} from './types'
import { parseGitHubRepositoryUrl, tryParseGitHubRepositoryUrl, validateBranchName, validateRemoteName } from './url'

export interface GitRepositoryRoot {
  root: string
  gitDirectory: string
}

function output(result: CommandResult): string {
  return result.stdout.trim()
}

export async function resolveGitRepository(runner: CommandRunner, path: string): Promise<GitRepositoryRoot> {
  const requested = await canonicalExistingPath(path)
  const rootResult = await runGit(runner, requested, ['rev-parse', '--show-toplevel'])
  if (!rootResult.ok) {
    const detail = `${rootResult.stderr}\n${rootResult.stdout}`
    if (/not a git repository/i.test(detail)) {
      throw new RepositoryError('not-git-repository', 'Selected folder is not a Git repository.', {
        operation: 'resolve repository',
        recoverable: true,
        detail: detail.trim().slice(0, 2_000)
      })
    }
    throw classifyGitFailure(rootResult, 'resolve repository')
  }
  const root = await canonicalExistingPath(output(rootResult))
  if (!isCanonicalPathContained(root, requested, true)) {
    throw new RepositoryError('unsafe-path', 'Git reported a repository root that does not contain the selected path.', {
      operation: 'resolve repository'
    })
  }
  const gitDirResult = await runGit(runner, root, ['rev-parse', '--absolute-git-dir'])
  if (!gitDirResult.ok) throw classifyGitFailure(gitDirResult, 'resolve Git directory')
  return { root, gitDirectory: await canonicalExistingPath(output(gitDirResult)) }
}

export function parseDefaultBranchFromLsRemote(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/.exec(line.trim())
    if (match) {
      try {
        return validateBranchName(match[1])
      } catch {
        return null
      }
    }
  }
  return null
}

export async function detectDefaultBranch(
  runner: CommandRunner,
  repositoryPath: string,
  remoteName = 'origin',
  queryRemote = true
): Promise<string> {
  const repository = await resolveGitRepository(runner, repositoryPath)
  const remote = validateRemoteName(remoteName)
  const symbolic = await runGit(runner, repository.root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
  if (symbolic.ok) {
    const value = output(symbolic)
    if (value.startsWith(`${remote}/`)) {
      try {
        return validateBranchName(value.slice(remote.length + 1))
      } catch {
        // Continue through honest fallbacks.
      }
    }
  }
  if (queryRemote) {
    const remoteHead = await runGit(runner, repository.root, ['ls-remote', '--symref', remote, 'HEAD'])
    if (remoteHead.ok) {
      const parsed = parseDefaultBranchFromLsRemote(remoteHead.stdout)
      if (parsed) return parsed
    }
  }
  const current = await runGit(runner, repository.root, ['branch', '--show-current'])
  if (current.ok && output(current)) {
    try {
      return validateBranchName(output(current))
    } catch {
      // Continue.
    }
  }
  const configured = await runGit(runner, repository.root, ['config', '--get', 'init.defaultBranch'])
  if (configured.ok && output(configured)) {
    try {
      return validateBranchName(output(configured))
    } catch {
      // Continue.
    }
  }
  return 'main'
}

async function localRemoteMatches(raw: string, expected: LocalRepositoryRemote): Promise<boolean> {
  if (!isAbsolute(raw)) return false
  try {
    return (await canonicalExistingPath(raw)) === expected.path
  } catch {
    return false
  }
}

async function remoteMatches(raw: string, expected: RepositoryRemote): Promise<boolean> {
  if (expected.kind === 'local') return localRemoteMatches(raw, expected)
  const parsed = tryParseGitHubRepositoryUrl(raw)
  return parsed?.canonicalId === expected.canonicalId
}

export async function addOrValidateRemote(
  runner: CommandRunner,
  repositoryPath: string,
  remote: RepositoryRemote,
  options: { name?: string; replaceMismatched?: boolean } = {}
): Promise<string> {
  const repository = await resolveGitRepository(runner, repositoryPath)
  const name = validateRemoteName(options.name ?? 'origin')
  const expected = remoteArgument(remote)
  const current = await runGit(runner, repository.root, ['remote', 'get-url', name])
  if (!current.ok) {
    const detail = `${current.stderr}\n${current.stdout}`
    if (!/no such remote|does not exist/i.test(detail)) throw classifyGitFailure(current, 'read repository remote')
    const added = await runGit(runner, repository.root, ['remote', 'add', name, expected])
    if (!added.ok) throw classifyGitFailure(added, 'add repository remote')
    return expected
  }
  const existing = output(current)
  if (await remoteMatches(existing, remote)) return existing
  if (!options.replaceMismatched) {
    throw new RepositoryError('remote-mismatch', `Remote ${name} points to a different repository.`, {
      operation: 'validate repository remote',
      recoverable: true
    })
  }
  const replaced = await runGit(runner, repository.root, ['remote', 'set-url', name, expected])
  if (!replaced.ok) throw classifyGitFailure(replaced, 'replace repository remote')
  return expected
}

export async function listRepositoryRemotes(runner: CommandRunner, repositoryPath: string): Promise<Record<string, string>> {
  const repository = await resolveGitRepository(runner, repositoryPath)
  const listed = await runGit(runner, repository.root, ['remote'])
  if (!listed.ok) throw classifyGitFailure(listed, 'list remotes')
  const remotes: Record<string, string> = {}
  for (const rawName of listed.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean).slice(0, 64)) {
    let name: string
    try {
      name = validateRemoteName(rawName)
    } catch {
      continue
    }
    const url = await runGit(runner, repository.root, ['remote', 'get-url', name])
    if (url.ok) remotes[name] = output(url)
  }
  return remotes
}

export async function listConflicts(runner: CommandRunner, repositoryPath: string): Promise<string[]> {
  const repository = await resolveGitRepository(runner, repositoryPath)
  const result = await runGit(runner, repository.root, ['diff', '--name-only', '--diff-filter=U', '-z'])
  if (!result.ok) throw classifyGitFailure(result, 'inspect conflicts')
  return result.stdout.split('\0').filter(Boolean).map((path) => path.replace(/\\/g, '/'))
}

export async function inspectRemoteAccess(
  runner: CommandRunner,
  repositoryPath: string,
  options: { remoteName?: string; checkPush?: boolean; hooksPath?: string } = {}
): Promise<RemoteAccessInspection> {
  const repository = await resolveGitRepository(runner, repositoryPath)
  const remoteName = validateRemoteName(options.remoteName ?? 'origin')
  const remoteUrl = await runGit(runner, repository.root, ['remote', 'get-url', remoteName])
  if (!remoteUrl.ok) {
    return {
      remoteName,
      configured: false,
      url: null,
      reachable: false,
      repositoryExists: null,
      authState: 'unknown',
      canPush: null,
      defaultBranch: null,
      errorCode: 'remote-not-found',
      message: `Remote ${remoteName} is not configured.`
    }
  }
  const url = output(remoteUrl)
  const local = isAbsolute(url)
  const read = await runGit(runner, repository.root, ['ls-remote', '--symref', remoteName, 'HEAD'])
  if (!read.ok) {
    const error = classifyGitFailure(read, 'inspect remote repository')
    return {
      remoteName,
      configured: true,
      url,
      reachable: false,
      repositoryExists: error.code === 'remote-not-found' ? false : null,
      authState: error.code === 'authentication-required' ? 'required' : error.code === 'authentication-failed' ? 'failed' : 'unknown',
      canPush: null,
      defaultBranch: null,
      errorCode: error.code,
      message: error.message
    }
  }
  const defaultBranch = parseDefaultBranchFromLsRemote(read.stdout) ?? await detectDefaultBranch(runner, repository.root, remoteName, false)
  const head = await runGit(runner, repository.root, ['rev-parse', '--verify', 'HEAD'])
  if (options.checkPush === false || !head.ok) {
    return {
      remoteName,
      configured: true,
      url,
      reachable: true,
      repositoryExists: true,
      authState: local ? 'not-required' : 'unknown',
      canPush: null,
      defaultBranch,
      errorCode: null,
      message: head.ok ? 'Remote is reachable; push permission was not checked.' : 'Remote is reachable; local repository has no commit to test.'
    }
  }
  if (!options.hooksPath) {
    return {
      remoteName,
      configured: true,
      url,
      reachable: true,
      repositoryExists: true,
      authState: local ? 'not-required' : 'unknown',
      canPush: null,
      defaultBranch,
      errorCode: null,
      message: 'Remote is reachable; push permission requires a trusted empty hooks path.'
    }
  }
  const hooks = await canonicalExistingPath(options.hooksPath)
  const dryRun = await runGit(runner, repository.root, [
    '-c', `core.hooksPath=${hooks}`,
    'push', '--dry-run', '--porcelain', remoteName, `HEAD:refs/heads/${validateBranchName(defaultBranch)}`
  ])
  if (dryRun.ok) {
    return {
      remoteName,
      configured: true,
      url,
      reachable: true,
      repositoryExists: true,
      authState: local ? 'not-required' : 'authenticated',
      canPush: true,
      defaultBranch,
      errorCode: null,
      message: 'Remote is reachable and a non-force dry-run push succeeded.'
    }
  }
  const error = classifyGitFailure(dryRun, 'check push permission')
  return {
    remoteName,
    configured: true,
    url,
    reachable: true,
    repositoryExists: true,
    authState: error.code === 'authentication-required' ? 'required' : error.code === 'authentication-failed' ? 'failed' : 'unknown',
    canPush: false,
    defaultBranch,
    errorCode: error.code,
    message: error.message
  }
}

export async function inspectRepository(runner: CommandRunner, repositoryPath: string): Promise<RepositoryInspection> {
  const repository = await resolveGitRepository(runner, repositoryPath)
  const branch = await runGit(runner, repository.root, ['branch', '--show-current'])
  const head = await runGit(runner, repository.root, ['rev-parse', '--verify', 'HEAD'])
  const status = await runGit(runner, repository.root, ['status', '--porcelain=v1', '-z'])
  if (!status.ok) throw classifyGitFailure(status, 'inspect repository status')
  const conflicts = await listConflicts(runner, repository.root)
  return {
    path: repository.root,
    gitDirectory: repository.gitDirectory,
    branch: branch.ok && output(branch) ? output(branch) : null,
    headSha: head.ok ? output(head) : null,
    defaultBranch: await detectDefaultBranch(runner, repository.root, 'origin', false),
    dirty: status.stdout.length > 0,
    conflicts,
    remotes: await listRepositoryRemotes(runner, repository.root),
    technology: await detectRepositoryTechnology(runner, repository.root)
  }
}

export interface CommitExplicitPathsOptions {
  hooksPath: string
}

export async function commitExplicitPaths(
  runner: CommandRunner,
  repositoryPath: string,
  paths: readonly string[],
  message: string,
  options: CommitExplicitPathsOptions
): Promise<CommitPathsResult> {
  const repository = await resolveGitRepository(runner, repositoryPath)
  if (paths.length === 0 || paths.length > 256) {
    throw new RepositoryError('invalid-pathspec', 'Commit requires between 1 and 256 explicit paths.', {
      operation: 'commit changed paths',
      recoverable: true
    })
  }
  const cleanMessage = message.replace(/[\0\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!cleanMessage) {
    throw new RepositoryError('git-command-failed', 'Commit message cannot be empty.', {
      operation: 'commit changed paths',
      recoverable: true
    })
  }
  const hooks = await canonicalExistingPath(options.hooksPath)
  const normalized: string[] = []
  for (const path of paths) {
    const safe = await resolveRepositoryPath(repository.root, path)
    try {
      if ((await lstat(safe.absolutePath)).isDirectory()) {
        throw new RepositoryError('invalid-pathspec', 'Commit paths must name files, not directories.', {
          operation: 'commit changed paths',
          recoverable: true
        })
      }
    } catch (error) {
      if (error instanceof RepositoryError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!normalized.includes(safe.relativePath)) normalized.push(safe.relativePath)
  }
  const conflicts = await listConflicts(runner, repository.root)
  if (conflicts.length > 0) {
    throw new RepositoryError('merge-conflict', 'Resolve repository conflicts before committing.', {
      operation: 'commit changed paths',
      recoverable: true,
      detail: conflicts.join(', ').slice(0, 2_000)
    })
  }
  const status = await runGit(runner, repository.root, ['status', '--porcelain=v1', '-z', '--', ...normalized])
  if (!status.ok) throw classifyGitFailure(status, 'inspect changed paths')
  if (status.stdout.length === 0) {
    throw new RepositoryError('nothing-to-commit', 'None of the explicit paths contain changes.', {
      operation: 'commit changed paths',
      recoverable: true
    })
  }
  const staged = await runGit(runner, repository.root, ['add', '-A', '--', ...normalized])
  if (!staged.ok) throw classifyGitFailure(staged, 'stage explicit changed paths')
  const stagedNames = await runGit(runner, repository.root, ['diff', '--cached', '--name-only', '-z', '--', ...normalized])
  if (!stagedNames.ok) throw classifyGitFailure(stagedNames, 'verify staged changed paths')
  if (stagedNames.stdout.length === 0) {
    throw new RepositoryError('nothing-to-commit', 'Explicit paths produced no staged changes.', {
      operation: 'commit changed paths',
      recoverable: true
    })
  }
  const committed = await runGit(
    runner,
    repository.root,
    ['-c', `core.hooksPath=${hooks}`, 'commit', '--only', '-F', '-', '--', ...normalized],
    { stdin: `${cleanMessage}\n` }
  )
  if (!committed.ok) throw classifyGitFailure(committed, 'commit explicit changed paths')
  const sha = await runGit(runner, repository.root, ['rev-parse', 'HEAD'])
  if (!sha.ok) throw classifyGitFailure(sha, 'read committed revision')
  return { committed: true, sha: output(sha), paths: normalized, message: cleanMessage }
}

export async function pushNonForce(
  runner: CommandRunner,
  repositoryPath: string,
  branch: string,
  options: { remoteName?: string; setUpstream?: boolean; hooksPath: string }
): Promise<PushResult> {
  const repository = await resolveGitRepository(runner, repositoryPath)
  const remoteName = validateRemoteName(options.remoteName ?? 'origin')
  const safeBranch = validateBranchName(branch)
  const hooks = await canonicalExistingPath(options.hooksPath)
  const args = [
    '-c', `core.hooksPath=${hooks}`,
    'push', '--porcelain',
    ...(options.setUpstream ? ['--set-upstream'] : []),
    remoteName,
    `HEAD:refs/heads/${safeBranch}`
  ]
  if (args.some((arg) => arg === '--force' || arg.startsWith('--force-') || arg.startsWith('+'))) {
    throw new RepositoryError('git-command-failed', 'Force pushes are prohibited.', { operation: 'push repository' })
  }
  const pushed = await runGit(runner, repository.root, args)
  if (!pushed.ok) throw classifyGitFailure(pushed, 'push repository without force')
  return { pushed: true, remoteName, branch: safeBranch, output: `${pushed.stdout}\n${pushed.stderr}`.trim().slice(0, 4_000) }
}

export function repositoryRemoteFromGitHubUrl(url: string): RepositoryRemote {
  return parseGitHubRepositoryUrl(url)
}
