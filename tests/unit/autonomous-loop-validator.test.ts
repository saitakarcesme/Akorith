import { describe, expect, it } from 'vitest'
import { runLoopValidation, type ValidationCommandRunner } from '../../src/main/autonomous-loop/validator'

describe('Loop validator', () => {
  it('records every command and identifies a regression for changed failing code', async () => {
    const runner: ValidationCommandRunner = {
      async run(spec) {
        return {
          durationMs: 12,
          exitCode: spec.display.includes('test') ? 1 : 0,
          timedOut: false,
          stdout: '',
          stderr: spec.display.includes('test') ? 'one test failed' : ''
        }
      }
    }
    const result = await runLoopValidation({
      root: '.',
      detectedCommands: [{ kind: 'test', command: 'npm test', source: 'fixture' }],
      plannedCommands: [],
      timeoutMs: 1_000,
      runner,
      changedFiles: async () => ['src/index.ts']
    })
    expect(result.passed).toBe(false)
    expect(result.regressionDetected).toBe(true)
    expect(result.commands.map((item) => item.command)).toEqual(['npm test', 'git diff --check'])
    expect(result.failureSummary).toContain('npm test')
  })

  it('fails closed when the planner supplies a non-validation command', async () => {
    const executed: string[] = []
    const runner: ValidationCommandRunner = {
      async run(spec) {
        executed.push(spec.display)
        return { durationMs: 1, exitCode: 0, timedOut: false, stdout: '', stderr: '' }
      }
    }
    const result = await runLoopValidation({
      root: '.',
      detectedCommands: [],
      plannedCommands: ['git push --force'],
      timeoutMs: 1_000,
      runner,
      changedFiles: async () => []
    })
    expect(result.passed).toBe(false)
    expect(result.commands[0]?.stderr).toContain('not allowlisted')
    expect(executed).toEqual(['git diff --check'])
  })
})
