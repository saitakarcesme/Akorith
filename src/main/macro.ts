// Phase 9 + 11 macro-loop orchestration.
//
// Approval Mode (default, Phase 9): planner proposals are meta calls and every
// executor send is approval-gated. Auto Mode (Phase 11, opt-in): the loop can
// auto-send the planner's prompt and auto-answer ONLY low-risk one-time
// confirmations, behind the agentic-core safety gates. Manual Stop always wins.
//
// Terminal injection — proposals AND permission responses — still flows only
// through bridgeSend() -> PtyManager.write(). No second write path. Planner and
// summarizer calls are meta calls (sendMetaPrompt) and write no usage_events.

import { app, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { isAbsolute, join } from 'path'
import { bridgeSend } from './bridge'
import { getBridgeSettings } from './config'
import { buildDigest } from './digest'
import { ptyManager } from './pty'
import {
  addMessage,
  createMacroSession,
  createProject,
  createMacroTurn,
  getMacroSession,
  getMacroState,
  listMacroSessions,
  sessionExists,
  updateMacroSession,
  updateMacroTurn,
  type MacroMode,
  type MacroSessionRow,
  type MacroSessionWithTurns,
  type ProjectRow
} from './db'
import { sendMetaPrompt } from './providers/registry'
import {
  buildIdeaPrompt,
  commitPhase,
  deriveHeadline,
  initWorkspace,
  parseProjectIdea,
  slugify,
  type ProjectIdea
} from './workspace'
import {
  buildPlannerPrompt,
  maxIterationsReached,
  parsePlannerProposal
} from './macro-core'
import {
  boundSnapshot,
  buildCriticPrompt,
  buildSummarizerPrompt,
  detectPermissionPrompt,
  evaluateAutoOutcome,
  heuristicCritic,
  heuristicSummary,
  parseCriticReview,
  parseSummaryJson,
  renderCriticText,
  renderSummaryText,
  type CriticReview,
  type ExecutorSummary,
  type PermissionDetection
} from './agentic-core'

const VALID_ID = /^[\w-]{1,64}$/
const VALID_PROVIDER = /^[a-z0-9-]{1,32}$/
const VALID_MODEL = /^[\w.:/-]{1,64}$/
const VALID_TERMINAL = /^[a-z0-9-]{1,32}$/
const MAX_GOAL_CHARS = 40_000
const MAX_SUMMARY_CHARS = 80_000
const MAX_PROMPT_CHARS = 200_000
const PROPOSE_TIMEOUT_MS = 600_000
const SUMMARIZE_TIMEOUT_MS = 120_000
const CRITIC_TIMEOUT_MS = 120_000
const SNAPSHOT_CHARS = 8000
// Auto-Mode polling: bounded, never spins the CPU.
const POLL_INTERVAL_MS = 1200
const MAX_WAIT_PER_TURN_MS = 30_000
const SHORT_WAIT_MS = 6000
const MAX_AUTO_ACTIONS = 80
// Olympus = Codex (t2), Atlantis = Claude (t1) — for labeling persisted summaries.
const TERMINAL_LABEL: Record<string, string> = { t1: 'Atlantis', t2: 'Olympus' }
const AGENT_ROLE: Record<string, string> = { t1: 'Claude', t2: 'Codex' }

type MacroResponse = { ok: true; state: MacroSessionWithTurns } | { ok: false; error: string; state?: MacroSessionWithTurns }

const activeProposals = new Map<string, AbortController>()
// Active Auto-Mode loops, keyed by session id, so Stop can abort them.
const activeLoops = new Map<string, AbortController>()

// Phase 20: accumulate metered meta-call tokens onto the session so a token
// budget ("till the tokens are gone") can stop the loop. Only the loop's own
// planner/critic/summarizer calls are metered — the external executor agent's
// usage is not visible to Akorith.
function recordMetaUsage(sessionId: string, usage: { promptTokens?: number; completionTokens?: number }): void {
  const tokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)
  if (tokens <= 0) return
  const s = getMacroSession(sessionId)
  if (!s) return
  updateMacroSession(sessionId, { tokensUsed: s.tokensUsed + tokens })
}

function tokenBudgetExceeded(s: MacroSessionRow): boolean {
  return s.tokenBudget > 0 && s.tokensUsed >= s.tokenBudget
}

function state(sessionId: string): MacroSessionWithTurns | undefined {
  return getMacroState(sessionId) ?? undefined
}

function requireState(sessionId: string): MacroSessionWithTurns {
  const s = getMacroState(sessionId)
  if (!s) throw new Error('macro session not found')
  return s
}

function cleanText(text: string, max: number): string {
  return text.trim().slice(0, max)
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(Math.max(n, min), max)
}

async function createSession(args: {
  goal: string
  plannerProvider: string
  plannerModel?: string
  targetTerminal: string
  maxIterations: number
  goodEnoughThreshold: number
  includeRepoDigest: boolean
  mode?: MacroMode
  workspaceDir?: string | null
  autoCommit?: boolean
  tokenBudget?: number
}): Promise<MacroResponse> {
  const session = createMacroSession({
    goal: cleanText(args.goal, MAX_GOAL_CHARS),
    plannerProvider: args.plannerProvider,
    plannerModel: args.plannerModel || undefined,
    targetTerminal: args.targetTerminal,
    maxIterations: clampInt(args.maxIterations, 5, 1, 50),
    goodEnoughThreshold: clampInt(args.goodEnoughThreshold, 85, 1, 100),
    includeRepoDigest: args.includeRepoDigest,
    mode: args.mode === 'auto' ? 'auto' : 'approval',
    workspaceDir: args.workspaceDir || null,
    autoCommit: args.autoCommit ?? false,
    tokenBudget: clampInt(args.tokenBudget ?? 0, 0, 0, 100_000_000)
  })
  return { ok: true, state: requireState(session.id) }
}

async function propose(sessionId: string, extraSignal?: AbortSignal): Promise<MacroResponse> {
  let s = requireState(sessionId)
  if (s.session.status === 'completed' || s.session.status === 'stopped') return { ok: true, state: s }
  if (maxIterationsReached(s.turns.length, s.session.maxIterations)) {
    updateMacroSession(sessionId, { status: 'stopped', stopReason: 'max_iterations' })
    return { ok: true, state: requireState(sessionId) }
  }

  updateMacroSession(sessionId, { status: 'preparing_context' })
  let digest: string | null = null
  if (s.session.includeRepoDigest) {
    try {
      digest = await buildDigest()
    } catch (err) {
      digest = `Repo digest unavailable: ${err instanceof Error ? err.message : String(err)}`
    }
    if (digest) updateMacroSession(sessionId, { repoDigestSnapshot: digest })
  }

  s = requireState(sessionId)
  // Phase 22: fold in any direction the user picked to steer this next step.
  const steering = s.session.pendingSteering
  const prompt = buildPlannerPrompt({
    goal: s.session.goal,
    iteration: s.turns.length + 1,
    maxIterations: s.session.maxIterations,
    goodEnoughThreshold: s.session.goodEnoughThreshold,
    turns: s.turns.map((t) => ({ ...t, criticGaps: turnCriticGaps(t) })),
    repoDigest: digest,
    steering
  })

  updateMacroSession(sessionId, { status: 'proposing' })
  const controller = new AbortController()
  activeProposals.set(sessionId, controller)
  try {
    const signals = [controller.signal, AbortSignal.timeout(PROPOSE_TIMEOUT_MS)]
    if (extraSignal) signals.push(extraSignal)
    const signal = AbortSignal.any(signals)
    const result = await sendMetaPrompt(s.session.plannerProvider, s.session.plannerModel ?? undefined, prompt, signal)
    recordMetaUsage(sessionId, result.usage)
    const current = requireState(sessionId)
    if (current.session.status === 'stopped') return { ok: true, state: current }

    const parsed = parsePlannerProposal(result.text)
    const created = createMacroTurn({
      sessionId,
      turnIndex: current.turns.length + 1,
      status: 'awaiting_approval',
      proposal: parsed.nextPrompt,
      plannerRationale: parsed.rationale,
      expectedResult: parsed.expectedResult,
      goodEnoughScore: parsed.doneScore ?? undefined,
      riskLevel: parsed.riskLevel,
      providerUsed: s.session.plannerProvider,
      modelUsed: result.model,
      error: parsed.parseOk ? undefined : 'planner response was not valid structured JSON'
    })
    // Persist the 3 steering directions for this turn; clear consumed steering.
    updateMacroTurn(created.id, { nextOptions: JSON.stringify(parsed.nextOptions) })
    updateMacroSession(sessionId, {
      status: 'awaiting_approval',
      finalScore: parsed.doneScore ?? undefined,
      ...(steering ? { pendingSteering: null } : {})
    })
    return { ok: true, state: requireState(sessionId) }
  } catch (err) {
    const current = state(sessionId)
    if (current?.session.status === 'stopped') return { ok: true, state: current }
    const message = err instanceof Error ? err.message : String(err)
    const latest = current ?? requireState(sessionId)
    createMacroTurn({
      sessionId,
      turnIndex: latest.turns.length + 1,
      status: 'error',
      providerUsed: latest.session.plannerProvider,
      modelUsed: latest.session.plannerModel ?? undefined,
      error: message
    })
    updateMacroSession(sessionId, { status: 'error', stopReason: message })
    return { ok: false, error: message, state: requireState(sessionId) }
  } finally {
    activeProposals.delete(sessionId)
  }
}

/**
 * Send an approved executor prompt through the single bridge path. Used by the
 * manual approve() IPC and by the Auto-Mode loop (auto=true only logs differently).
 */
function sendApprovedPrompt(sessionId: string, turnId: string, rawText: string, auto: boolean): MacroResponse {
  const s = requireState(sessionId)
  const turn = s.turns.find((t) => t.id === turnId)
  if (!turn) return { ok: false, error: 'macro turn not found', state: s }
  const text = cleanText(rawText || turn.proposal || '', MAX_PROMPT_CHARS)
  if (!text) return { ok: false, error: 'approved prompt is empty', state: s }

  updateMacroSession(sessionId, { status: 'sending' })
  updateMacroTurn(turnId, { status: 'sending', editedProposal: text })
  const send = bridgeSend({
    text,
    targetTerminalId: s.session.targetTerminal,
    autoEnter: getBridgeSettings().autoEnter
  })
  if (!send.ok) {
    updateMacroTurn(turnId, { status: 'awaiting_approval', error: send.error })
    updateMacroSession(sessionId, { status: 'error', stopReason: send.error })
    return { ok: false, error: send.error, state: requireState(sessionId) }
  }
  updateMacroTurn(turnId, {
    status: 'awaiting_executor_result',
    editedProposal: text,
    sentPrompt: text,
    error: null,
    autoAction: auto ? JSON.stringify({ type: 'auto_send_prompt', at: Date.now() }) : null
  })
  if (auto) logAutoAction(sessionId, { type: 'auto_send_prompt', turn: turn.turnIndex, riskLevel: turn.riskLevel ?? 'unknown' })
  updateMacroSession(sessionId, { status: 'awaiting_executor_result' })
  return { ok: true, state: requireState(sessionId) }
}

function approve(args: { sessionId: string; turnId: string; editedProposal?: string }): MacroResponse {
  return sendApprovedPrompt(args.sessionId, args.turnId, args.editedProposal || '', false)
}

function recordResult(args: { sessionId: string; turnId: string; summary: string }): MacroResponse {
  const s = requireState(args.sessionId)
  const turn = s.turns.find((t) => t.id === args.turnId)
  if (!turn) return { ok: false, error: 'macro turn not found', state: s }
  const summary = cleanText(args.summary, MAX_SUMMARY_CHARS)
  updateMacroTurn(args.turnId, {
    status: 'completed',
    executorResultSummary: summary || '(user continued without a summary)'
  })

  const after = requireState(args.sessionId)
  if (maxIterationsReached(after.turns.length, after.session.maxIterations)) {
    updateMacroSession(args.sessionId, { status: 'stopped', stopReason: 'max_iterations' })
  } else {
    updateMacroSession(args.sessionId, { status: 'idle' })
  }
  return { ok: true, state: requireState(args.sessionId) }
}

function skip(args: { sessionId: string; turnId: string }): MacroResponse {
  const s = requireState(args.sessionId)
  const turn = s.turns.find((t) => t.id === args.turnId)
  if (!turn) return { ok: false, error: 'macro turn not found', state: s }
  updateMacroTurn(args.turnId, { status: 'skipped' })
  updateMacroSession(args.sessionId, { status: 'idle' })
  return { ok: true, state: requireState(args.sessionId) }
}

function stop(sessionId: string, reason = 'manual_stop'): MacroResponse {
  activeProposals.get(sessionId)?.abort()
  activeLoops.get(sessionId)?.abort()
  updateMacroSession(sessionId, { status: 'stopped', stopReason: reason, pauseReason: null })
  return { ok: true, state: requireState(sessionId) }
}

function complete(sessionId: string): MacroResponse {
  activeLoops.get(sessionId)?.abort()
  const s = requireState(sessionId)
  const score = s.turns
    .map((t) => t.goodEnoughScore)
    .filter((n): n is number => typeof n === 'number')
    .at(-1)
  updateMacroSession(sessionId, { status: 'completed', stopReason: 'user_complete', finalScore: score ?? undefined, pauseReason: null })
  return { ok: true, state: requireState(sessionId) }
}

// ---------- Phase 11: mode, summarizer, permission handling, Auto Mode ----------

interface AutoAction {
  type: string
  [k: string]: unknown
}

/** Append to the session's bounded JSON audit trail of automatic actions. */
function logAutoAction(sessionId: string, action: AutoAction): void {
  const session = getMacroSession(sessionId)
  if (!session) return
  let list: AutoAction[] = []
  try {
    list = session.autoActions ? (JSON.parse(session.autoActions) as AutoAction[]) : []
  } catch {
    list = []
  }
  list.push({ ...action, at: Date.now() })
  if (list.length > MAX_AUTO_ACTIONS) list = list.slice(-MAX_AUTO_ACTIONS)
  updateMacroSession(sessionId, { autoActions: JSON.stringify(list) })
}

function setMode(sessionId: string, mode: MacroMode): MacroResponse {
  updateMacroSession(sessionId, { mode })
  return { ok: true, state: requireState(sessionId) }
}

/**
 * Phase 22: steer the next step. Stores the user's chosen direction; the next
 * propose() folds it into the planner prompt and clears it. The loop keeps
 * running automatically — this only nudges where it goes next.
 */
function steer(sessionId: string, choice: string): MacroResponse {
  const text = cleanText(choice, 200)
  if (!text) return { ok: false, error: 'empty steering choice', state: requireState(sessionId) }
  updateMacroSession(sessionId, { pendingSteering: text })
  logAutoAction(sessionId, { type: 'user_steer', choice: text })
  return { ok: true, state: requireState(sessionId) }
}

/**
 * Summarize the executor result for a turn from a read-only terminal snapshot.
 * Uses the planner provider as a meta call (no usage_event); falls back to the
 * deterministic heuristic if the provider call fails or returns unusable JSON.
 */
async function summarizeTurn(
  sessionId: string,
  turnId: string,
  signal?: AbortSignal
): Promise<{ summary: ExecutorSummary; detection: PermissionDetection }> {
  const s = requireState(sessionId)
  const turn = s.turns.find((t) => t.id === turnId)
  if (!turn) throw new Error('macro turn not found')

  const prevStatus = s.session.status
  updateMacroSession(sessionId, { status: 'summarizing' })
  const snap = ptyManager.snapshot(s.session.targetTerminal, SNAPSHOT_CHARS + 4000)
  const bounded = boundSnapshot(snap.text, SNAPSHOT_CHARS, 200)
  const detection = detectPermissionPrompt(snap.text)

  let summary: ExecutorSummary
  try {
    const prompt = buildSummarizerPrompt({
      goal: s.session.goal,
      lastPrompt: turn.sentPrompt ?? turn.editedProposal ?? turn.proposal ?? '',
      snapshot: bounded.text,
      turnIndex: turn.turnIndex,
      repoDigest: s.session.repoDigestSnapshot
    })
    const signals = [AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS)]
    if (signal) signals.push(signal)
    const result = await sendMetaPrompt(
      s.session.plannerProvider,
      s.session.plannerModel ?? undefined,
      prompt,
      AbortSignal.any(signals)
    )
    recordMetaUsage(sessionId, result.usage)
    summary = parseSummaryJson(result.text) ?? heuristicSummary(snap.text)
  } catch {
    summary = heuristicSummary(snap.text)
  }

  updateMacroTurn(turnId, {
    executorResultSummary: renderSummaryText(summary),
    summarizerConfidence: summary.confidence,
    confidenceScore: summary.confidence,
    permissionDetection: detection.detected ? JSON.stringify(detection) : null,
    terminalSnapshotMeta: JSON.stringify({
      terminal: s.session.targetTerminal,
      chars: bounded.chars,
      lines: bounded.lines,
      truncated: bounded.truncated,
      alive: snap.alive
    }),
    resultStatus: summary.needsUserAttention ? 'needs_attention' : 'ok'
  })
  // Restore a non-transient status (the caller decides the next real status).
  if (getMacroSession(sessionId)?.status === 'summarizing') {
    updateMacroSession(sessionId, { status: prevStatus === 'summarizing' ? 'awaiting_executor_result' : prevStatus })
  }
  return { summary, detection }
}

/** Extract the persisted critic gaps for a turn (best-effort JSON parse). */
function turnCriticGaps(turn: MacroSessionWithTurns['turns'][number]): string[] {
  if (!turn.criticReview) return []
  try {
    const parsed = JSON.parse(turn.criticReview) as { gaps?: unknown }
    return Array.isArray(parsed.gaps) ? parsed.gaps.filter((g): g is string => typeof g === 'string') : []
  } catch {
    return []
  }
}

/** Prior turns' critic scores, oldest→newest, for regression/stall detection. */
function priorCriticScores(turns: MacroSessionWithTurns['turns'], exceptTurnId: string): number[] {
  return turns
    .filter((t) => t.id !== exceptTurnId && typeof t.criticScore === 'number')
    .map((t) => t.criticScore as number)
}

/**
 * Phase 19: grade the ACTUAL result of a turn against the goal. Runs after the
 * summarizer as a meta call (no usage_event) with a deterministic heuristic
 * fallback, and persists the measured grade so both the stop/continue gate and
 * the next planner turn can use it. Read-only over the terminal.
 */
async function criticTurn(
  sessionId: string,
  turnId: string,
  summary: ExecutorSummary,
  signal?: AbortSignal
): Promise<CriticReview> {
  const s = requireState(sessionId)
  const turn = s.turns.find((t) => t.id === turnId)
  if (!turn) throw new Error('macro turn not found')

  const snap = ptyManager.snapshot(s.session.targetTerminal, SNAPSHOT_CHARS + 4000)
  const bounded = boundSnapshot(snap.text, SNAPSHOT_CHARS, 200)
  const priorScores = priorCriticScores(s.turns, turnId)

  let review: CriticReview
  try {
    const prompt = buildCriticPrompt({
      goal: s.session.goal,
      lastPrompt: turn.sentPrompt ?? turn.editedProposal ?? turn.proposal ?? '',
      summary,
      snapshot: bounded.text,
      turnIndex: turn.turnIndex,
      threshold: s.session.goodEnoughThreshold,
      priorScores
    })
    const signals = [AbortSignal.timeout(CRITIC_TIMEOUT_MS)]
    if (signal) signals.push(signal)
    const result = await sendMetaPrompt(
      s.session.plannerProvider,
      s.session.plannerModel ?? undefined,
      prompt,
      AbortSignal.any(signals)
    )
    recordMetaUsage(sessionId, result.usage)
    review = parseCriticReview(result.text) ?? heuristicCritic(summary, priorScores)
  } catch {
    review = heuristicCritic(summary, priorScores)
  }

  // Fold the critic grade into the turn's visible summary so both modes show it.
  const baseSummary = turn.executorResultSummary ?? renderSummaryText(summary)
  updateMacroTurn(turnId, {
    criticScore: review.progressScore,
    criticVerdict: review.verdict,
    criticReview: JSON.stringify(review),
    executorResultSummary: `${baseSummary}\n\n${renderCriticText(review)}`,
    resultStatus:
      review.verdict === 'regressed' || review.recommendation === 'escalate' ? 'needs_attention' : turn.resultStatus
  })
  return review
}

/**
 * Phase 20: commit this turn's work to the session's workspace as the next
 * "Phase N: <change>". Loop-driven and deterministic — staging + the message
 * (via stdin) come from Akorith, never from the executor agent. No-ops cleanly
 * when auto-commit is off, there is no workspace, or nothing changed.
 */
async function maybeAutoCommit(
  sessionId: string,
  turnId: string,
  summaryStatus: string | null,
  criticRationale: string | null,
  criticVerdict: string | null
): Promise<void> {
  const s = getMacroSession(sessionId)
  if (!s || !s.autoCommit || !s.workspaceDir) return
  const headline = deriveHeadline({ criticRationale, criticVerdict, summaryStatus, goal: s.goal })
  try {
    const res = await commitPhase(s.workspaceDir, headline)
    if (res.committed) {
      logAutoAction(sessionId, { type: 'auto_commit', phase: res.phase, message: res.message })
      updateMacroTurn(turnId, {
        autoAction: JSON.stringify({ type: 'auto_commit', phase: res.phase, message: res.message, at: Date.now() })
      })
    } else {
      logAutoAction(sessionId, { type: 'auto_commit_skipped', reason: res.reason })
    }
  } catch (err) {
    logAutoAction(sessionId, { type: 'auto_commit_skipped', reason: err instanceof Error ? err.message : String(err) })
  }
}

/** Approval-Mode helper: fill the turn summary from the terminal for user review. */
async function summarize(sessionId: string, turnId: string): Promise<MacroResponse & { summaryText?: string }> {
  const { summary, detection } = await summarizeTurn(sessionId, turnId)
  // Phase 19: grade the result too, so approval-mode users see measured progress.
  const review = await criticTurn(sessionId, turnId, summary)
  return {
    ok: true,
    state: requireState(sessionId),
    summaryText:
      renderSummaryText(summary) +
      `\n\n${renderCriticText(review)}` +
      (detection.detected ? `\n\nPermission prompt detected: ${detection.rationale}` : '')
  }
}

/**
 * Phase 13.2: sessionless "summarize what an agent just did" for the chat workflow.
 * Reads a read-only terminal snapshot and summarizes it as a meta call (NO
 * usage_event) with a heuristic fallback. Returns a "no meaningful output" signal
 * when the terminal has essentially nothing new, so the chat can show a graceful
 * state instead of a spammy empty summary.
 */
type AgentSummaryResponse =
  | { ok: true; summary: ExecutorSummary; detection: PermissionDetection; signature: string; persisted: boolean }
  | { ok: false; error: string; signature?: string }

/** One-line, role-appropriate text for an agent summary persisted into a chat. */
function renderAgentSummaryMessage(terminalId: string, summary: ExecutorSummary): string {
  const label = TERMINAL_LABEL[terminalId] ?? terminalId
  const role = AGENT_ROLE[terminalId] ?? 'the agent'
  return `[Agent activity — ${label} / ${role}]\n${renderSummaryText(summary)}`
}

async function summarizeAgentOutput(args: {
  terminalId: string
  providerId: string
  model?: string
  goal?: string
  lastPrompt?: string
  /** Phase 14.2: when set, persist the summary into this chat session's memory. */
  sessionId?: string
}): Promise<AgentSummaryResponse> {
  const snap = ptyManager.snapshot(args.terminalId, SNAPSHOT_CHARS + 4000)
  const bounded = boundSnapshot(snap.text, SNAPSHOT_CHARS, 200)
  // A signature lets the renderer skip re-summarizing unchanged output (no spam).
  const signature = `${args.terminalId}:${bounded.chars}`
  if (bounded.text.trim().length < 12) {
    return { ok: false, error: 'No meaningful new output yet.', signature }
  }
  const detection = detectPermissionPrompt(snap.text)
  let summary: ExecutorSummary
  try {
    const prompt = buildSummarizerPrompt({
      goal: cleanText(args.goal ?? 'Summarize what the agent just did in the terminal.', MAX_GOAL_CHARS),
      lastPrompt: cleanText(args.lastPrompt ?? '', MAX_PROMPT_CHARS),
      snapshot: bounded.text,
      turnIndex: 1,
      repoDigest: null
    })
    const result = await sendMetaPrompt(args.providerId, args.model || undefined, prompt, AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS))
    summary = parseSummaryJson(result.text) ?? heuristicSummary(snap.text)
  } catch {
    summary = heuristicSummary(snap.text)
  }
  // Phase 14.2: fold the summary into the active session's memory so later
  // follow-up questions in that SAME chat can reference what the agent did.
  // Strictly scoped to the given session id — never another chat.
  let persisted = false
  if (args.sessionId && sessionExists(args.sessionId)) {
    try {
      addMessage(args.sessionId, 'assistant', renderAgentSummaryMessage(args.terminalId, summary), args.providerId, args.model)
      persisted = true
    } catch (err) {
      console.error('[macro] failed to persist agent summary into session:', err)
    }
  }
  return { ok: true, summary, detection, signature, persisted }
}

/**
 * Phase 14.1: sessionless permission detection for the chat workflow. Reads a
 * read-only snapshot of a terminal and reports any pending confirmation prompt
 * so the chat UI can surface answer buttons. Never writes anything.
 */
function detectAgentPermission(terminalId: string): { ok: true; detection: PermissionDetection; alive: boolean } | { ok: false; error: string } {
  const alive = ptyManager.isAlive(terminalId)
  const snap = ptyManager.snapshot(terminalId, SNAPSHOT_CHARS)
  return { ok: true, detection: detectPermissionPrompt(snap.text), alive }
}

/** Read-only permission detection over the target terminal's recent output. */
function detectPermission(sessionId: string): { ok: true; detection: PermissionDetection } | { ok: false; error: string } {
  const s = getMacroSession(sessionId)
  if (!s) return { ok: false, error: 'macro session not found' }
  const snap = ptyManager.snapshot(s.targetTerminal, SNAPSHOT_CHARS)
  return { ok: true, detection: detectPermissionPrompt(snap.text) }
}

/**
 * Send a permission response through the bridge. `auto` distinguishes a user-
 * approved send from an Auto-Mode auto-answer (both logged). The response text
 * is constrained to a short token (e.g. "1", "y") — never arbitrary commands.
 */
function respondPermission(sessionId: string, turnId: string, action: string, auto: boolean): MacroResponse {
  const s = requireState(sessionId)
  const text = cleanText(action, 40)
  if (!text && action !== '') return { ok: false, error: 'empty permission response', state: s }
  const send = bridgeSend({ text, targetTerminalId: s.session.targetTerminal, autoEnter: true })
  if (!send.ok) return { ok: false, error: send.error, state: s }
  updateMacroTurn(turnId, { autoAction: JSON.stringify({ type: auto ? 'auto_permission_response' : 'user_permission_response', action: text, at: Date.now() }) })
  logAutoAction(sessionId, { type: auto ? 'auto_permission_response' : 'user_permission_response', action: text, turn: s.turns.find((t) => t.id === turnId)?.turnIndex })
  updateMacroSession(sessionId, { status: 'awaiting_executor_result', pauseReason: null })
  return { ok: true, state: requireState(sessionId) }
}

function interruptibleDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Poll the terminal snapshot until output stabilizes (unchanged across two
 * polls), a permission prompt appears, or a bounded max wait elapses. Bounded
 * and abortable — never spins.
 */
async function waitForOutput(terminalId: string, signal: AbortSignal, short = false): Promise<void> {
  const maxWait = short ? SHORT_WAIT_MS : MAX_WAIT_PER_TURN_MS
  const deadline = Date.now() + maxWait
  let lastLen = -1
  let stableCount = 0
  while (!signal.aborted && Date.now() < deadline) {
    await interruptibleDelay(POLL_INTERVAL_MS, signal)
    if (signal.aborted) return
    const snap = ptyManager.snapshot(terminalId, SNAPSHOT_CHARS)
    if (detectPermissionPrompt(snap.text).detected) return
    if (snap.text.length === lastLen) {
      stableCount += 1
      if (stableCount >= 2) return
    } else {
      stableCount = 0
      lastLen = snap.text.length
    }
  }
}

/** Count consecutive most-recent turns flagged needing attention. */
function countTrailingFailures(state: MacroSessionWithTurns): number {
  let n = 0
  for (let i = state.turns.length - 1; i >= 0; i--) {
    if (state.turns[i].resultStatus === 'needs_attention' || state.turns[i].status === 'error') n += 1
    else break
  }
  return n
}

function pauseAuto(sessionId: string, reason: string, permission: boolean): void {
  updateMacroSession(sessionId, {
    status: permission ? 'awaiting_permission' : 'awaiting_executor_result',
    pauseReason: reason
  })
  logAutoAction(sessionId, { type: 'pause', reason, permission })
}

function finishAuto(sessionId: string, status: 'completed' | 'stopped', reason: string, score?: number | null): void {
  updateMacroSession(sessionId, {
    status,
    stopReason: reason,
    finalScore: score ?? undefined,
    pauseReason: null
  })
  logAutoAction(sessionId, { type: status, reason })
}

/**
 * Auto-Mode driver. Cautious by design: it proposes → auto-sends → waits →
 * summarizes → handles permission prompts under policy → decides continue/pause/
 * stop. Every send goes through bridgeSend(); every automatic action is logged;
 * Stop (which aborts the controller) wins at every await.
 */
async function runAutoLoop(sessionId: string): Promise<void> {
  const existing = activeLoops.get(sessionId)
  if (existing) existing.abort()
  const controller = new AbortController()
  activeLoops.set(sessionId, controller)
  const signal = controller.signal
  const stopped = (): boolean => signal.aborted || getMacroSession(sessionId)?.status === 'stopped'

  try {
    while (!stopped()) {
      const s = requireState(sessionId)
      if (s.session.status === 'completed' || s.session.status === 'stopped') break
      if (maxIterationsReached(s.turns.length, s.session.maxIterations)) {
        finishAuto(sessionId, 'stopped', 'max_iterations')
        break
      }
      // Phase 20: stop when the metered meta-call token budget is spent.
      if (tokenBudgetExceeded(s.session)) {
        finishAuto(sessionId, 'stopped', 'token_budget_reached')
        break
      }

      // 1. Propose the next executor step (meta call).
      updateMacroSession(sessionId, { status: 'auto_running', pauseReason: null })
      const proposed = await propose(sessionId, signal)
      if (stopped()) break
      if (!proposed.ok) {
        pauseAuto(sessionId, `planner_error:${proposed.error}`, false)
        break
      }
      const afterPropose = requireState(sessionId)
      const turn = afterPropose.turns[afterPropose.turns.length - 1]
      if (!turn || !turn.proposal) {
        pauseAuto(sessionId, 'no_proposal', false)
        break
      }
      // Phase 22: fully automatic — a high planner-risk label no longer pauses
      // (it is only a prompt to the agent; destructive shell ops are still gated
      // by the permission detector below). Logged for the audit trail.
      if (turn.riskLevel === 'high') {
        logAutoAction(sessionId, { type: 'high_risk_continue', turn: turn.turnIndex })
      }
      // 3. Auto-send the proposal through the single bridge path.
      const sent = sendApprovedPrompt(sessionId, turn.id, turn.proposal, true)
      if (!sent.ok) {
        pauseAuto(sessionId, `bridge_error:${sent.error}`, false)
        break
      }
      // 4. Wait (bounded) for output to settle.
      await waitForOutput(afterPropose.session.targetTerminal, signal)
      if (stopped()) break
      // 5. Summarize the result (meta call + heuristic fallback).
      const { summary, detection } = await summarizeTurn(sessionId, turn.id, signal)
      if (stopped()) break
      // 6. Permission handling. Phase 22: fully automatic. The executor runs in
      //    bypass mode (claude-auto / codex-auto), so prompts are rare; if one
      //    still slips through, auto-answer the safe default and keep going rather
      //    than stopping to ask. Blast radius is the loop's own throwaway project.
      if (detection.detected) {
        const answer = detection.suggestedAction || (detection.kind === 'yes_no' ? 'y' : '')
        respondPermission(sessionId, turn.id, answer, true)
        await waitForOutput(afterPropose.session.targetTerminal, signal, true)
        if (stopped()) break
      }
      updateMacroTurn(turn.id, { status: 'completed' })
      // 6.5 Critic: grade the ACTUAL result against the goal (meta call). This
      //     measured score — not the planner's prediction — drives the gate and
      //     feeds the next plan, closing the loop.
      const review = await criticTurn(sessionId, turn.id, summary, signal)
      if (stopped()) break
      // 6.7 Auto-commit this turn's work as "Phase N: <change>" (loop-driven git).
      await maybeAutoCommit(sessionId, turn.id, summary.currentStatus, review.rationale, review.verdict)
      if (stopped()) break
      // 7. Decide continue / complete / stop / pause.
      const now = requireState(sessionId)
      const outcome = evaluateAutoOutcome({
        iteration: now.turns.length,
        maxIterations: now.session.maxIterations,
        consecutiveFailures: countTrailingFailures(now),
        doneScore: turn.goodEnoughScore,
        threshold: now.session.goodEnoughThreshold,
        summary,
        critic: review
      })
      if (outcome.action === 'complete') {
        finishAuto(sessionId, 'completed', outcome.reason, review.progressScore)
        break
      }
      if (outcome.action === 'stop') {
        finishAuto(sessionId, 'stopped', outcome.reason)
        break
      }
      if (outcome.action === 'pause') {
        pauseAuto(sessionId, outcome.reason, false)
        break
      }
      await interruptibleDelay(800, signal)
    }
  } catch (err) {
    updateMacroSession(sessionId, { status: 'error', stopReason: err instanceof Error ? err.message : String(err) })
  } finally {
    activeLoops.delete(sessionId)
  }
}

function startAuto(sessionId: string): MacroResponse {
  const s = requireState(sessionId)
  if (s.session.status === 'completed' || s.session.status === 'stopped') {
    return { ok: false, error: 'session is finished; start a new loop', state: s }
  }
  updateMacroSession(sessionId, { mode: 'auto', status: 'auto_running', pauseReason: null })
  // Fire-and-forget; the renderer polls macro:get for progress.
  void runAutoLoop(sessionId)
  return { ok: true, state: requireState(sessionId) }
}

// ---------- Phase 20: autonomous workspace project creation ----------

interface WorkspaceCreateArgs {
  seed?: string
  basePath?: string
  plannerProvider: string
  plannerModel?: string
  targetTerminal: string
  maxIterations?: number
  goodEnoughThreshold?: number
  tokenBudget?: number
}

type WorkspaceCreateResponse =
  | { ok: true; idea: ProjectIdea; project: ProjectRow; state: MacroSessionWithTurns; workspaceDir: string }
  | { ok: false; error: string }

/** Deterministic idea when the model call fails or returns unusable JSON. */
function fallbackIdea(seed?: string): ProjectIdea {
  const name = seed?.trim() ? seed.trim().slice(0, 60) : 'Dev Notes CLI'
  return {
    name,
    slug: slugify(name),
    summary: 'A small everyday-developer tool (auto-scaffolded because idea generation did not return usable JSON).',
    firstGoal:
      'In this empty git repository, create a minimal runnable project skeleton (README, an entry file, and a smoke test) for a small useful CLI tool, then report exactly what you created.'
  }
}

/**
 * Generate an everyday-dev idea, scaffold it as its own git repo, and bind a
 * fresh auto-mode + auto-commit macro session to it. Does NOT start the loop —
 * the renderer first starts the executor terminal in `workspaceDir`, then calls
 * macro:startAuto. The build then commits each change as "Phase N: <change>".
 */
async function createWorkspaceProject(args: WorkspaceCreateArgs): Promise<WorkspaceCreateResponse> {
  // 1. Generate an everyday-dev idea (meta call) with a deterministic fallback.
  let idea: ProjectIdea
  try {
    const res = await sendMetaPrompt(
      args.plannerProvider,
      args.plannerModel || undefined,
      buildIdeaPrompt(args.seed),
      AbortSignal.timeout(PROPOSE_TIMEOUT_MS)
    )
    idea = parseProjectIdea(res.text) ?? fallbackIdea(args.seed)
  } catch {
    idea = fallbackIdea(args.seed)
  }

  // 2. Resolve a unique, safe workspace directory under the base path.
  const base = args.basePath && isAbsolute(args.basePath) ? args.basePath : join(app.getPath('documents'), 'Akorith Projects')
  let dir = join(base, idea.slug)
  for (let n = 2; existsSync(dir) && n <= 50; n++) dir = join(base, `${idea.slug}-${n}`)

  // 3. Scaffold: mkdir + git init + README + "Phase 0: scaffold project".
  const init = await initWorkspace(dir, idea)
  if (!init.ok) return { ok: false, error: init.error ?? 'failed to initialize workspace' }

  // 4. Persist a sidebar project row + an auto-mode macro session bound to it.
  const project = createProject({ name: idea.name, path: dir })
  const session = createMacroSession({
    goal: cleanText(idea.firstGoal, MAX_GOAL_CHARS),
    plannerProvider: args.plannerProvider,
    plannerModel: args.plannerModel || undefined,
    targetTerminal: args.targetTerminal,
    maxIterations: clampInt(args.maxIterations ?? 30, 30, 1, 200),
    goodEnoughThreshold: clampInt(args.goodEnoughThreshold ?? 90, 90, 1, 100),
    includeRepoDigest: true,
    mode: 'auto',
    workspaceDir: dir,
    autoCommit: true,
    tokenBudget: clampInt(args.tokenBudget ?? 0, 0, 0, 100_000_000),
    // Phase 21: show the user's own words on the loop card (fallback to the idea name).
    title: (args.seed?.trim() || idea.name).slice(0, 200)
  })
  return { ok: true, idea, project, state: requireState(session.id), workspaceDir: dir }
}

function validWorkspacePayload(args: unknown): args is WorkspaceCreateArgs {
  const a = args as Record<string, unknown>
  return (
    typeof a?.plannerProvider === 'string' &&
    VALID_PROVIDER.test(a.plannerProvider) &&
    (a.plannerModel === undefined || (typeof a.plannerModel === 'string' && VALID_MODEL.test(a.plannerModel))) &&
    typeof a.targetTerminal === 'string' &&
    VALID_TERMINAL.test(a.targetTerminal) &&
    (a.seed === undefined || (typeof a.seed === 'string' && a.seed.length <= 2_000)) &&
    (a.basePath === undefined || (typeof a.basePath === 'string' && a.basePath.length <= 2_000)) &&
    (a.maxIterations === undefined || typeof a.maxIterations === 'number') &&
    (a.goodEnoughThreshold === undefined || typeof a.goodEnoughThreshold === 'number') &&
    (a.tokenBudget === undefined || typeof a.tokenBudget === 'number')
  )
}

function validCreatePayload(args: unknown): args is Parameters<typeof createSession>[0] {
  const a = args as Record<string, unknown>
  return (
    typeof a?.goal === 'string' &&
    a.goal.trim().length > 0 &&
    a.goal.length <= MAX_GOAL_CHARS &&
    typeof a.plannerProvider === 'string' &&
    VALID_PROVIDER.test(a.plannerProvider) &&
    (a.plannerModel === undefined || (typeof a.plannerModel === 'string' && VALID_MODEL.test(a.plannerModel))) &&
    typeof a.targetTerminal === 'string' &&
    VALID_TERMINAL.test(a.targetTerminal) &&
    typeof a.maxIterations === 'number' &&
    typeof a.goodEnoughThreshold === 'number' &&
    typeof a.includeRepoDigest === 'boolean' &&
    (a.mode === undefined || a.mode === 'approval' || a.mode === 'auto') &&
    (a.workspaceDir === undefined || a.workspaceDir === null || (typeof a.workspaceDir === 'string' && a.workspaceDir.length <= 2_000)) &&
    (a.autoCommit === undefined || typeof a.autoCommit === 'boolean') &&
    (a.tokenBudget === undefined || typeof a.tokenBudget === 'number')
  )
}

export function registerMacroIpc(): void {
  ipcMain.handle('macro:createSession', async (_event, args): Promise<MacroResponse> => {
    if (!validCreatePayload(args)) return { ok: false, error: 'invalid macro:createSession payload' }
    try {
      return await createSession(args)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Phase 20: generate an everyday-dev idea, scaffold it as its own git repo,
  // and bind an auto-mode + auto-commit macro session to it (does not start it).
  ipcMain.handle('workspace:createProject', async (_event, args): Promise<WorkspaceCreateResponse> => {
    if (!validWorkspacePayload(args)) return { ok: false, error: 'invalid workspace:createProject payload' }
    try {
      return await createWorkspaceProject(args)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('macro:propose', async (_event, args: { sessionId: string }): Promise<MacroResponse> => {
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) {
      return { ok: false, error: 'invalid macro:propose payload' }
    }
    try {
      return await propose(args.sessionId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), state: state(args.sessionId) }
    }
  })

  ipcMain.handle('macro:approve', (_event, args: { sessionId: string; turnId: string; editedProposal?: string }): MacroResponse => {
    if (
      typeof args?.sessionId !== 'string' ||
      !VALID_ID.test(args.sessionId) ||
      typeof args.turnId !== 'string' ||
      !VALID_ID.test(args.turnId) ||
      (args.editedProposal !== undefined && (typeof args.editedProposal !== 'string' || args.editedProposal.length > MAX_PROMPT_CHARS))
    ) {
      return { ok: false, error: 'invalid macro:approve payload' }
    }
    try {
      return approve(args)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), state: state(args.sessionId) }
    }
  })

  ipcMain.handle('macro:recordResult', (_event, args: { sessionId: string; turnId: string; summary: string }): MacroResponse => {
    if (
      typeof args?.sessionId !== 'string' ||
      !VALID_ID.test(args.sessionId) ||
      typeof args.turnId !== 'string' ||
      !VALID_ID.test(args.turnId) ||
      typeof args.summary !== 'string' ||
      args.summary.length > MAX_SUMMARY_CHARS
    ) {
      return { ok: false, error: 'invalid macro:recordResult payload' }
    }
    try {
      return recordResult(args)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), state: state(args.sessionId) }
    }
  })

  ipcMain.handle('macro:skip', (_event, args: { sessionId: string; turnId: string }): MacroResponse => {
    if (
      typeof args?.sessionId !== 'string' ||
      !VALID_ID.test(args.sessionId) ||
      typeof args.turnId !== 'string' ||
      !VALID_ID.test(args.turnId)
    ) {
      return { ok: false, error: 'invalid macro:skip payload' }
    }
    try {
      return skip(args)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), state: state(args.sessionId) }
    }
  })

  ipcMain.handle('macro:stop', (_event, args: { sessionId: string }): MacroResponse => {
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) {
      return { ok: false, error: 'invalid macro:stop payload' }
    }
    try {
      return stop(args.sessionId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), state: state(args.sessionId) }
    }
  })

  ipcMain.handle('macro:complete', (_event, args: { sessionId: string }): MacroResponse => {
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) {
      return { ok: false, error: 'invalid macro:complete payload' }
    }
    try {
      return complete(args.sessionId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), state: state(args.sessionId) }
    }
  })

  ipcMain.handle('macro:setMode', (_event, args: { sessionId: string; mode: MacroMode }): MacroResponse => {
    if (
      typeof args?.sessionId !== 'string' ||
      !VALID_ID.test(args.sessionId) ||
      (args.mode !== 'approval' && args.mode !== 'auto')
    ) {
      return { ok: false, error: 'invalid macro:setMode payload' }
    }
    try {
      return setMode(args.sessionId, args.mode)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), state: state(args.sessionId) }
    }
  })

  // Phase 22: steer the next step toward a chosen direction (loop keeps running).
  ipcMain.handle('macro:steer', (_event, args: { sessionId: string; choice: string }): MacroResponse => {
    if (
      typeof args?.sessionId !== 'string' ||
      !VALID_ID.test(args.sessionId) ||
      typeof args.choice !== 'string' ||
      args.choice.length > 200
    ) {
      return { ok: false, error: 'invalid macro:steer payload' }
    }
    try {
      return steer(args.sessionId, args.choice)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), state: state(args.sessionId) }
    }
  })

  ipcMain.handle('macro:startAuto', (_event, args: { sessionId: string }): MacroResponse => {
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) {
      return { ok: false, error: 'invalid macro:startAuto payload' }
    }
    try {
      return startAuto(args.sessionId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), state: state(args.sessionId) }
    }
  })

  ipcMain.handle('macro:summarize', async (_event, args: { sessionId: string; turnId: string }) => {
    if (
      typeof args?.sessionId !== 'string' ||
      !VALID_ID.test(args.sessionId) ||
      typeof args.turnId !== 'string' ||
      !VALID_ID.test(args.turnId)
    ) {
      return { ok: false, error: 'invalid macro:summarize payload' }
    }
    try {
      return await summarize(args.sessionId, args.turnId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), state: state(args.sessionId) }
    }
  })

  // Sessionless summarize for the chat workflow (Phase 13.2). Meta call only.
  ipcMain.handle(
    'agent:summarize',
    async (_event, args: { terminalId: string; providerId: string; model?: string; goal?: string; lastPrompt?: string; sessionId?: string }) => {
      if (
        typeof args?.terminalId !== 'string' ||
        !VALID_TERMINAL.test(args.terminalId) ||
        typeof args.providerId !== 'string' ||
        !VALID_PROVIDER.test(args.providerId) ||
        (args.model !== undefined && (typeof args.model !== 'string' || !VALID_MODEL.test(args.model))) ||
        (args.goal !== undefined && typeof args.goal !== 'string') ||
        (args.lastPrompt !== undefined && typeof args.lastPrompt !== 'string') ||
        (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !VALID_ID.test(args.sessionId)))
      ) {
        return { ok: false, error: 'invalid agent:summarize payload' }
      }
      try {
        return await summarizeAgentOutput(args)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Sessionless permission detection for the chat workflow (Phase 14.1). Read-only.
  ipcMain.handle('agent:detectPermission', (_event, args: { terminalId: string }) => {
    if (typeof args?.terminalId !== 'string' || !VALID_TERMINAL.test(args.terminalId)) {
      return { ok: false, error: 'invalid agent:detectPermission payload' }
    }
    try {
      return detectAgentPermission(args.terminalId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('macro:detectPermission', (_event, args: { sessionId: string }) => {
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) {
      return { ok: false, error: 'invalid macro:detectPermission payload' }
    }
    try {
      return detectPermission(args.sessionId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'macro:respondPermission',
    (_event, args: { sessionId: string; turnId: string; action: string }): MacroResponse => {
      if (
        typeof args?.sessionId !== 'string' ||
        !VALID_ID.test(args.sessionId) ||
        typeof args.turnId !== 'string' ||
        !VALID_ID.test(args.turnId) ||
        typeof args.action !== 'string' ||
        args.action.length > 40
      ) {
        return { ok: false, error: 'invalid macro:respondPermission payload' }
      }
      try {
        // User-initiated permission response (auto=false).
        return respondPermission(args.sessionId, args.turnId, args.action, false)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), state: state(args.sessionId) }
      }
    }
  )

  ipcMain.handle('macro:get', (_event, args: { sessionId: string }) => {
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) return null
    return getMacroState(args.sessionId)
  })

  ipcMain.handle('macro:list', (_event, args: { limit?: number }) =>
    listMacroSessions(typeof args?.limit === 'number' ? args.limit : 20)
  )
}
