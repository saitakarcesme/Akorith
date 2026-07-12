import { describe, expect, it, vi } from 'vitest'
import { GitHubCliRepositoryAdapter } from '../../src/main/repository/github-cli'

describe('GitHub CLI repository adapter', () => {
  it('reports authenticated availability without reading or returning a token', async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const adapter = new GitHubCliRepositoryAdapter(runner)

    await expect(adapter.availability()).resolves.toEqual({
      available: true,
      authenticated: true,
      reason: 'GitHub CLI account is authenticated.'
    })
    expect(runner).toHaveBeenCalledWith(['auth', 'status', '--active', '--hostname', 'github.com'])
  })

  it('creates a non-interactive scoped repository and verifies the returned URL', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: 'https://github.com/acme/atlas\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '{"url":"https://github.com/acme/atlas","branch":null}\n', stderr: '' })
    const adapter = new GitHubCliRepositoryAdapter(runner)

    await expect(adapter.createRepository({
      owner: 'acme',
      name: 'atlas',
      description: 'Autonomous fixture',
      visibility: 'private',
      initialize: false
    })).resolves.toEqual({
      owner: 'acme',
      name: 'atlas',
      httpsUrl: 'https://github.com/acme/atlas',
      defaultBranch: null
    })
    expect(runner.mock.calls[0]?.[0]).toEqual([
      'repo', 'create', 'acme/atlas', '--private', '--description', 'Autonomous fixture'
    ])
  })

  it('rejects unsafe names before invoking GitHub CLI', async () => {
    const runner = vi.fn()
    const adapter = new GitHubCliRepositoryAdapter(runner)
    await expect(adapter.createRepository({
      owner: '../owner', name: 'repo', description: 'x', visibility: 'public', initialize: false
    })).rejects.toThrow(/invalid/i)
    expect(runner).not.toHaveBeenCalled()
  })
})
