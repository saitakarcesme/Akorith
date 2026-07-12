import { RepositoryError } from './errors'
import type { GitHubRepositoryRef, GitHubTransport } from './types'

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const BRANCH_PATTERN = /^(?![./])(?!.*(?:\.\.|@\{|\\|\s|~|\^|:|\?|\*|\[))(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/

function invalidUrl(reason: string): never {
  throw new RepositoryError('invalid-url', `Invalid GitHub repository URL: ${reason}`, {
    operation: 'parse GitHub repository URL',
    recoverable: true
  })
}

function validateParts(owner: string, repositoryWithSuffix: string): { owner: string; repository: string } {
  const repository = repositoryWithSuffix.endsWith('.git')
    ? repositoryWithSuffix.slice(0, -4)
    : repositoryWithSuffix
  if (!OWNER_PATTERN.test(owner) || owner.includes('--')) invalidUrl('owner is not a valid GitHub account name')
  if (!REPOSITORY_PATTERN.test(repository) || repository === '.' || repository === '..') {
    invalidUrl('repository name is invalid')
  }
  return { owner, repository }
}

function fromParts(owner: string, repository: string, transport: GitHubTransport): GitHubRepositoryRef {
  const httpsUrl = `https://github.com/${owner}/${repository}`
  const sshUrl = `git@github.com:${owner}/${repository}.git`
  return {
    kind: 'github',
    owner,
    repository,
    transport,
    cloneUrl: transport === 'ssh' ? sshUrl : `${httpsUrl}.git`,
    httpsUrl,
    sshUrl,
    canonicalId: `github:${owner.toLowerCase()}/${repository.toLowerCase()}`
  }
}

/** Supports canonical GitHub HTTPS and SSH forms only; credentials/options are rejected. */
export function parseGitHubRepositoryUrl(raw: string): GitHubRepositoryRef {
  const input = typeof raw === 'string' ? raw.trim() : ''
  if (!input || input.length > 512 || /[\0\r\n\\]/.test(input)) invalidUrl('value is empty or contains unsafe characters')

  const scp = /^git@github\.com:([^/]+)\/([^/]+)\/?$/.exec(input)
  if (scp) {
    const parts = validateParts(scp[1], scp[2])
    return fromParts(parts.owner, parts.repository, 'ssh')
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    invalidUrl('expected https://github.com/owner/repo or git@github.com:owner/repo.git')
  }

  if (url.hostname.toLowerCase() !== 'github.com') invalidUrl('host must be github.com')
  if (url.search || url.hash) invalidUrl('query strings and fragments are not allowed')
  if (url.pathname.includes('%')) invalidUrl('encoded path segments are not allowed')
  if (url.pathname.includes('//')) invalidUrl('empty path segments are not allowed')

  let transport: GitHubTransport
  if (url.protocol === 'https:') {
    if (url.username || url.password || url.port) invalidUrl('HTTPS credentials and custom ports are not allowed')
    transport = 'https'
  } else if (url.protocol === 'ssh:') {
    if (url.username !== 'git' || url.password || (url.port && url.port !== '22')) {
      invalidUrl('SSH URLs must use git@github.com and no custom credentials')
    }
    transport = 'ssh'
  } else {
    invalidUrl('only HTTPS and SSH transports are supported')
  }

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length !== 2) invalidUrl('path must contain exactly owner/repository')
  const parts = validateParts(segments[0], segments[1])
  return fromParts(parts.owner, parts.repository, transport)
}

export function tryParseGitHubRepositoryUrl(raw: string): GitHubRepositoryRef | null {
  try {
    return parseGitHubRepositoryUrl(raw)
  } catch {
    return null
  }
}

export function validateRemoteName(name: string): string {
  const trimmed = name.trim()
  if (!REMOTE_NAME_PATTERN.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new RepositoryError('remote-conflict', 'Remote name is invalid.', {
      operation: 'validate remote name',
      recoverable: true
    })
  }
  return trimmed
}

export function validateBranchName(name: string): string {
  const trimmed = name.trim()
  if (!BRANCH_PATTERN.test(trimmed) || trimmed.endsWith('.') || trimmed.includes('//')) {
    throw new RepositoryError('invalid-branch', 'Branch name is invalid or unsafe.', {
      operation: 'validate branch name',
      recoverable: true
    })
  }
  return trimmed
}

export function safeRepositorySlug(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'repository'
}
