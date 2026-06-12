import assert from 'node:assert/strict'
import {
  buildPlannerPrompt,
  goodEnoughReached,
  maxIterationsReached,
  parsePlannerProposal
} from '../src/main/macro-core.ts'

const parsed = parsePlannerProposal(`{
  "next_prompt": "Inspect src/main/macro.ts and report issues.",
  "rationale": "Start with the orchestration core.",
  "expected_result": "A concise report.",
  "done_score": 42,
  "risk_level": "low",
  "requires_user_approval": true
}`)

assert.equal(parsed.parseOk, true)
assert.equal(parsed.nextPrompt, 'Inspect src/main/macro.ts and report issues.')
assert.equal(parsed.doneScore, 42)
assert.equal(parsed.riskLevel, 'low')
assert.equal(parsed.requiresUserApproval, true)

const fenced = parsePlannerProposal('```json\n{"next_prompt":"Run typecheck","done_score":95,"risk_level":"medium","requires_user_approval":true}\n```')
assert.equal(fenced.parseOk, true)
assert.equal(fenced.doneScore, 95)
assert.equal(goodEnoughReached(fenced.doneScore, 85), true)

const fallback = parsePlannerProposal('Please run npm run typecheck and report back.')
assert.equal(fallback.parseOk, false)
assert.match(fallback.nextPrompt, /typecheck/)
assert.equal(fallback.requiresUserApproval, true)

assert.equal(maxIterationsReached(0, 1), false)
assert.equal(maxIterationsReached(1, 1), true)
assert.equal(maxIterationsReached(5, 3), true)
assert.equal(goodEnoughReached(84, 85), false)
assert.equal(goodEnoughReached(null, 85), false)

const prompt = buildPlannerPrompt({
  goal: 'Ship Phase 9',
  iteration: 2,
  maxIterations: 5,
  goodEnoughThreshold: 85,
  repoDigest: '## Repo context\nfile tree',
  turns: [
    {
      turnIndex: 1,
      proposal: 'Do first thing',
      sentPrompt: 'Do first thing',
      executorResultSummary: 'Changed files and ran tests.',
      plannerRationale: 'Needed first.',
      goodEnoughScore: 30,
      riskLevel: 'low'
    }
  ]
})

assert.match(prompt, /Ship Phase 9/)
assert.match(prompt, /Iteration: 2 of 5/)
assert.match(prompt, /Changed files and ran tests/)
assert.match(prompt, /Repo context included/)
assert.match(prompt, /Return ONLY JSON/)

console.log('verify-macro-loop: ok')
