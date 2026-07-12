import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  GitHubPluginAvailability,
  GitHubRepositoryCreateRequest,
  GitHubRepositoryCreateResult,
  GitHubRepositoryPluginAdapter
} from './types'

const execFileAsync = promisify(execFile)
const SAFE_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const SAFE_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/

function ghExecutable(): string {
  return process.platform === 'win32' ? 'gh.exe' : 'gh'
}

async function runGh(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(ghExecutable(), args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 2_000_000,
    signal,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' }
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

export type GitHubCliRunner = (args: string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>

/** Authenticated GitHub account adapter backed by the user's existing gh CLI login. */
export class GitHubCliRepositoryAdapter implements GitHubRepositoryPluginAdapter {
  readonly pluginId = 'github' as const

  constructor(private readonly runner: GitHubCliRunner = runGh) {}

  async availability(): Promise<GitHubPluginAvailability> {
    try {
      await this.runner(['auth', 'status', '--active', '--hostname', 'github.com'])
      return { available: true, authenticated: true, reason: 'GitHub CLI account is authenticated.' }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return {
        available: code !== 'ENOENT',
        authenticated: false,
        reason: code === 'ENOENT'
          ? 'Install GitHub CLI and run gh auth login.'
          : 'GitHub CLI is installed but no active github.com account is authenticated.'
      }
    }
  }

  async createRepository(
    request: GitHubRepositoryCreateRequest,
    signal?: AbortSignal
  ): Promise<GitHubRepositoryCreateResult> {
    if (!SAFE_OWNER.test(request.owner) || !SAFE_REPOSITORY.test(request.name)) {
      throw new Error('GitHub owner or repository name is invalid.')
    }
    const fullName = `${request.owner}/${request.name}`
    const visibility = request.visibility === 'public' ? '--public' : '--private'
    await this.runner([
      'repo', 'create', fullName,
      visibility,
      '--description', request.description.slice(0, 350),
      ...(request.initialize ? ['--add-readme'] : [])
    ], signal)
    const view = await this.runner([
      'repo', 'view', fullName,
      '--json', 'url,defaultBranchRef',
      '--jq', '{url: .url, branch: (.defaultBranchRef.name // null)}'
    ], signal)
    const parsed = JSON.parse(view.stdout) as { url?: unknown; branch?: unknown }
    if (typeof parsed.url !== 'string' || !parsed.url.startsWith('https://github.com/')) {
      throw new Error('GitHub CLI returned an invalid repository URL.')
    }
    return {
      owner: request.owner,
      name: request.name,
      httpsUrl: parsed.url,
      defaultBranch: typeof parsed.branch === 'string' ? parsed.branch : null
    }
  }
}
