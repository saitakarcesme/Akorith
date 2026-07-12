// Shared execution-observation core. Electron-free and side-effect-free so it stays
// headlessly verifiable (scripts/verify-agentic-loop.ts): terminal-snapshot
// bounding, permission-prompt detection, executor-result summarization (model
// JSON parse + heuristic fallback), and conservative permission policy gates.
//
// Nothing here writes to a terminal, a DB, or a provider. The orchestrator
// calls these helpers and routes any actual send through bridgeSend().

export type AgentRiskLevel = 'low' | 'medium' | 'high'

export type LoopMode = 'approval' | 'auto'

// ---------- terminal snapshot bounding ----------

// Strip ANSI escape sequences (CSI, OSC, single-char escapes) and bracketed-paste
// markers so summaries/detectors see plain text. ESC is .
const ANSI_CSI = /\[[0-?]*[ -/]*[@-~]/g
const ANSI_OSC = /\][^]*(?:|\\)/g
const ANSI_SINGLE = /[@-Z\\-_]/g
const PASTE_MARK = /\[2[01]0~/g

export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_SINGLE, '')
    .replace(PASTE_MARK, '')
    .replace(/\r/g, '')
}

export interface BoundedSnapshot {
  text: string
  lines: number
  chars: number
  truncated: boolean
}

/** Last `maxLines` lines and at most `maxChars` chars of cleaned terminal text. */
export function boundSnapshot(raw: string, maxChars = 8000, maxLines = 200): BoundedSnapshot {
  const cleaned = stripAnsi(raw)
  const allLines = cleaned.split('\n')
  let lines = allLines
  let truncated = false
  if (lines.length > maxLines) {
    lines = lines.slice(lines.length - maxLines)
    truncated = true
  }
  let text = lines.join('\n')
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars)
    truncated = true
  }
  return { text, lines: text.split('\n').length, chars: text.length, truncated }
}

// ---------- permission-prompt detection ----------

export type PermissionKind =
  | 'numbered_choice'
  | 'yes_no'
  | 'press_enter'
  | 'allow_access'
  | 'generic_confirm'
  | 'none'

/** A single selectable answer surfaced to the user in the permission card. */
export interface PermissionOption {
  /** Literal token written to the terminal (e.g. "1", "y", "n", "" for Enter). */
  value: string
  /** Human label shown on the button. */
  label: string
  /** Tone hint for styling: a yes-ish, no-ish, or neutral choice. */
  tone: 'affirm' | 'deny' | 'neutral'
  /** A permanent "always allow" option — surfaced but never auto-selected. */
  permanent?: boolean
}

export interface PermissionDetection {
  detected: boolean
  kind: PermissionKind
  /** Literal response to send (e.g. "1", "y", "" for Enter). Empty when review-only. */
  suggestedAction: string
  riskLevel: AgentRiskLevel
  rationale: string
  requiresUserReview: boolean
  matchedText?: string
  /** Phase 14.1: the prompt question line, surfaced in the UI permission card. */
  question?: string
  /** Phase 14.1: concrete answer buttons for the UI card (review-gated, never auto). */
  options?: PermissionOption[]
}

// Words that make any prompt high-risk and never auto-answerable.
const DESTRUCTIVE = /\b(rm\s+-rf|rm\s+-r|sudo|force[- ]?push|push\s+--force|--force|delete|drop\s+(table|database)|truncate|format\s+disk|wipe|overwrite|reset\s+--hard|chmod\s+777|mkfs)\b|curl[^\n]*\|\s*(sh|bash)/i
// "Permanent allow" options must never be auto-selected this phase.
const ALWAYS_ALLOW = /\b(always\s+allow|don'?t\s+ask\s+again|remember\s+this|allow\s+all|yes,?\s+and\s+always)\b/i
const TRUST_WORKSPACE = /\btrust\b[\s\S]{0,140}\b(folder|directory|workspace|repo|repository|files)\b|\b(folder|directory|workspace|repo|repository|files)\b[\s\S]{0,140}\btrust\b/i

const NONE: PermissionDetection = {
  detected: false,
  kind: 'none',
  suggestedAction: '',
  riskLevel: 'low',
  rationale: 'No permission prompt detected in recent output.',
  requiresUserReview: false
}

/**
 * Conservative detector over the tail of terminal output. Picks one-time "Yes"
 * for clear low-risk confirmations; escalates to user review for anything that
 * is destructive, a permanent allow, or otherwise ambiguous.
 */
/** The most recent non-empty line that looks like the actual question. */
function questionLine(tail: string): string {
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean)
  const q = [...lines].reverse().find((l) => /\?|proceed|continue|allow|confirm|permission|approve|trust|press enter/i.test(l))
  return (q ?? lines[lines.length - 1] ?? '').slice(0, 200)
}

export function detectPermissionPrompt(snapshot: string): PermissionDetection {
  const clean = stripAnsi(snapshot)
  const tail = clean.split('\n').slice(-25).join('\n')
  const lower = tail.toLowerCase()
  const destructive = DESTRUCTIVE.test(tail)
  const permanentOption = ALWAYS_ALLOW.test(tail)
  const workspaceTrust = TRUST_WORKSPACE.test(tail)

  // Numbered choice menus, e.g. "1. Yes  2. Yes, and always allow  3. No".
  const numbered = [...tail.matchAll(/^\s*(\d+)[).]\s*(.+)$/gm)].map((m) => ({
    num: m[1],
    label: m[2].trim()
  }))
  if (numbered.length >= 2 && /\b(yes|no|proceed|allow|approve)\b/i.test(tail)) {
    // Prefer the first "yes/proceed/approve" option that is NOT a permanent allow.
    const oneTimeYes = numbered.find(
      (o) => /\b(yes|proceed|approve|allow)\b/i.test(o.label) && !ALWAYS_ALLOW.test(o.label)
    )
    const risk: AgentRiskLevel = destructive ? 'high' : 'medium'
    const options: PermissionOption[] = numbered.map((o) => ({
      value: o.num,
      label: `${o.num}. ${o.label}`,
      tone: ALWAYS_ALLOW.test(o.label)
        ? 'neutral'
        : /\b(yes|proceed|approve|allow)\b/i.test(o.label)
          ? 'affirm'
          : /\bno\b|cancel|reject|deny/i.test(o.label)
            ? 'deny'
            : 'neutral',
      permanent: ALWAYS_ALLOW.test(o.label)
    }))
    return {
      detected: true,
      kind: 'numbered_choice',
      suggestedAction: oneTimeYes ? oneTimeYes.num : '',
      riskLevel: risk,
      rationale: destructive
        ? 'Numbered prompt near a destructive command — user must choose.'
        : `Numbered confirmation; one-time option is "${oneTimeYes?.label ?? 'unclear'}".`,
      // Numbered menus are always medium+ risk here, so always review unless Auto
      // policy explicitly clears a low-risk case (which this branch never is).
      requiresUserReview: true,
      matchedText: tail.slice(-200),
      question: questionLine(tail),
      options
    }
  }

  // Codex-style "trust this folder/workspace/repo" prompts are access decisions.
  // Surface them through the permission UI/policy instead of answering inside
  // terminal startup, because the exact safe keystroke depends on the TUI.
  if (workspaceTrust) {
    return {
      detected: true,
      kind: 'allow_access',
      suggestedAction: '',
      riskLevel: destructive ? 'high' : 'medium',
      rationale: 'Workspace trust request — review it in Activity before continuing.',
      requiresUserReview: true,
      matchedText: tail.slice(-200),
      question: questionLine(tail),
      options: []
    }
  }

  // "Allow access / approval required / permission" — treat cautiously.
  if (/\b(allow access|approval required|permission|grant access)\b/i.test(lower)) {
    return {
      detected: true,
      kind: 'allow_access',
      suggestedAction: '',
      riskLevel: destructive ? 'high' : 'medium',
      rationale: 'Access/permission request — always needs user review.',
      requiresUserReview: true,
      matchedText: tail.slice(-200),
      question: questionLine(tail),
      options: [
        { value: 'y', label: 'Allow once', tone: 'affirm' },
        { value: 'n', label: 'Deny', tone: 'deny' }
      ]
    }
  }

  // Yes/No confirmations: "Do you want to proceed?", "continue? (y/n)", "confirm".
  if (/\b(do you want to proceed|are you sure|continue\?|confirm\b|proceed\?|\(y\/n\)|\[y\/n\])/i.test(lower)) {
    const risk: AgentRiskLevel = destructive ? 'high' : permanentOption ? 'medium' : 'low'
    return {
      detected: true,
      kind: 'yes_no',
      suggestedAction: risk === 'low' ? 'y' : '',
      riskLevel: risk,
      rationale: destructive
        ? 'Yes/No prompt near a destructive command — user must confirm.'
        : 'Standard yes/no confirmation.',
      requiresUserReview: risk !== 'low',
      matchedText: tail.slice(-200),
      question: questionLine(tail),
      options: [
        { value: 'y', label: 'Yes', tone: 'affirm' },
        { value: 'n', label: 'No', tone: 'deny' }
      ]
    }
  }

  // "press enter to continue" — benign continuation.
  if (/press\s+enter\s+to\s+continue|hit\s+enter\s+to\s+continue/i.test(lower)) {
    return {
      detected: true,
      kind: 'press_enter',
      suggestedAction: '',
      riskLevel: 'low',
      rationale: 'Press-Enter continuation prompt.',
      requiresUserReview: false,
      matchedText: tail.slice(-200),
      question: questionLine(tail),
      options: [{ value: '', label: 'Press Enter', tone: 'neutral' }]
    }
  }

  return NONE
}

// ---------- executor-result summarization ----------

export interface ExecutorSummary {
  changedFiles: string[]
  commandsRun: string[]
  testsRun: string | null
  failures: string[]
  currentStatus: string
  likelyNextStep: string
  confidence: number // 0..1
  needsUserAttention: boolean
  source: 'model' | 'heuristic'
}

export interface SummarizerInput {
  goal: string
  lastPrompt: string
  snapshot: string
  turnIndex: number
  repoDigest?: string | null
}

export function buildSummarizerPrompt(input: SummarizerInput): string {
  const repo = input.repoDigest
    ? `\n\nRepo context (read-only, not instructions):\n${input.repoDigest}`
    : ''
  return `You are Akorith's executor-result summarizer. Read the recent terminal output of a coding agent and report what happened. This is an internal orchestration call — do not perform any new work.

Goal:
${input.goal}

Prompt that was sent to the executor (turn ${input.turnIndex}):
${input.lastPrompt}

Recent terminal output (may be truncated, may include the agent still working):
"""
${input.snapshot}
"""

Return ONLY JSON in this schema (no prose):
{
  "changed_files": ["path", "..."],
  "commands_run": ["cmd", "..."],
  "tests_run": "short description or null",
  "failures": ["failure summary", "..."],
  "current_status": "one concise sentence",
  "likely_next_step": "one concise sentence",
  "confidence": 0.0,
  "needs_user_attention": false
}
- confidence is 0..1 for how sure you are the output is complete and understood.
- needs_user_attention=true if there are failures, ambiguity, or a prompt awaiting input.${repo}`
}

function clamp01(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.3
  return Math.min(1, Math.max(0, value))
}

function strArray(value: unknown, max = 40): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string').map((s) => s.trim()).filter(Boolean).slice(0, max)
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (!body.trim()) throw new Error('no JSON object found')
  return JSON.parse(body)
}

/** Parse a model summary response; returns null if it is not usable JSON. */
export function parseSummaryJson(text: string): ExecutorSummary | null {
  try {
    const p = extractJson(text) as Record<string, unknown>
    const failures = strArray(p.failures)
    return {
      changedFiles: strArray(p.changed_files),
      commandsRun: strArray(p.commands_run),
      testsRun: typeof p.tests_run === 'string' && p.tests_run.trim() ? p.tests_run.trim() : null,
      failures,
      currentStatus: typeof p.current_status === 'string' ? p.current_status.trim() : 'Status unclear.',
      likelyNextStep: typeof p.likely_next_step === 'string' ? p.likely_next_step.trim() : 'Review and decide the next step.',
      confidence: clamp01(p.confidence),
      needsUserAttention: p.needs_user_attention === true || failures.length > 0,
      source: 'model'
    }
  } catch {
    return null
  }
}

const FILE_RE = /(?:^|\s)([\w./-]+\.(?:ts|tsx|js|jsx|json|py|md|css|html|rs|go|java|c|cpp|h|sh|yml|yaml|toml))\b/g
const CMD_RE = /^\s*(?:[$#>]|PS[^>]*>)\s*(.+)$/gm
const FAIL_RE = /\b(error|failed|failure|traceback|fatal|exception|cannot|not found|denied)\b/i
const PASS_RE = /\b(\d+\s+pass(?:ed|ing)|all tests pass|build succeeded)\b/i

/** Deterministic fallback when the summarizer provider call fails or is absent. */
export function heuristicSummary(snapshot: string): ExecutorSummary {
  const clean = stripAnsi(snapshot)
  const changedFiles = [...new Set([...clean.matchAll(FILE_RE)].map((m) => m[1]))].slice(0, 30)
  const commandsRun = [...new Set([...clean.matchAll(CMD_RE)].map((m) => m[1].trim()))].filter(Boolean).slice(0, 20)
  const failingLines = clean
    .split('\n')
    .filter((l) => FAIL_RE.test(l))
    .map((l) => l.trim())
    .slice(0, 10)
  const permission = detectPermissionPrompt(snapshot)
  const hasFailures = failingLines.length > 0
  const passed = PASS_RE.test(clean)
  const status = hasFailures
    ? 'Output contains failure/error indicators.'
    : permission.detected
      ? 'A prompt appears to be awaiting input.'
      : passed
        ? 'Output suggests success.'
        : 'Captured terminal output; status not certain.'
  return {
    changedFiles,
    commandsRun,
    testsRun: passed ? 'Test/build success indicators found.' : hasFailures ? 'Failures present.' : null,
    failures: failingLines,
    currentStatus: status,
    likelyNextStep: hasFailures ? 'Address the reported failures.' : 'Review output and continue or verify.',
    confidence: 0.3,
    needsUserAttention: hasFailures || permission.detected,
    source: 'heuristic'
  }
}

// ---------- Auto-Mode safety policy ----------

export type PermissionDecision = 'auto_send' | 'pause_for_user' | 'ignore'

export interface PolicyInput {
  mode: LoopMode
  detection: PermissionDetection
  confidence: number // summarizer confidence 0..1
}

const AUTO_CONFIDENCE_MIN = 0.6

/**
 * Decide what to do about a detected permission prompt. Approval Mode never
 * auto-answers. Auto Mode auto-sends only low-risk, one-time, high-confidence
 * confirmations with a concrete suggested response; everything else pauses.
 */
export function decidePermissionPolicy(input: PolicyInput): { decision: PermissionDecision; reason: string } {
  if (!input.detection.detected) return { decision: 'ignore', reason: 'no permission prompt' }
  if (input.mode === 'approval') {
    return { decision: 'pause_for_user', reason: 'approval mode never auto-answers permission prompts' }
  }
  const d = input.detection
  if (d.riskLevel !== 'low') return { decision: 'pause_for_user', reason: `risk ${d.riskLevel} requires user review` }
  if (d.requiresUserReview) return { decision: 'pause_for_user', reason: 'prompt flagged for user review' }
  if (d.suggestedAction === '' && d.kind !== 'press_enter') {
    return { decision: 'pause_for_user', reason: 'no safe one-time response available' }
  }
  if (input.confidence < AUTO_CONFIDENCE_MIN) {
    return { decision: 'pause_for_user', reason: 'summarizer confidence too low to auto-answer' }
  }
  return { decision: 'auto_send', reason: 'low-risk one-time confirmation auto-answered' }
}

// ---------- Auto-Mode stop/continue gates ----------

export interface AutoStopInput {
  iteration: number
  maxIterations: number
  consecutiveFailures: number
  doneScore?: number | null
  threshold: number
  summary?: ExecutorSummary | null
  /** Phase 19: measured result grade. Takes precedence over the predicted doneScore. */
  critic?: CriticReview | null
}

export type AutoOutcome =
  | { action: 'continue' }
  | { action: 'complete'; reason: string }
  | { action: 'stop'; reason: string }
  | { action: 'pause'; reason: string }

// Phase 22: the loop is fully automatic. Too many consecutive hard failures end
// the run cleanly (a clear stop, never a dead pause that waits on the user).
const MAX_AUTO_FAILURES = 4

/**
 * Gate evaluated after each turn is summarized and graded. Phase 22: fully
 * automatic — it returns continue / complete / stop, never pause. Soft signals
 * (needs-attention, low confidence, a one-off regression) keep the loop going;
 * the critic's gaps steer the next plan. Only the goal being met (complete),
 * the iteration cap, or repeated hard failures (stop) end it.
 */
export function evaluateAutoOutcome(input: AutoStopInput): AutoOutcome {
  const critic = input.critic ?? null
  // The critic grades the ACTUAL result against the goal, so prefer it over the
  // planner's pre-execution prediction (doneScore) when deciding completion.
  if (critic && (critic.goalMet || critic.verdict === 'complete') && critic.progressScore >= input.threshold) {
    return { action: 'complete', reason: 'critic_goal_met' }
  }
  const effectiveScore =
    critic && Number.isFinite(critic.progressScore) ? critic.progressScore : input.doneScore
  if (typeof effectiveScore === 'number' && effectiveScore >= input.threshold) {
    return {
      action: 'complete',
      reason: critic ? 'critic_threshold_reached' : 'good_enough_threshold_reached'
    }
  }
  if (input.iteration >= input.maxIterations) {
    return { action: 'stop', reason: 'max_iterations' }
  }
  if (input.consecutiveFailures >= MAX_AUTO_FAILURES) {
    return { action: 'stop', reason: 'too_many_failures' }
  }
  return { action: 'continue' }
}

// ---------- Phase 19: critic / verifier (closed-loop evaluation) ----------
//
// The summarizer says WHAT happened; the critic judges HOW WELL it advanced the
// goal. Its measured progressScore replaces the planner's pre-execution guess in
// the stop/continue gate, and its gaps/recommendation feed the next planner turn
// — closing the plan → act → observe → evaluate → re-plan loop. Pure + headless:
// it is a meta call in macro.ts with a deterministic heuristic fallback here.

/** How the latest result moved the goal forward. */
export type CriticVerdict = 'advanced' | 'stalled' | 'regressed' | 'complete'
/** What the loop should do next, per the critic. */
export type CriticRecommendation = 'continue' | 'refine' | 'done' | 'escalate'

export interface CriticReview {
  /** 0..100 measured progress toward the goal based on the ACTUAL result. */
  progressScore: number
  verdict: CriticVerdict
  /** True only when the critic judges the goal fully satisfied. */
  goalMet: boolean
  /** Concrete gaps still standing between the result and the goal. */
  gaps: string[]
  recommendation: CriticRecommendation
  rationale: string
  confidence: number // 0..1
  source: 'model' | 'heuristic'
}

export interface CriticInput {
  goal: string
  lastPrompt: string
  summary: ExecutorSummary
  snapshot: string
  turnIndex: number
  threshold: number
  /** Progress scores of prior turns, oldest→newest, to detect regression/stall. */
  priorScores: number[]
}

export function buildCriticPrompt(input: CriticInput): string {
  const prior =
    input.priorScores.length > 0
      ? input.priorScores.map((n, i) => `turn ${i + 1}: ${n}/100`).join(', ')
      : 'none yet'
  return `You are Akorith's macro-loop critic. Judge how well the executor's LATEST result advanced the goal. This is an internal orchestration call — do NOT perform or propose new work, only evaluate what already happened.

Goal:
${input.goal}

Prompt sent to the executor (turn ${input.turnIndex}):
${input.lastPrompt}

Summarizer's read of what the executor did:
"""
${renderSummaryText(input.summary)}
"""

Recent terminal output (may be truncated):
"""
${input.snapshot}
"""

Prior progress scores: ${prior}
Good-enough threshold: ${input.threshold}/100

Grade strictly against the goal, not effort. Reward verified, complete progress; penalize failures, regressions, and unverified claims.

Return ONLY JSON in this schema (no prose):
{
  "progress_score": 0,
  "verdict": "advanced" | "stalled" | "regressed" | "complete",
  "goal_met": false,
  "gaps": ["concrete remaining gap", "..."],
  "recommendation": "continue" | "refine" | "done" | "escalate",
  "rationale": "one or two concise sentences",
  "confidence": 0.0
}
- progress_score is 0..100 total progress toward the goal AFTER this turn (not the delta).
- verdict "regressed" if this turn made things worse; "complete" only if the goal is fully met.
- recommendation "escalate" if a human must intervene (repeated failure, destructive/ambiguous state).
- confidence is 0..1 in your own judgement given the available output.`
}

function verdict(value: unknown): CriticVerdict {
  return value === 'advanced' || value === 'stalled' || value === 'regressed' || value === 'complete'
    ? value
    : 'stalled'
}

function recommendation(value: unknown): CriticRecommendation {
  return value === 'continue' || value === 'refine' || value === 'done' || value === 'escalate'
    ? value
    : 'continue'
}

function clampScore100(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** Parse a model critic response; returns null if it is not usable JSON. */
export function parseCriticReview(text: string): CriticReview | null {
  try {
    const p = extractJson(text) as Record<string, unknown>
    const v = verdict(p.verdict)
    return {
      progressScore: clampScore100(p.progress_score),
      verdict: v,
      goalMet: p.goal_met === true || v === 'complete',
      gaps: strArray(p.gaps),
      recommendation: recommendation(p.recommendation),
      rationale: typeof p.rationale === 'string' ? p.rationale.trim() : '',
      confidence: clamp01(p.confidence),
      source: 'model'
    }
  } catch {
    return null
  }
}

/**
 * Deterministic fallback when the critic provider call fails or returns junk.
 * Derives a grade from the summarizer's structured read plus prior scores so the
 * loop still has a usable progress signal and can detect regression.
 */
export function heuristicCritic(summary: ExecutorSummary, priorScores: number[]): CriticReview {
  const prevBest = priorScores.length ? Math.max(...priorScores) : 0
  const hasFailures = summary.failures.length > 0
  const passed = summary.testsRun != null && /pass|succe/i.test(summary.testsRun)
  const progressed = summary.changedFiles.length > 0 || summary.commandsRun.length > 0

  let progressScore: number
  let v: CriticVerdict
  if (hasFailures) {
    // A failure after earlier progress reads as a regression.
    progressScore = Math.max(0, Math.min(prevBest, 40) - 10)
    v = prevBest > progressScore + 5 ? 'regressed' : 'stalled'
  } else if (passed) {
    progressScore = Math.max(prevBest, 80)
    v = 'advanced'
  } else if (progressed) {
    progressScore = Math.max(prevBest, 50)
    v = prevBest >= progressScore ? 'stalled' : 'advanced'
  } else {
    progressScore = Math.max(prevBest, 20)
    v = 'stalled'
  }

  const goalMet = passed && !summary.needsUserAttention
  return {
    progressScore,
    verdict: goalMet ? 'complete' : v,
    goalMet,
    gaps: hasFailures ? summary.failures.slice(0, 3) : progressed ? ['Verify the change satisfies the goal.'] : ['No concrete progress detected yet.'],
    recommendation: hasFailures ? 'refine' : goalMet ? 'done' : 'continue',
    rationale: `Heuristic grade from the result summary (${v}); model critic was unavailable.`,
    confidence: 0.3,
    source: 'heuristic'
  }
}

/** One-line human summary persisted alongside the turn. */
export function renderCriticText(c: CriticReview): string {
  const parts: string[] = [`Critic: ${c.progressScore}/100 · ${c.verdict} · ${c.recommendation}`]
  if (c.rationale) parts.push(c.rationale)
  if (c.gaps.length) parts.push(`Gaps: ${c.gaps.slice(0, 3).join(' | ')}`)
  parts.push(`(${c.source}, confidence ${Math.round(c.confidence * 100)}%)`)
  return parts.join('\n')
}

/** One-line human summary string persisted into macro_turns.executor_result_summary. */
export function renderSummaryText(s: ExecutorSummary): string {
  const parts: string[] = [s.currentStatus]
  if (s.changedFiles.length) parts.push(`Changed: ${s.changedFiles.slice(0, 8).join(', ')}`)
  if (s.testsRun) parts.push(`Tests: ${s.testsRun}`)
  if (s.failures.length) parts.push(`Failures: ${s.failures.slice(0, 3).join(' | ')}`)
  parts.push(`Next: ${s.likelyNextStep}`)
  parts.push(`(${s.source}, confidence ${Math.round(s.confidence * 100)}%)`)
  return parts.join('\n')
}
