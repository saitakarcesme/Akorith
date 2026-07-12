import type { CommandResult } from './runner'

export type RepositoryErrorCode =
  | 'invalid-url'
  | 'unsafe-path'
  | 'outside-managed-root'
  | 'path-not-found'
  | 'already-exists'
  | 'not-git-repository'
  | 'git-unavailable'
  | 'git-command-failed'
  | 'timeout'
  | 'authentication-required'
  | 'authentication-failed'
  | 'remote-not-found'
  | 'remote-mismatch'
  | 'remote-conflict'
  | 'push-permission-denied'
  | 'non-fast-forward'
  | 'merge-conflict'
  | 'lock-conflict'
  | 'lock-lost'
  | 'nothing-to-commit'
  | 'invalid-pathspec'
  | 'invalid-branch'
  | 'adapter-unavailable'
  | 'cancelled'
  | 'invalid-response'

export interface RepositoryErrorOptions {
  operation: string
  recoverable?: boolean
  detail?: string
  cause?: unknown
}

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode
  readonly operation: string
  readonly recoverable: boolean
  readonly detail?: string

  constructor(code: RepositoryErrorCode, message: string, options: RepositoryErrorOptions) {
    super(message, { cause: options.cause })
    this.name = 'RepositoryError'
    this.code = code
    this.operation = options.operation
    this.recoverable = options.recoverable ?? false
    this.detail = options.detail
  }
}

function boundedDetail(result: CommandResult): string {
  const raw = `${result.stderr}\n${result.stdout}`.trim()
  // GitHub URLs are validated to prohibit embedded credentials. Still redact URL userinfo defensively.
  return raw.replace(/https?:\/\/[^/@\s]+@/gi, 'https://[redacted]@').slice(0, 2_000)
}

export function classifyGitFailure(result: CommandResult, operation: string): RepositoryError {
  const detail = boundedDetail(result)
  const text = detail.toLowerCase()
  if (result.timedOut) {
    return new RepositoryError('timeout', `Git timed out while attempting to ${operation}.`, {
      operation,
      recoverable: true,
      detail
    })
  }
  if (result.cancelled) {
    return new RepositoryError('cancelled', `Git was cancelled while attempting to ${operation}.`, {
      operation,
      recoverable: true
    })
  }
  if (/not recognized|not found|enoent|cannot find the file/.test(text) && result.spawnError) {
    return new RepositoryError('git-unavailable', 'Git is not installed or is unavailable on PATH.', { operation, detail })
  }
  if (/authentication failed|invalid username or password|permission denied \(publickey\)/.test(text)) {
    return new RepositoryError('authentication-failed', 'Git authentication failed. Reconnect the repository account and retry.', {
      operation,
      recoverable: true,
      detail
    })
  }
  if (/could not read username|terminal prompts disabled|authentication required|no such device or address/.test(text)) {
    return new RepositoryError('authentication-required', 'Repository authentication is required.', {
      operation,
      recoverable: true,
      detail
    })
  }
  if (/repository not found|does not appear to be a git repository|couldn't find remote ref|no such repository/.test(text)) {
    return new RepositoryError('remote-not-found', 'The remote repository or branch was not found.', {
      operation,
      recoverable: true,
      detail
    })
  }
  if (/permission to .* denied|write access .* not granted|not allowed to push|pre-receive hook declined|http 403/.test(text)) {
    return new RepositoryError('push-permission-denied', 'The connected account does not have permission to push.', {
      operation,
      recoverable: true,
      detail
    })
  }
  if (/non-fast-forward|fetch first|failed to push some refs|stale info/.test(text)) {
    return new RepositoryError('non-fast-forward', 'The remote contains changes that must be reconciled before pushing.', {
      operation,
      recoverable: true,
      detail
    })
  }
  if (/conflict|merge_head exists|you have not concluded your merge|unmerged files/.test(text)) {
    return new RepositoryError('merge-conflict', 'Repository conflicts require review before this operation can continue.', {
      operation,
      recoverable: true,
      detail
    })
  }
  if (/remote .* already exists/.test(text)) {
    return new RepositoryError('remote-conflict', 'A remote with that name already exists.', {
      operation,
      recoverable: true,
      detail
    })
  }
  return new RepositoryError('git-command-failed', `Git failed while attempting to ${operation}.`, {
    operation,
    recoverable: true,
    detail
  })
}

export function asRepositoryError(error: unknown, operation: string): RepositoryError {
  if (error instanceof RepositoryError) return error
  return new RepositoryError('git-command-failed', `Repository operation failed: ${operation}.`, {
    operation,
    recoverable: true,
    cause: error,
    detail: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000)
  })
}
