import { describe, expect, it } from 'vitest'
import { buildFeatureInventory } from '../../src/main/autonomous-loop/inventory'
import {
  buildLoopPlannerPrompt,
  deterministicPlannerFallback,
  isRepeatedPlannerTask
} from '../../src/main/autonomous-loop/planner'
import type { LoopCycleRecord, RepositorySnapshot } from '../../src/main/autonomous-loop/types'

const snapshot: RepositorySnapshot = {
  repositoryId: 'repo', capturedAt: 1, headSha: 'abc', branch: 'main', dirty: false,
  fileCount: 2, files: ['src/index.ts', 'src/index.test.ts'], languages: [{ name: 'TypeScript', files: 2 }],
  frameworks: [], packageManagers: ['npm'], packageScripts: { test: 'vitest run' },
  detectedCommands: [{ kind: 'test', command: 'npm test', source: 'package.json' }],
  readmeExcerpt: '# Fixture', recentCommits: [],
  todoItems: [{ file: 'src/index.test.ts', line: 3, text: 'add regression coverage' }],
  buildStatus: 'unknown', testStatus: 'unknown', dependencySignals: [], routes: [], components: []
}

describe('autonomous Loop planner', () => {
  it('requests one strict operational task without chain-of-thought', () => {
    const prompt = buildLoopPlannerPrompt({ snapshot, inventory: buildFeatureInventory(snapshot, 2), priorCycles: [] })
    expect(prompt).toContain('Select exactly one highest-value safe next step')
    expect(prompt).toContain('Return strict JSON')
    expect(prompt).toContain('Do not expose chain-of-thought')
  })

  it('falls back to a bounded evidence-backed test task and detects repeats', () => {
    const task = deterministicPlannerFallback(snapshot, buildFeatureInventory(snapshot, 2))
    expect(task.kind).toBe('test')
    expect(task.validationCommands).toContain('npm test')
    const cycle = { plannedTask: task } as LoopCycleRecord
    expect(isRepeatedPlannerTask(task, [cycle])).toBe(true)
  })
})
