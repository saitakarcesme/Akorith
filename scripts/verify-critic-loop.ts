import assert from 'node:assert/strict'
import {
  buildCriticPrompt,
  parseCriticReview,
  heuristicCritic,
  renderCriticText,
  evaluateAutoOutcome,
  type ExecutorSummary,
  type CriticReview
} from '../src/main/agentic-core.ts'

// ---------- critic prompt is read-only/evaluation framed ----------

const summary: ExecutorSummary = {
  changedFiles: ['src/a.ts'],
  commandsRun: ['npm test'],
  testsRun: 'all tests passed',
  failures: [],
  currentStatus: 'Implemented feature and tests pass.',
  likelyNextStep: 'Verify edge cases.',
  confidence: 0.8,
  needsUserAttention: false,
  source: 'model'
}

const prompt = buildCriticPrompt({
  goal: 'Add a feature',
  lastPrompt: 'Implement X',
  summary,
  snapshot: 'tests passed',
  turnIndex: 2,
  threshold: 85,
  priorScores: [40]
})
assert.ok(/do NOT perform or propose new work/i.test(prompt), 'critic prompt is evaluation-only')
assert.ok(/progress_score/.test(prompt) && /verdict/.test(prompt), 'critic prompt asks for the schema')
assert.ok(/40\/100/.test(prompt), 'prior scores are surfaced to the critic')

// ---------- model JSON parse + clamping ----------

const parsed = parseCriticReview(`Here you go:
\`\`\`json
{ "progress_score": 142, "verdict": "complete", "goal_met": true, "gaps": ["x", 5], "recommendation": "done", "rationale": "ok", "confidence": 1.5 }
\`\`\``)
assert.ok(parsed, 'valid critic JSON parses')
assert.equal(parsed!.progressScore, 100, 'progress score is clamped to 100')
assert.equal(parsed!.verdict, 'complete')
assert.equal(parsed!.goalMet, true)
assert.deepEqual(parsed!.gaps, ['x'], 'non-string gaps are dropped')
assert.equal(parsed!.confidence, 1, 'confidence clamped to 1')
assert.equal(parsed!.source, 'model')

// "complete" verdict implies goalMet even if goal_met was omitted.
const impliedMet = parseCriticReview('{"progress_score":90,"verdict":"complete","recommendation":"done","confidence":0.9}')
assert.equal(impliedMet!.goalMet, true, 'complete verdict implies goal met')

// Garbage returns null so the orchestrator can fall back to the heuristic.
assert.equal(parseCriticReview('no json here'), null, 'unusable text returns null')

// Unknown enum values are coerced to safe defaults.
const coerced = parseCriticReview('{"progress_score":10,"verdict":"weird","recommendation":"nope","confidence":0.2}')
assert.equal(coerced!.verdict, 'stalled', 'unknown verdict defaults to stalled')
assert.equal(coerced!.recommendation, 'continue', 'unknown recommendation defaults to continue')

// ---------- heuristic fallback is deterministic + detects regression ----------

const failing: ExecutorSummary = { ...summary, testsRun: 'Failures present.', failures: ['boom'], needsUserAttention: true, currentStatus: 'errors' }
const regressed = heuristicCritic(failing, [70])
assert.equal(regressed.verdict, 'regressed', 'failure after prior progress reads as regression')
assert.ok(regressed.progressScore < 70, 'regression lowers the score')
assert.equal(regressed.source, 'heuristic')

const advanced = heuristicCritic(summary, [40])
assert.equal(advanced.verdict, 'complete', 'passing tests with no attention needed = complete')
assert.ok(advanced.progressScore >= 80, 'success scores high')

// renderCriticText is a one-pass human string.
assert.ok(/Critic: \d+\/100/.test(renderCriticText(advanced)), 'critic text shows the score')

// ---------- closed-loop gate prefers the critic over the predicted doneScore ----------

const baseGate = { iteration: 2, maxIterations: 5, consecutiveFailures: 0, threshold: 85, summary } as const

// Critic regression pauses even if the planner predicted a high done score.
assert.equal(
  evaluateAutoOutcome({ ...baseGate, doneScore: 95, critic: regressed }).action,
  'pause',
  'critic regression overrides an optimistic predicted score'
)

// Critic escalation pauses for a human.
const escalate: CriticReview = { ...advanced, recommendation: 'escalate', verdict: 'stalled', goalMet: false, progressScore: 50 }
assert.equal(evaluateAutoOutcome({ ...baseGate, critic: escalate }).action, 'pause')

// Critic-confirmed completion completes the loop.
const done = evaluateAutoOutcome({ ...baseGate, doneScore: 0, critic: { ...advanced, progressScore: 90 } })
assert.equal(done.action, 'complete')
assert.equal(done.reason, 'critic_goal_met')

// A high critic score (not goalMet) still completes via the threshold path.
const highScore: CriticReview = { ...advanced, goalMet: false, verdict: 'advanced', progressScore: 88 }
const thresholdDone = evaluateAutoOutcome({ ...baseGate, doneScore: 0, critic: highScore })
assert.equal(thresholdDone.action, 'complete')
assert.equal(thresholdDone.reason, 'critic_threshold_reached')

// Without a critic, legacy behavior is unchanged (predicted doneScore drives it).
assert.equal(
  evaluateAutoOutcome({ ...baseGate, doneScore: 90 }).reason,
  'good_enough_threshold_reached',
  'legacy doneScore path is preserved when no critic is present'
)

console.log('verify-critic-loop: ok')
