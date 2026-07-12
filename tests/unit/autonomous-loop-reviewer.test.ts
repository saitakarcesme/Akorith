import { describe, expect, it } from 'vitest'
import { deterministicLoopReview, mergeLoopReviews } from '../../src/main/autonomous-loop/reviewer'
import type { LoopPlannedTask, LoopValidationResult } from '../../src/main/autonomous-loop/types'

const task: LoopPlannedTask = {
  title: 'Harden auth', proposedTask: 'Harden auth validation', reason: 'Evidence', expectedUserValue: 'Safer auth',
  likelyAreas: ['src/auth'], acceptanceCriteria: ['Reject unsafe token'], validationCommands: ['npm test'],
  riskLevel: 'medium', estimatedComplexity: 'small', kind: 'bug_fix'
}
const validation: LoopValidationResult = {
  passed: true, commands: [], changedFiles: ['src/auth/token.ts'], regressionDetected: false, failureSummary: null
}

describe('Loop reviewer', () => {
  it('accepts a relevant passing source diff', () => {
    const review = deterministicLoopReview({
      task, validation,
      diff: { changedFiles: ['src/auth/token.ts'], deletedFiles: [], addedDiff: '+return validate(token)', truncated: false }
    })
    expect(review.accepted).toBe(true)
  })

  it('vetoes secrets, placeholders, and deleted tests even if a model approves', () => {
    const deterministic = deterministicLoopReview({
      task, validation,
      diff: {
        changedFiles: ['src/auth/token.ts', 'src/auth/token.test.ts'],
        deletedFiles: ['src/auth/token.test.ts'],
        addedDiff: '+const key = "AKIAABCDEFGHIJKLMNOP"\n+// TODO: implement',
        truncated: false
      }
    })
    const merged = mergeLoopReviews(deterministic, {
      ...deterministic,
      accepted: true,
      secretFindings: [],
      placeholdersDetected: [],
      deletedTestsDetected: [],
      rationale: 'Looks good.'
    })
    expect(merged.accepted).toBe(false)
    expect(merged.secretFindings).toContain('AWS access key')
    expect(merged.deletedTestsDetected).toContain('src/auth/token.test.ts')
    expect(merged.placeholdersDetected).toHaveLength(1)
  })
})
