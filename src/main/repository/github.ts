import { RepositoryError } from './errors'
import type {
  GitHubPluginAvailability,
  GitHubRepositoryCreateRequest,
  GitHubRepositoryCreateResult,
  GitHubRepositoryPluginAdapter
} from './types'

/** Honest default until the marketplace GitHub plugin supplies a live authenticated adapter. */
export class UnavailableGitHubRepositoryPluginAdapter implements GitHubRepositoryPluginAdapter {
  readonly pluginId = 'github' as const
  private readonly reason: string

  constructor(reason = 'GitHub plugin is not connected.') {
    this.reason = reason
  }

  async availability(): Promise<GitHubPluginAvailability> {
    return { available: false, authenticated: false, reason: this.reason }
  }

  async createRepository(_request: GitHubRepositoryCreateRequest): Promise<GitHubRepositoryCreateResult> {
    throw new RepositoryError('authentication-required', 'Connect and authenticate the GitHub plugin before creating a repository.', {
      operation: 'create GitHub repository',
      recoverable: true,
      detail: this.reason.slice(0, 1_000)
    })
  }
}
