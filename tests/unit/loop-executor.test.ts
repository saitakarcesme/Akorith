import { describe, expect, it } from 'vitest'
import { __executorCliTest, CliLoopExecutorAdapter } from '../../src/main/autonomous-loop/executor-cli'
import { buildLoopExecutorPrompt } from '../../src/main/autonomous-loop/executor-prompt'

const request = {
  workspacePath: 'C:/work/project',
  selection: {
    catalogId: 'cloud:chatgpt:codex',
    providerId: 'chatgpt',
    model: 'default',
    location: 'cloud' as const,
    capabilityProbeId: 'probe:1'
  },
  task: {
    title: 'fix: repair greeting',
    proposedTask: 'Repair the greeting result.',
    reason: 'A failing regression test identifies the defect.',
    expectedUserValue: 'Greeting calls return the documented value.',
    likelyAreas: ['src/greeting.ts'],
    acceptanceCriteria: ['The regression test passes.'],
    validationCommands: ['npm test'],
    riskLevel: 'low' as const,
    estimatedComplexity: 'small' as const,
    kind: 'bug_fix' as const
  },
  repositoryContext: '{"files":["src/greeting.ts"]}',
  timeoutMs: 60_000
}

describe('Loop executor adapters', () => {
  it('supports code-capable CLI provider families', () => {
    const adapter = new CliLoopExecutorAdapter()
    expect(adapter.supports(request.selection)).toBe(true)
    expect(adapter.supports({ ...request.selection, providerId: 'claude' })).toBe(true)
    expect(adapter.supports({ ...request.selection, providerId: 'opencode' })).toBe(true)
    expect(adapter.supports({ ...request.selection, providerId: 'local' })).toBe(false)
  })

  it('extracts bounded changed paths from porcelain output', () => {
    expect(__executorCliTest.parseChangedFiles(' M src/a.ts\0?? tests/a.test.ts\0')).toEqual([
      'src/a.ts',
      'tests/a.test.ts'
    ])
  })

  it('keeps commit and push outside the model executor', () => {
    const prompt = buildLoopExecutorPrompt(request)
    expect(prompt).toContain('Do not commit, push, change remotes, or switch branches')
    expect(prompt).toContain('The regression test passes.')
    expect(prompt).toContain('Do not expose chain-of-thought')
  })
})
