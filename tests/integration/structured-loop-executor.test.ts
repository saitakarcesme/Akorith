import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StructuredPatchLoopExecutorAdapter } from '../../src/main/autonomous-loop/executor-structured'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('structured Loop executor', () => {
  it('applies a validated local-model patch to the real workspace', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'akorith-structured-test-'))
    cleanup.push(workspacePath)
    await mkdir(join(workspacePath, 'src'))
    const client = {
      async generate() {
        return {
          text: JSON.stringify({
            type: 'workspace_patch',
            summary: 'Repair greeting output',
            rationale: 'The focused implementation satisfies the greeting contract.',
            files: [{
              path: 'src/greeting.ts',
              operation: 'create',
              content: "export const greeting = 'Hello from Akorith'\n"
            }],
            commands: [],
            expected_outcome: 'The greeting module exports the expected value.'
          }),
          usage: { input: 120, output: 80, cached: 20, costUsd: 0 },
          estimated: false
        }
      }
    }
    const adapter = new StructuredPatchLoopExecutorAdapter(client)
    const result = await adapter.execute({
      workspacePath,
      selection: {
        catalogId: 'local:model', providerId: 'local', model: 'fixture', location: 'local',
        capabilityProbeId: 'probe:fixture'
      },
      task: {
        title: 'fix: repair greeting', proposedTask: 'Repair greeting output.', reason: 'Regression fixture.',
        expectedUserValue: 'Correct greeting.', likelyAreas: ['src/greeting.ts'],
        acceptanceCriteria: ['The greeting export is correct.'], validationCommands: [],
        riskLevel: 'low', estimatedComplexity: 'small', kind: 'bug_fix'
      },
      repositoryContext: '{"files":[]}',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('completed')
    expect(result.changedFiles).toEqual(['src/greeting.ts'])
    expect(result.usage.cached).toBe(20)
    await expect(readFile(join(workspacePath, 'src/greeting.ts'), 'utf8')).resolves.toContain('Hello from Akorith')
  })
})
