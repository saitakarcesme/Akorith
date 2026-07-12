import { describe, expect, it } from 'vitest'
import { buildFeatureInventory } from '../../src/main/autonomous-loop/inventory'
import type { RepositorySnapshot } from '../../src/main/autonomous-loop/types'

function snapshot(): RepositorySnapshot {
  return {
    repositoryId: 'repo-1',
    capturedAt: 10,
    headSha: 'abc',
    branch: 'main',
    dirty: false,
    fileCount: 3,
    files: ['README.md', 'src/auth.ts', 'src/auth.test.ts'],
    languages: [{ name: 'TypeScript', files: 2 }],
    frameworks: ['Electron'],
    packageManagers: ['npm'],
    packageScripts: { test: 'vitest run', build: 'vite build' },
    detectedCommands: [
      { kind: 'test', command: 'npm test', source: 'package.json#scripts.test' },
      { kind: 'build', command: 'npm run build', source: 'package.json#scripts.build' }
    ],
    readmeExcerpt: '# Example\nA terse project summary.',
    recentCommits: [],
    todoItems: [
      { file: 'src/auth.ts', line: 4, text: 'fix permission traversal bug' },
      { file: 'src/auth.test.ts', line: 9, text: 'add credential revocation coverage' }
    ],
    buildStatus: 'unknown',
    testStatus: 'unknown',
    dependencySignals: [],
    routes: [],
    components: []
  }
}

describe('feature inventory', () => {
  it('classifies evidence and prioritizes safety before lower-value debt', () => {
    const inventory = buildFeatureInventory(snapshot(), 20)
    expect(inventory.generatedAt).toBe(20)
    expect(inventory.existingCapabilities).toEqual(expect.arrayContaining(['Electron project integration', 'Automated test command']))
    expect(inventory.securityConcerns).toHaveLength(2)
    expect(inventory.highValueNextSteps[0]).toMatch(/^Security:/)
    expect(inventory.documentationGaps).toContain('README does not describe installation or setup.')
    expect(inventory.technicalDebt).toContain('No lint command was detected.')
  })
})
