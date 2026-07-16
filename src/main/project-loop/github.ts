import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { app } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { parseGitHubRepositoryUrl, type GitHubRepositoryRef } from './github-url'

const CLONE_TIMEOUT = 5 * 60_000

export interface ClonedGitHubRepository {
  path: string
  name: string
  isRepo: true
  repoUrl: string
  githubOwner: string
  githubName: string
}

function runGh(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile('gh', args, { timeout: CLONE_TIMEOUT, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, _stdout, stderr) => {
      resolve({ ok: !error, stderr: (stderr ?? '').toString().trim() })
    })
  })
}

export async function cloneGitHubRepository(input: string): Promise<ClonedGitHubRepository> {
  const repository = parseGitHubRepositoryUrl(input)
  const root = join(app.getPath('userData'), 'loop-workspaces')
  mkdirSync(root, { recursive: true })
  const suffix = `${Date.now()}-${randomBytes(3).toString('hex')}`
  const target = join(root, `${repository.owner}--${repository.name}--${suffix}`)
  const cloned = await runGh(['repo', 'clone', repository.slug, target])
  if (!cloned.ok) {
    throw new Error(cloned.stderr || 'GitHub could not clone this repository. Check gh authentication and repository access.')
  }
  return {
    path: target,
    name: repository.name,
    isRepo: true,
    repoUrl: repository.url,
    githubOwner: repository.owner,
    githubName: repository.name
  }
}

export function sameGitHubRepository(left: GitHubRepositoryRef, right: GitHubRepositoryRef): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() && left.name.toLowerCase() === right.name.toLowerCase()
}
