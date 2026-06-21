import assert from 'node:assert/strict'
import {
  boundSnapshot,
  stripAnsi,
  detectPermissionPrompt,
  decidePermissionPolicy,
  parseSummaryJson,
  heuristicSummary,
  buildSummarizerPrompt,
  evaluateAutoOutcome,
  renderSummaryText
} from '../src/main/agentic-core.ts'

// ---------- snapshot bounding is read-only + bounded ----------

const big = Array.from({ length: 5000 }, (_, i) => `line ${i} value`).join('\n')
const bounded = boundSnapshot(big, 2000, 50)
assert.ok(bounded.chars <= 2000, 'snapshot chars are capped')
assert.ok(bounded.lines <= 51, 'snapshot lines are capped')
assert.equal(bounded.truncated, true, 'oversized snapshot is marked truncated')
// boundSnapshot returns a value object and never mutates its input.
const original = 'unchanged'
boundSnapshot(original, 10, 10)
assert.equal(original, 'unchanged', 'boundSnapshot does not mutate input')

// ANSI / bracketed-paste is stripped; normal text with > and = survives.
assert.equal(stripAnsi('\x1b[31mred\x1b[0m text'), 'red text')
assert.equal(stripAnsi('a > b = c'), 'a > b = c', 'comparison chars are preserved')
assert.equal(stripAnsi('\x1b[200~pasted\x1b[201~'), 'pasted')

// ---------- permission detector on sample prompts ----------

const numbered = detectPermissionPrompt(`Do you want to proceed?
1. Yes
2. Yes, and always allow edits
3. No`)
assert.equal(numbered.detected, true, 'numbered menu detected')
assert.equal(numbered.kind, 'numbered_choice')
assert.equal(numbered.suggestedAction, '1', 'picks the one-time Yes, not "always allow"')
assert.equal(numbered.requiresUserReview, true)

const yn = detectPermissionPrompt('Continue? (y/n)')
assert.equal(yn.detected, true)
assert.equal(yn.kind, 'yes_no')
assert.equal(yn.riskLevel, 'low')
assert.equal(yn.suggestedAction, 'y')

const enter = detectPermissionPrompt('Press enter to continue')
assert.equal(enter.detected, true)
assert.equal(enter.kind, 'press_enter')
assert.equal(enter.riskLevel, 'low')

const destructive = detectPermissionPrompt('This will run rm -rf build. Do you want to proceed?')
assert.equal(destructive.detected, true)
assert.equal(destructive.riskLevel, 'high', 'destructive context escalates risk')
assert.equal(destructive.suggestedAction, '', 'no auto-answer for destructive prompts')

const access = detectPermissionPrompt('Akorith requires permission to allow access to the network.')
assert.equal(access.detected, true)
assert.equal(access.requiresUserReview, true)

const trustWorkspace = detectPermissionPrompt('Do you trust the files in this workspace? Press Enter to continue')
assert.equal(trustWorkspace.detected, true, 'workspace trust prompt detected')
assert.equal(trustWorkspace.kind, 'allow_access')
assert.equal(trustWorkspace.riskLevel, 'medium')
assert.equal(trustWorkspace.requiresUserReview, true, 'workspace trust requires review')
assert.equal(trustWorkspace.suggestedAction, '', 'workspace trust has no auto-answer')

assert.equal(detectPermissionPrompt('just some normal build output\nDone in 2s').detected, false)

// ---------- low/medium/high policy decisions ----------

// Approval mode never auto-answers, even a benign prompt.
assert.equal(decidePermissionPolicy({ mode: 'approval', detection: yn, confidence: 0.9 }).decision, 'pause_for_user')
// Auto mode: low-risk one-time + high confidence -> auto_send.
assert.equal(decidePermissionPolicy({ mode: 'auto', detection: yn, confidence: 0.9 }).decision, 'auto_send')
// Auto mode: low-risk but low confidence -> pause.
assert.equal(decidePermissionPolicy({ mode: 'auto', detection: yn, confidence: 0.4 }).decision, 'pause_for_user')
// Auto mode: medium/high risk -> always pause.
assert.equal(decidePermissionPolicy({ mode: 'auto', detection: numbered, confidence: 0.99 }).decision, 'pause_for_user')
assert.equal(decidePermissionPolicy({ mode: 'auto', detection: destructive, confidence: 0.99 }).decision, 'pause_for_user')
assert.equal(decidePermissionPolicy({ mode: 'auto', detection: trustWorkspace, confidence: 0.99 }).decision, 'pause_for_user')
// No prompt -> ignore.
assert.equal(
  decidePermissionPolicy({ mode: 'auto', detection: detectPermissionPrompt('nothing here'), confidence: 1 }).decision,
  'ignore'
)

// ---------- summarizer: model parse + heuristic fallback ----------

const modelSummary = parseSummaryJson(`Here you go:
\`\`\`json
{
  "changed_files": ["src/a.ts"],
  "commands_run": ["npm test"],
  "tests_run": "12 passed",
  "failures": [],
  "current_status": "tests pass",
  "likely_next_step": "commit",
  "confidence": 0.82,
  "needs_user_attention": false
}
\`\`\``)
assert.ok(modelSummary, 'model summary parses')
assert.equal(modelSummary?.source, 'model')
assert.equal(modelSummary?.changedFiles[0], 'src/a.ts')
assert.equal(modelSummary?.confidence, 0.82)
assert.equal(parseSummaryJson('not json at all'), null, 'unusable JSON returns null (caller falls back)')

const heur = heuristicSummary('Running npm test\n  src/foo.ts updated\nError: boom failed\n')
assert.equal(heur.source, 'heuristic')
assert.ok(heur.failures.length >= 1, 'heuristic detects failure lines')
assert.equal(heur.needsUserAttention, true)
assert.ok(heur.confidence < 0.6, 'heuristic confidence is low')

const prompt = buildSummarizerPrompt({ goal: 'Ship it', lastPrompt: 'run tests', snapshot: 'output', turnIndex: 2 })
assert.match(prompt, /Ship it/)
assert.match(prompt, /Return ONLY JSON/)
assert.match(prompt, /internal orchestration call/, 'summarizer is framed as a meta call (no usage_event)')

assert.match(renderSummaryText(heur), /confidence/)

// ---------- Auto Mode stop/continue gates ----------

// Stops on max iterations.
assert.deepEqual(
  evaluateAutoOutcome({ iteration: 5, maxIterations: 5, consecutiveFailures: 0, threshold: 85, summary: null }),
  { action: 'stop', reason: 'max_iterations' }
)
// Completes when good-enough reached.
assert.equal(
  evaluateAutoOutcome({ iteration: 2, maxIterations: 5, consecutiveFailures: 0, doneScore: 90, threshold: 85, summary: null }).action,
  'complete'
)
// Phase 22: fully automatic — soft signals no longer pause. A couple of failures
// keep going (the critic re-plans); only the hard cap (>=4) stops cleanly.
assert.equal(
  evaluateAutoOutcome({ iteration: 2, maxIterations: 5, consecutiveFailures: 2, threshold: 85, summary: null }).action,
  'continue'
)
assert.deepEqual(
  evaluateAutoOutcome({ iteration: 2, maxIterations: 5, consecutiveFailures: 4, threshold: 85, summary: null }),
  { action: 'stop', reason: 'too_many_failures' }
)
// A summary that "needs attention" no longer pauses — it continues.
assert.equal(
  evaluateAutoOutcome({ iteration: 2, maxIterations: 5, consecutiveFailures: 0, threshold: 85, summary: heur }).action,
  'continue'
)
// Otherwise continues.
assert.equal(
  evaluateAutoOutcome({
    iteration: 2,
    maxIterations: 5,
    consecutiveFailures: 0,
    threshold: 85,
    summary: { ...heur, failures: [], needsUserAttention: false, confidence: 0.8 }
  }).action,
  'continue'
)

// Permission responses are always short one-time tokens (never arbitrary commands),
// and the only path that sends them in macro.ts is bridgeSend -> PtyManager.write().
for (const det of [yn, enter, numbered]) {
  assert.ok(det.suggestedAction.length <= 3, 'permission responses are short tokens')
}

console.log('verify-agentic-loop: ok')
