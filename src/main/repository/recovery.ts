import { lstat, rm } from 'node:fs/promises'
import { RepositoryError, classifyGitFailure } from './errors'
import { listConflicts, resolveGitRepository } from './git'
import { canonicalExistingPath, resolveRepositoryPath } from './paths'
import { runGit, type CommandRunner } from './runner'
import type { RepositoryCheckpoint, RepositoryRecoveryReport } from './types'

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function createRepositoryCheckpoint(
  runner: CommandRunner,
  repositoryPath: string,
  now = Date.now()
): Promise<RepositoryCheckpoint> {
  const repository = await resolveGitRepository(runner, repositoryPath)
  const head = await runGit(runner, repository.root, ['rev-parse', '--verify', 'HEAD'])
  if (!head.ok) throw classifyGitFailure(head, 'create repository checkpoint')
  const branch = await runGit(runner, repository.root, ['branch', '--show-current'])
  return {
    repositoryPath: repository.root,
    headSha: head.stdout.trim(),
    branch: branch.ok && branch.stdout.trim() ? branch.stdout.trim() : null,
    createdAt: now
  }
}

export async function inspectRepositoryRecovery(
  runner: CommandRunner,
  repositoryPath: string
): Promise<RepositoryRecoveryReport> {
  const repository = await resolveGitRepository(runner, repositoryPath)
  const gitDirectory = repository.gitDirectory
  let operation: RepositoryRecoveryReport['operation'] = 'none'
  if (await exists(`${gitDirectory}/rebase-merge`) || await exists(`${gitDirectory}/rebase-apply`)) operation = 'rebase'
  else if (await exists(`${gitDirectory}/MERGE_HEAD`)) operation = 'merge'
  else if (await exists(`${gitDirectory}/CHERRY_PICK_HEAD`)) operation = 'cherry-pick'
  else if (await exists(`${gitDirectory}/REVERT_HEAD`)) operation = 'revert'
  else if (await exists(`${gitDirectory}/BISECT_LOG`)) operation = 'bisect'
  const conflicts = await listConflicts(runner, repository.root)
  const status = await runGit(runner, repository.root, ['status', '--porcelain=v1', '-z'])
  if (!status.ok) throw classifyGitFailure(status, 'inspect repository recovery state')
  const recommendedActions: string[] = []
  if (conflicts.length > 0) recommendedActions.push('Review and resolve each conflicted file before continuing.')
  if (operation !== 'none') recommendedActions.push(`Continue or explicitly abort the in-progress ${operation} operation.`)
  if (operation === 'none' && status.stdout.length > 0) recommendedActions.push('Commit, stash, or explicitly restore the remaining changes.')
  if (recommendedActions.length === 0) recommendedActions.push('Repository is clean; no recovery action is required.')
  return {
    repositoryPath: repository.root,
    operation,
    conflicts,
    dirty: status.stdout.length > 0,
    recommendedActions
  }
}

export async function abortInProgressOperation(
  runner: CommandRunner,
  repositoryPath: string
): Promise<RepositoryRecoveryReport> {
  const before = await inspectRepositoryRecovery(runner, repositoryPath)
  if (before.operation === 'none') return before
  const args: string[] = before.operation === 'merge'
    ? ['merge', '--abort']
    : before.operation === 'rebase'
      ? ['rebase', '--abort']
      : before.operation === 'cherry-pick'
        ? ['cherry-pick', '--abort']
        : before.operation === 'revert'
          ? ['revert', '--abort']
          : ['bisect', 'reset']
  const aborted = await runGit(runner, before.repositoryPath, args)
  if (!aborted.ok) throw classifyGitFailure(aborted, `abort ${before.operation}`)
  return inspectRepositoryRecovery(runner, before.repositoryPath)
}

/** Restores only caller-enumerated files; broad reset/clean operations are deliberately absent. */
export async function restoreExplicitPathsToCheckpoint(
  runner: CommandRunner,
  repositoryPath: string,
  checkpoint: RepositoryCheckpoint,
  paths: readonly string[]
): Promise<string[]> {
  const repository = await resolveGitRepository(runner, repositoryPath)
  const checkpointRepository = await canonicalExistingPath(checkpoint.repositoryPath)
  if (repository.root !== checkpointRepository) {
    throw new RepositoryError('unsafe-path', 'Checkpoint belongs to a different repository.', {
      operation: 'restore checkpoint paths'
    })
  }
  if (paths.length === 0 || paths.length > 256) {
    throw new RepositoryError('invalid-pathspec', 'Rollback requires between 1 and 256 explicit file paths.', {
      operation: 'restore checkpoint paths',
      recoverable: true
    })
  }
  const commit = await runGit(runner, repository.root, ['cat-file', '-e', `${checkpoint.headSha}^{commit}`])
  if (!commit.ok) throw new RepositoryError('invalid-response', 'Checkpoint commit is not available in this repository.', {
    operation: 'restore checkpoint paths',
    recoverable: true
  })

  const restored: string[] = []
  for (const path of paths) {
    const safe = await resolveRepositoryPath(repository.root, path)
    try {
      if ((await lstat(safe.absolutePath)).isDirectory()) {
        throw new RepositoryError('invalid-pathspec', 'Rollback paths must name files, not directories.', {
          operation: 'restore checkpoint paths',
          recoverable: true
        })
      }
    } catch (error) {
      if (error instanceof RepositoryError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const atCheckpoint = await runGit(runner, repository.root, [
      'ls-tree', '-r', '--name-only', '-z', checkpoint.headSha, '--', safe.relativePath
    ])
    if (!atCheckpoint.ok) throw classifyGitFailure(atCheckpoint, 'inspect checkpoint path')
    if (atCheckpoint.stdout.split('\0').includes(safe.relativePath)) {
      const result = await runGit(runner, repository.root, [
        'restore', '--source', checkpoint.headSha, '--staged', '--worktree', '--', safe.relativePath
      ])
      if (!result.ok) throw classifyGitFailure(result, 'restore checkpoint path')
    } else {
      await runGit(runner, repository.root, ['restore', '--staged', '--', safe.relativePath])
      await rm(safe.absolutePath, { force: true })
    }
    restored.push(safe.relativePath)
  }
  return restored
}
