import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { RepositoryError } from './errors'
import type { LocalRepositoryRemote } from './types'

function comparable(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function isCanonicalPathContained(root: string, candidate: string, allowRoot = false): boolean {
  const rootKey = comparable(root)
  const candidateKey = comparable(candidate)
  if (candidateKey === rootKey) return allowRoot
  const relation = relative(rootKey, candidateKey)
  return Boolean(relation) && !relation.startsWith('..') && !isAbsolute(relation)
}

export async function canonicalExistingPath(path: string): Promise<string> {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) {
    throw new RepositoryError('unsafe-path', 'Path must be an absolute path without control characters.', {
      operation: 'canonicalize path',
      recoverable: true
    })
  }
  try {
    return await realpath(resolve(path))
  } catch (error) {
    throw new RepositoryError('path-not-found', 'Path does not exist or cannot be resolved.', {
      operation: 'canonicalize path',
      recoverable: true,
      cause: error
    })
  }
}

/** Resolves every existing ancestor so an in-root symlink cannot hide an escape. */
export async function canonicalProspectivePath(path: string): Promise<string> {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) {
    throw new RepositoryError('unsafe-path', 'Prospective path must be absolute and free of control characters.', {
      operation: 'canonicalize prospective path',
      recoverable: true
    })
  }
  let cursor = resolve(path)
  const suffix: string[] = []
  while (true) {
    try {
      await lstat(cursor)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        throw new RepositoryError('unsafe-path', 'Path contains an inaccessible or broken filesystem entry.', {
          operation: 'canonicalize prospective path',
          recoverable: true,
          cause: error
        })
      }
      const parent = dirname(cursor)
      if (parent === cursor) {
        throw new RepositoryError('path-not-found', 'No existing ancestor could be resolved.', {
          operation: 'canonicalize prospective path',
          recoverable: true
        })
      }
      suffix.unshift(basename(cursor))
      cursor = parent
      continue
    }
    try {
      const ancestor = await realpath(cursor)
      return resolve(ancestor, ...suffix)
    } catch (error) {
      throw new RepositoryError('unsafe-path', 'Path contains a broken or inaccessible symbolic link.', {
        operation: 'canonicalize prospective path',
        recoverable: true,
        cause: error
      })
    }
  }
}

export async function assertPathWithinRoot(
  root: string,
  candidate: string,
  options: { allowRoot?: boolean; mustExist?: boolean } = {}
): Promise<{ root: string; path: string }> {
  const canonicalRoot = await canonicalExistingPath(root)
  const canonicalCandidate = options.mustExist
    ? await canonicalExistingPath(candidate)
    : await canonicalProspectivePath(candidate)
  if (!isCanonicalPathContained(canonicalRoot, canonicalCandidate, options.allowRoot ?? false)) {
    throw new RepositoryError('outside-managed-root', 'Path resolves outside the approved root.', {
      operation: 'validate path containment',
      recoverable: true
    })
  }
  return { root: canonicalRoot, path: canonicalCandidate }
}

export interface SafeRepositoryPath {
  absolutePath: string
  relativePath: string
}

export async function resolveRepositoryPath(repositoryRoot: string, pathspec: string): Promise<SafeRepositoryPath> {
  if (
    typeof pathspec !== 'string' ||
    !pathspec.trim() ||
    pathspec.length > 1_024 ||
    isAbsolute(pathspec) ||
    /[\0\r\n]/.test(pathspec)
  ) {
    throw new RepositoryError('invalid-pathspec', 'Changed paths must be non-empty repository-relative paths.', {
      operation: 'validate changed path',
      recoverable: true
    })
  }
  const normalized = pathspec.replace(/\\/g, '/').replace(/^\.\//, '')
  const segments = normalized.split('/')
  if (
    !normalized ||
    normalized === '.' ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    segments.some((segment) => segment.toLowerCase() === '.git')
  ) {
    throw new RepositoryError('invalid-pathspec', 'Changed path traverses or touches protected repository metadata.', {
      operation: 'validate changed path',
      recoverable: true
    })
  }
  const root = await canonicalExistingPath(repositoryRoot)
  const candidate = resolve(root, ...segments)
  const canonicalCandidate = await canonicalProspectivePath(candidate)
  if (!isCanonicalPathContained(root, canonicalCandidate)) {
    throw new RepositoryError('invalid-pathspec', 'Changed path resolves outside the repository.', {
      operation: 'validate changed path',
      recoverable: true
    })
  }
  return { absolutePath: canonicalCandidate, relativePath: segments.join('/') }
}

export async function createLocalRepositoryRemote(path: string): Promise<LocalRepositoryRemote> {
  const canonical = await canonicalExistingPath(path)
  const info = await stat(canonical)
  if (!info.isDirectory()) {
    throw new RepositoryError('invalid-url', 'Local repository remote must be a directory.', {
      operation: 'create local remote',
      recoverable: true
    })
  }
  return { kind: 'local', path: canonical }
}

export function remoteArgument(remote: LocalRepositoryRemote | { kind: 'github'; cloneUrl: string }): string {
  return remote.kind === 'local' ? remote.path : remote.cloneUrl
}
