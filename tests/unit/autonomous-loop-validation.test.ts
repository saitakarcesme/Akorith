import { describe, expect, it } from 'vitest'
import {
  normalizeLoopLimits,
  parseLoopPlannedTask,
  parseLoopReview,
  validateCreateAutonomousLoopInput
} from '../../src/main/autonomous-loop/validation'

describe('autonomous Loop structured contracts', () => {
  it('accepts a complete planner task and rejects loose prose', () => {
    const result = parseLoopPlannedTask(JSON.stringify({
      title: 'Cover repository setup errors',
      proposed_task: 'Add deterministic validation for missing remotes.',
      reason: 'Repository setup currently fails late.',
      expected_user_value: 'Loop startup explains exactly what needs attention.',
      likely_areas: ['src/main/repository'],
      acceptance_criteria: ['Missing remotes return a typed error', 'Existing setup remains unchanged'],
      validation_commands: ['npm run test:unit'],
      risk_level: 'low',
      estimated_complexity: 'small',
      kind: 'test'
    }))

    expect(result.ok).toBe(true)
    expect(parseLoopPlannedTask('I would probably edit the repository service.')).toEqual({
      ok: false,
      error: 'Planner did not return a JSON object.'
    })
  })

  it('requires every reviewer safety list', () => {
    const result = parseLoopReview(JSON.stringify({
      accepted: true,
      relevant_diff: true,
      acceptance_criteria_met: ['Typed error returned'],
      acceptance_criteria_missed: [],
      placeholders_detected: [],
      deleted_tests_detected: [],
      secret_findings: [],
      unrelated_files: [],
      generated_files_reviewed: [],
      rationale: 'The targeted test and implementation agree.'
    }))
    expect(result.ok).toBe(true)
    expect(parseLoopReview('{"accepted":true,"relevant_diff":true}').ok).toBe(false)
  })

  it('validates the normal project-and-executor setup without a task prompt', () => {
    const result = validateCreateAutonomousLoopInput({
      source: { kind: 'existing_github', remoteUrl: 'https://github.com/example/project.git' },
      executor: {
        catalogId: 'local.ollama.qwen-coder',
        providerId: 'local',
        model: 'qwen2.5-coder:14b',
        location: 'local',
        capabilityProbeId: 'probe-123'
      }
    })
    expect(result.ok).toBe(true)
  })

  it('clamps unsafe optional limits to defaults', () => {
    const limits = normalizeLoopLimits({
      maxRepairAttempts: 999,
      maxConsecutiveInfrastructureFailures: -1,
      validationTimeoutMs: 1,
      costLimitUsd: Number.POSITIVE_INFINITY
    })
    expect(limits.maxRepairAttempts).toBe(3)
    expect(limits.maxConsecutiveInfrastructureFailures).toBe(5)
    expect(limits.validationTimeoutMs).toBe(600_000)
    expect(limits.costLimitUsd).toBeNull()
  })
})
