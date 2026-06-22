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
import { basename, isAbsolute, join } from 'path'
import { bridgeSend } from './bridge'
import { getBridgeSettings, getDigestSettings } from './config'
import { buildDigest } from './digest'
import { ptyManager, type PtyCommandKind } from './pty'
import {
  addMessage,
  archiveMacroSession,
  createMacroSession,
  createMacroTurn,
  deleteMacroSession,
  ensureProjectForPath,
  getMacroSession,
  getMacroState,
  listMacroSessions,
  recordLoopEvent,
  recordLoopRun,
  sessionExists,
  updateMacroSession,
  updateMacroTurn,
  type MacroMode,
  type MacroSessionRow,
  type MacroSessionWithTurns,
  type ProjectRow
} from './db'
import { describeProviders, sendMetaPrompt } from './providers/registry'
import type { SendResult } from './providers/types'
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
const VALID_TERMINAL = /^[a-z0-9-]{1,32}(::[a-z0-9-]{1,40})?$/
const MAX_GOAL_CHARS = 40_000
const MAX_SUMMARY_CHARS = 80_000
const MAX_PROMPT_CHARS = 200_000
const PROPOSE_TIMEOUT_MS = 600_000
const SUMMARIZE_TIMEOUT_MS = 120_000
const CRITIC_TIMEOUT_MS = 120_000
const SNAPSHOT_CHARS = 8000
const DIGEST_TIMEOUT_MS = 12_000
const PLANNER_ATTEMPT_TIMEOUT_MS = 90_000
// Auto-Mode polling: bounded, never spins the CPU.
const POLL_INTERVAL_MS = 1200
const MAX_WAIT_PER_TURN_MS = 30_000
const SHORT_WAIT_MS = 6000
const MAX_AUTO_ACTIONS = 80
const AUTO_RETRY_DELAY_MS = 90_000
const MAX_PARALLEL_PLANNERS = 2
// Olympus = Codex (t2), Atlantis = Claude (t1) — for labeling persisted summaries.
const TERMINAL_LABEL: Record<string, string> = { t1: 'Atlantis', t2: 'Olympus' }
const AGENT_ROLE: Record<string, string> = { t1: 'Claude', t2: 'Codex' }
const LOOP_INTENTS = new Set(['continuous', 'monitor', 'daily-build', 'custom'])

type MacroResponse = { ok: true; state: MacroSessionWithTurns } | { ok: false; error: string; state?: MacroSessionWithTurns }

const activeProposals = new Map<string, AbortController>()
// Active Auto-Mode loops, keyed by session id, so Stop can abort them.
const activeLoops = new Map<string, AbortController>()
let activePlannerCalls = 0
const plannerQueue: (() => void)[] = []

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

function releasePlannerSlot(): void {
  activePlannerCalls = Math.max(0, activePlannerCalls - 1)
  plannerQueue.shift()?.()
}

function acquirePlannerSlot(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(new Error('cancelled'))
  if (activePlannerCalls < MAX_PARALLEL_PLANNERS) {
    activePlannerCalls += 1
    return Promise.resolve(releasePlannerSlot)
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const grant = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      activePlannerCalls += 1
      resolve(releasePlannerSlot)
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      const index = plannerQueue.indexOf(grant)
      if (index >= 0) plannerQueue.splice(index, 1)
      reject(new Error('cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    plannerQueue.push(grant)
  })
}

async function withPlannerSlot<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const release = await acquirePlannerSlot(signal)
  try {
    return await fn()
  } finally {
    release()
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function isRetriablePlannerError(message: string): boolean {
  return /usage limit|rate limit|quota|credit|credits|try again|timed out|timeout|no output|temporar|network|not reachable|ECONN|failed/i.test(message)
}

function modelForProvider(id: string, models: string[], preferred?: string | null): string | undefined {
  if (id === 'claude') {
    if (preferred && models.includes(preferred)) return preferred
    return models.includes('sonnet') ? 'sonnet' : models[0]
  }
  if (preferred && models.includes(preferred)) return preferred
  return models[0]
}

async function fallbackPlannerCandidates(primary: string): Promise<{ id: string; model?: string }[]> {
  const providers = await describeProviders().catch(() => [])
  const available = new Map(providers.filter((p) => p.available.ok).map((p) => [p.id, p]))
  const order =
    primary === 'chatgpt'
      ? ['claude', 'local']
      : primary === 'claude'
        ? ['local', 'chatgpt']
        : ['claude', 'chatgpt']
  const seen = new Set([primary])
  const out: { id: string; model?: string }[] = []
  for (const id of order) {
    if (seen.has(id)) continue
    seen.add(id)
    const provider = available.get(id)
    if (!provider) continue
    out.push({ id, model: modelForProvider(id, provider.models) })
  }
  return out
}

async function sendPlannerAttempt(providerId: string, model: string | undefined, prompt: string, signal: AbortSignal): Promise<SendResult> {
  const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(PLANNER_ATTEMPT_TIMEOUT_MS)])
  return withPlannerSlot(attemptSignal, () => sendMetaPrompt(providerId, model, prompt, attemptSignal))
}

async function sendPlannerPromptForLoop(
  session: MacroSessionRow,
  prompt: string,
  signal: AbortSignal,
  sessionId: string
): Promise<{ result: SendResult; providerId: string }> {
  try {
    return {
      result: await sendPlannerAttempt(session.plannerProvider, session.plannerModel ?? undefined, prompt, signal),
      providerId: session.plannerProvider
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (session.mode !== 'auto' || signal.aborted || !isRetriablePlannerError(message)) {
      throw err
    }

    const failures = [`${session.plannerProvider}: ${message}`]
    for (const candidate of await fallbackPlannerCandidates(session.plannerProvider)) {
      if (signal.aborted) break
      recordLoopEvent({
        loopId: sessionId,
        type: 'planner_provider_fallback',
        message: `Primary planner ${session.plannerProvider} failed; retrying with ${candidate.id}.`,
        severity: 'warning',
        metadata: { primaryProvider: session.plannerProvider, primaryModel: session.plannerModel, fallbackProvider: candidate.id, fallbackModel: candidate.model, error: message }
      })
      try {
        return {
          result: await sendPlannerAttempt(candidate.id, candidate.model, prompt, signal),
          providerId: candidate.id
        }
      } catch (fallbackErr) {
        const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        failures.push(`${candidate.id}: ${fallbackMessage}`)
        if (!isRetriablePlannerError(fallbackMessage)) break
      }
    }
    throw new Error(`Planner providers unavailable right now: ${failures.join(' | ')}`)
  }
}

function baseTerminalId(id: string): 't1' | 't2' {
  return id.split('::')[0] === 't2' ? 't2' : 't1'
}

function terminalLabel(id: string): string {
  const base = baseTerminalId(id)
  return TERMINAL_LABEL[base] ?? id
}

function agentRole(id: string): string {
  const base = baseTerminalId(id)
  return AGENT_ROLE[base] ?? 'the agent'
}

function loopProjectKey(sessionId: string): string {
  return `loop-${sessionId.replace(/[^a-z0-9-]/gi, '').slice(0, 34)}`
}

function loopTerminalId(session: MacroSessionRow): string {
  return `${baseTerminalId(session.targetTerminal)}::${loopProjectKey(session.id)}`
}

function loopExecutorKind(session: MacroSessionRow): PtyCommandKind {
  return baseTerminalId(session.targetTerminal) === 't2' ? 'codex-auto' : 'claude-auto'
}

function executorBlockText(summary: ExecutorSummary): string {
  return [summary.currentStatus, summary.likelyNextStep, summary.testsRun ?? '', ...summary.failures].join('\n')
}

function looksLikeProviderBlock(text: string): boolean {
  return /usage limit|rate limit|quota|credit|credits|try again|timed out|timeout/i.test(text)
}

function switchExecutorAfterProviderBlock(sessionId: string, summary: ExecutorSummary): boolean {
  if (!looksLikeProviderBlock(executorBlockText(summary))) return false
  const current = getMacroSession(sessionId)
  if (!current) return false
  const currentBase = baseTerminalId(current.targetTerminal)
  const nextBase: 't1' | 't2' = currentBase === 't2' ? 't1' : 't2'
  const nextTerminal = `${nextBase}::${loopProjectKey(sessionId)}`
  updateMacroSession(sessionId, { targetTerminal: nextTerminal })
  logAutoAction(sessionId, {
    type: 'executor_provider_fallback',
    from: currentBase === 't2' ? 'Codex' : 'Claude',
    to: nextBase === 't2' ? 'Codex' : 'Claude',
    message: `Executor provider looked limited; switching to ${nextBase === 't2' ? 'Codex' : 'Claude'} for the next cycle.`
  })
  return true
}

function ensureAutoExecutor(sessionId: string): { ok: true; terminalId: string } | { ok: false; error: string } {
  const current = getMacroSession(sessionId)
  if (!current) return { ok: false, error: 'macro session not found' }
  if (!current.workspaceDir || !existsSync(current.workspaceDir)) {
    return { ok: false, error: 'loop workspace is missing' }
  }

  const terminalId = loopTerminalId(current)
  const started = ptyManager.createHeadless(terminalId, {
    cols: 120,
    rows: 32,
    cwd: current.workspaceDir,
    commandKind: loopExecutorKind(current)
  })
  if (!started.ok) return { ok: false, error: started.error }
  if (started.fallback || started.started === 'shell') {
    ptyManager.kill(terminalId)
    const base = baseTerminalId(current.targetTerminal)
    const agent = base === 't2' ? 'Codex' : 'Claude'
    const error = `${agent} CLI is not available for the live loop executor`
    recordLoopEvent({
      loopId: sessionId,
      type: 'loop_executor_unavailable',
      message: error,
      severity: 'error',
      metadata: { terminalId, requested: loopExecutorKind(current), started }
    })
    return { ok: false, error }
  }

  if (current.targetTerminal !== terminalId) {
    updateMacroSession(sessionId, { targetTerminal: terminalId })
  }
  if (!started.reused) {
    logAutoAction(sessionId, {
      type: 'loop_executor_started',
      message: `Started live ${started.started} executor for this loop.`,
      terminalId,
      cwd: current.workspaceDir
    })
  }
  return { ok: true, terminalId }
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
    if (s.session.mode === 'auto') {
      digest = 'Repo digest skipped for Full Auto mode; the live executor inspects the workspace directly.'
      recordLoopEvent({
        loopId: sessionId,
        type: 'repo_digest_skipped',
        message: digest,
        severity: 'info'
      })
    } else {
      try {
        const digestSettings = s.session.workspaceDir
          ? { ...getDigestSettings(), workingDir: s.session.workspaceDir }
          : undefined
        digest = await withTimeout(
          buildDigest(digestSettings),
          DIGEST_TIMEOUT_MS,
          `Repo digest skipped: timed out after ${DIGEST_TIMEOUT_MS}ms.`
        )
      } catch (err) {
        digest = `Repo digest unavailable: ${err instanceof Error ? err.message : String(err)}`
      }
      if (digest?.startsWith('Repo digest skipped:')) {
        recordLoopEvent({
          loopId: sessionId,
          type: 'repo_digest_timeout',
          message: digest,
          severity: 'warning'
        })
      }
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
    const planner = await sendPlannerPromptForLoop(s.session, prompt, signal, sessionId)
    const result = planner.result
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
      providerUsed: planner.providerId,
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
  if (auto) {
    const executor = ensureAutoExecutor(sessionId)
    if (!executor.ok) return { ok: false, error: executor.error, state: requireState(sessionId) }
  }
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
    autoEnter: auto ? true : getBridgeSettings().autoEnter
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
  recordLoopEvent({ loopId: sessionId, type: 'loop_stopped', message: 'Loop stopped.', severity: 'warning', metadata: { reason } })
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
  recordLoopEvent({ loopId: sessionId, type: 'loop_completed', message: 'Loop marked complete.', severity: 'success' })
  return { ok: true, state: requireState(sessionId) }
}

function archiveLoop(sessionId: string): MacroResponse {
  activeProposals.get(sessionId)?.abort()
  activeLoops.get(sessionId)?.abort()
  const archived = archiveMacroSession(sessionId)
  if (!archived) return { ok: false, error: 'macro session not found' }
  recordLoopEvent({ loopId: sessionId, type: 'loop_archived', message: 'Loop archived.', severity: 'info' })
  return { ok: true, state: requireState(sessionId) }
}

function removeLoop(sessionId: string): { ok: true } | { ok: false; error: string } {
  activeProposals.get(sessionId)?.abort()
  activeLoops.get(sessionId)?.abort()
  return deleteMacroSession(sessionId) ? { ok: true } : { ok: false, error: 'macro session not found' }
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
  recordLoopEvent({
    loopId: sessionId,
    type: action.type,
    message: loopEventMessage(action),
    severity: action.type.includes('error') || action.type.includes('skipped') ? 'warning' : 'info',
    metadata: action
  })
}

function loopEventMessage(action: AutoAction): string {
  if (typeof action.message === 'string' && action.message.trim()) return action.message.trim()
  if (typeof action.reason === 'string' && action.reason.trim()) return action.reason.trim()
  if (action.type === 'auto_send_prompt') return 'Sent the next executor step.'
  if (action.type === 'auto_commit') return 'Saved a committed change.'
  if (action.type === 'fully_loop_active') return 'Loop switched to Active.'
  if (action.type === 'fully_loop_passive') return 'Loop switched to Passive.'
  if (action.type === 'planner_switch') return 'Changed the planning model or executor.'
  if (action.type === 'cadence_wait') return 'Waiting for the next scheduled cycle.'
  if (action.type === 'auto_retry_scheduled') return 'Retrying automatically with the next available route.'
  if (action.type === 'planner_provider_fallback') return 'Trying another planning provider.'
  if (action.type === 'executor_provider_fallback') return 'Switching executor provider for the next cycle.'
  return action.type.replace(/_/g, ' ')
}

function setMode(sessionId: string, mode: MacroMode): MacroResponse {
  if (mode === 'approval') {
    activeProposals.get(sessionId)?.abort()
    activeLoops.get(sessionId)?.abort()
    const current = requireState(sessionId).session
    updateMacroSession(sessionId, {
      mode,
      status: current.status === 'completed' || current.status === 'stopped' ? current.status : 'idle',
      pauseReason: null
    })
    logAutoAction(sessionId, { type: 'fully_loop_passive' })
    return { ok: true, state: requireState(sessionId) }
  }
  updateMacroSession(sessionId, { mode })
  logAutoAction(sessionId, { type: 'fully_loop_active' })
  return { ok: true, state: requireState(sessionId) }
}

function setPlanner(args: {
  sessionId: string
  plannerProvider: string
  plannerModel?: string | null
  targetTerminal?: string
}): MacroResponse {
  const current = requireState(args.sessionId).session
  updateMacroSession(args.sessionId, {
    plannerProvider: args.plannerProvider,
    plannerModel: args.plannerModel || null,
    targetTerminal: args.targetTerminal || current.targetTerminal
  })
  logAutoAction(args.sessionId, {
    type: 'planner_switch',
    provider: args.plannerProvider,
    model: args.plannerModel || null,
    targetTerminal: args.targetTerminal || current.targetTerminal
  })
  return { ok: true, state: requireState(args.sessionId) }
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
interface AutoCommitOutcome {
  committed: boolean
  message?: string
  phase?: number
  reason?: string
}

async function maybeAutoCommit(
  sessionId: string,
  turnId: string,
  summaryStatus: string | null,
  criticRationale: string | null,
  criticVerdict: string | null
): Promise<AutoCommitOutcome> {
  const s = getMacroSession(sessionId)
  if (!s || !s.autoCommit || !s.workspaceDir) return { committed: false, reason: 'auto-commit disabled' }
  const headline = deriveHeadline({ criticRationale, criticVerdict, summaryStatus, goal: s.goal })
  try {
    const res = await commitPhase(s.workspaceDir, headline)
    if (res.committed) {
      logAutoAction(sessionId, { type: 'auto_commit', phase: res.phase, message: res.message })
      updateMacroTurn(turnId, {
        autoAction: JSON.stringify({ type: 'auto_commit', phase: res.phase, message: res.message, at: Date.now() })
      })
      return { committed: true, phase: res.phase, message: res.message }
    } else {
      logAutoAction(sessionId, { type: 'auto_commit_skipped', reason: res.reason })
      return { committed: false, reason: res.reason }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logAutoAction(sessionId, { type: 'auto_commit_skipped', reason })
    return { committed: false, reason }
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
  const label = terminalLabel(terminalId)
  const role = agentRole(terminalId)
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

function scheduleAutoRetry(sessionId: string, reason: string, delayMs = AUTO_RETRY_DELAY_MS): void {
  const retryAt = Date.now() + delayMs
  updateMacroSession(sessionId, {
    status: 'auto_running',
    pauseReason: null,
    stopReason: null,
    latestResult: `Recovering automatically: ${reason}. Retrying ${fmtRetryDelay(delayMs)}.`,
    nextRunAt: retryAt
  })
  logAutoAction(sessionId, { type: 'auto_retry_scheduled', reason, delayMs })
  const timer = setTimeout(() => {
    const current = getMacroSession(sessionId)
    if (!current || current.mode !== 'auto' || current.status === 'completed' || current.status === 'stopped' || current.status === 'error') return
    void runAutoLoop(sessionId)
  }, delayMs)
  if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') timer.unref()
}

function fmtRetryDelay(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds >= 60) return `in ${Math.round(seconds / 60)} min`
  return `in ${seconds}s`
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
      if (s.session.mode !== 'auto') {
        updateMacroSession(sessionId, { status: 'idle', pauseReason: null })
        logAutoAction(sessionId, { type: 'passive_wait' })
        break
      }
      if (maxIterationsReached(s.turns.length, s.session.maxIterations)) {
        finishAuto(sessionId, 'stopped', 'max_iterations')
        break
      }
      // Phase 20: stop when the metered meta-call token budget is spent.
      if (tokenBudgetExceeded(s.session)) {
        finishAuto(sessionId, 'stopped', 'token_budget_reached')
        break
      }
      const executor = ensureAutoExecutor(sessionId)
      if (!executor.ok) {
        recordLoopRun({
          loopId: sessionId,
          runIndex: s.turns.length + 1,
          startedAt: Date.now(),
          status: 'failed',
          providerId: s.session.plannerProvider,
          model: s.session.plannerModel,
          error: executor.error
        })
        scheduleAutoRetry(sessionId, `executor_error:${executor.error}`)
        break
      }
      const runStartedAt = Date.now()
      const runIndex = s.turns.length + 1

      // 1. Propose the next executor step (meta call).
      updateMacroSession(sessionId, { status: 'auto_running', pauseReason: null })
      const proposed = await propose(sessionId, signal)
      if (stopped()) break
      if (!proposed.ok) {
        recordLoopRun({
          loopId: sessionId,
          runIndex,
          startedAt: runStartedAt,
          status: 'failed',
          providerId: s.session.plannerProvider,
          model: s.session.plannerModel,
          error: proposed.error
        })
        scheduleAutoRetry(sessionId, `planner_error:${proposed.error}`)
        break
      }
      const afterPropose = requireState(sessionId)
      const turn = afterPropose.turns[afterPropose.turns.length - 1]
      if (!turn || !turn.proposal) {
        scheduleAutoRetry(sessionId, 'no_proposal')
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
        recordLoopRun({
          loopId: sessionId,
          runIndex,
          startedAt: runStartedAt,
          status: 'failed',
          providerId: afterPropose.session.plannerProvider,
          model: afterPropose.session.plannerModel,
          error: sent.error
        })
        scheduleAutoRetry(sessionId, `bridge_error:${sent.error}`)
        break
      }
      // 4. Wait (bounded) for output to settle.
      await waitForOutput(afterPropose.session.targetTerminal, signal)
      if (stopped()) break
      // 5. Summarize the result (meta call + heuristic fallback).
      const { summary, detection } = await summarizeTurn(sessionId, turn.id, signal)
      if (stopped()) break
      if (switchExecutorAfterProviderBlock(sessionId, summary)) {
        updateMacroTurn(turn.id, { status: 'completed' })
        recordLoopRun({
          loopId: sessionId,
          runIndex,
          startedAt: runStartedAt,
          status: 'needs_attention',
          providerId: afterPropose.session.plannerProvider,
          model: afterPropose.session.plannerModel,
          summary: summary.currentStatus,
          actionsTaken: { executorProviderFallback: true },
          filesChanged: summary.changedFiles,
          commandsExecuted: summary.commandsRun,
          testBuildResults: summary.testsRun,
          nextSuggestedStep: summary.likelyNextStep,
          error: 'executor_provider_blocked'
        })
        scheduleAutoRetry(sessionId, 'executor_provider_blocked', 15_000)
        break
      }
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
      const commitOutcome = await maybeAutoCommit(sessionId, turn.id, summary.currentStatus, review.rationale, review.verdict)
      if (stopped()) break
      // 7. Decide continue / complete / stop / pause.
      const now = requireState(sessionId)
      recordLoopRun({
        loopId: sessionId,
        runIndex,
        startedAt: runStartedAt,
        status: review.verdict === 'regressed' || summary.needsUserAttention ? 'needs_attention' : 'completed',
        providerId: now.session.plannerProvider,
        model: now.session.plannerModel,
        summary: summary.currentStatus,
        actionsTaken: { criticVerdict: review.verdict, criticScore: review.progressScore },
        filesChanged: summary.changedFiles,
        commandsExecuted: summary.commandsRun,
        testBuildResults: summary.testsRun,
        commitsCreated: commitOutcome.committed && commitOutcome.message ? [commitOutcome.message] : [],
        nextSuggestedStep: summary.likelyNextStep,
        error: commitOutcome.committed ? null : commitOutcome.reason ?? null
      })
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
        const projectLike = (now.session.loopType ?? now.session.loopIntent ?? '').match(/project|feature|build|code|docs|test|release|dependency/i)
        if (projectLike && now.session.autoCommit && !commitOutcome.committed && summary.changedFiles.length === 0) {
          scheduleAutoRetry(sessionId, 'verification_no_project_change')
          break
        }
        finishAuto(sessionId, 'completed', outcome.reason, review.progressScore)
        break
      }
      if (outcome.action === 'stop') {
        scheduleAutoRetry(sessionId, outcome.reason, 120_000)
        break
      }
      if (outcome.action === 'pause') {
        scheduleAutoRetry(sessionId, outcome.reason)
        break
      }
      const cadenceMinutes = Math.max(0, getMacroSession(sessionId)?.cadenceMinutes ?? 0)
      if (cadenceMinutes > 0) {
        logAutoAction(sessionId, { type: 'cadence_wait', minutes: cadenceMinutes })
        updateMacroSession(sessionId, {
          status: 'auto_running',
          pauseReason: null,
          latestResult: 'Waiting for the next scheduled cycle.',
          nextRunAt: Date.now() + cadenceMinutes * 60_000
        })
      }
      await interruptibleDelay(cadenceMinutes > 0 ? cadenceMinutes * 60_000 : 800, signal)
    }
  } catch (err) {
    if (signal.aborted || getMacroSession(sessionId)?.mode !== 'auto') {
      const current = getMacroSession(sessionId)
      if (current && current.status !== 'stopped' && current.status !== 'completed') {
        updateMacroSession(sessionId, { status: 'idle', pauseReason: null })
      }
      return
    }
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
  const executor = ensureAutoExecutor(sessionId)
  if (!executor.ok) {
    updateMacroSession(sessionId, { status: 'error', stopReason: executor.error, pauseReason: executor.error })
    return { ok: false, error: executor.error, state: requireState(sessionId) }
  }
  updateMacroSession(sessionId, { mode: 'auto', status: 'auto_running', pauseReason: null })
  // Fire-and-forget; the renderer polls macro:get for progress.
  void runAutoLoop(sessionId)
  return { ok: true, state: requireState(sessionId) }
}

export function resumeActiveAutoLoopsAtStartup(limit = 100): void {
  const sessions = listMacroSessions(limit).filter(
    (session) =>
      session.mode === 'auto' &&
      Boolean(session.workspaceDir) &&
      !session.archivedAt &&
      session.status !== 'completed' &&
      session.status !== 'stopped' &&
      session.status !== 'error'
  )
  for (const session of sessions) {
    const executor = ensureAutoExecutor(session.id)
    if (!executor.ok) {
      updateMacroSession(session.id, { status: 'error', stopReason: executor.error, pauseReason: executor.error })
      continue
    }
    updateMacroSession(session.id, { mode: 'auto', status: 'auto_running', pauseReason: null })
    void runAutoLoop(session.id)
  }
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
  loopIntent?: string
  cadenceMinutes?: number
  mode?: MacroMode
  loopType?: string
  targetType?: string
  targetRef?: string
  scheduleKind?: string
  scheduleDetail?: string
  autonomyLevel?: string
  stopCondition?: string
  maxRuns?: number
  maxCommits?: number
  commitBehavior?: string
  pushEnabled?: boolean
  testCommands?: string
  reportFormat?: string
  safetyLevel?: string
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

function normalizeLoopIntent(value: unknown): string {
  return typeof value === 'string' && LOOP_INTENTS.has(value) ? value : 'continuous'
}

function defaultCadenceMinutes(intent: string): number {
  if (intent === 'monitor') return 5
  if (intent === 'daily-build') return 1440
  return 0
}

function cadenceLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

function safeText(value: unknown, fallback: string, max = 300): string {
  if (typeof value !== 'string') return fallback
  const text = value.replace(/[\0\r]/g, '').trim().slice(0, max)
  return text || fallback
}

function checkboxText(value: boolean | undefined): string {
  return value ? 'enabled' : 'disabled'
}

function loopRhythmInstruction(intent: string, cadenceMinutes: number): string {
  if (intent === 'monitor') {
    return `Loop rhythm: recurring monitor every ${cadenceLabel(cadenceMinutes)}. Treat each Akorith step as one check cycle: look for updates, compare them with the stored seen-state, update FINDINGS.md, and report only new posts, reposts, replies, or relevant changes.`
  }
  if (intent === 'daily-build') {
    return `Loop rhythm: recurring build cycle every ${cadenceLabel(cadenceMinutes)}. Treat each Akorith step as one focused development cycle: choose or refine one idea/feature, implement a small verified increment, record what changed, and keep the repository ready to commit/push.`
  }
  if (intent === 'custom' && cadenceMinutes > 0) {
    return `Loop rhythm: recurring custom cycle every ${cadenceLabel(cadenceMinutes)}. Treat each Akorith step as one complete cycle, save state, report clearly, and let Akorith wait before the next cycle.`
  }
  return 'Loop rhythm: continuous. Work step by step until the goal is complete, saving visible progress after every step.'
}

function loopProfileInstruction(args: WorkspaceCreateArgs, cadenceMinutes: number): string {
  const loopType = safeText(args.loopType, normalizeLoopIntent(args.loopIntent), 80)
  const targetType = safeText(args.targetType, 'project', 80)
  const targetRef = safeText(args.targetRef, 'the created Akorith workspace', 400)
  const scheduleKind = safeText(args.scheduleKind, cadenceMinutes > 0 ? 'recurring' : 'continuous', 80)
  const scheduleDetail = safeText(args.scheduleDetail, cadenceMinutes > 0 ? cadenceLabel(cadenceMinutes) : 'run continuously', 180)
  const autonomy = safeText(args.autonomyLevel, args.mode === 'approval' ? 'guided' : 'semi-auto', 80)
  const stopCondition = safeText(args.stopCondition, 'stop when the loop reaches the iteration, commit, budget, or manual stop limit', 300)
  const commitBehavior = safeText(args.commitBehavior, 'commit', 80)
  const reportFormat = safeText(args.reportFormat, 'summary', 80)
  const safetyLevel = safeText(args.safetyLevel, 'balanced', 80)
  const testCommands = typeof args.testCommands === 'string' && args.testCommands.trim()
    ? args.testCommands.replace(/[\0\r]/g, '').trim().slice(0, 1000)
    : 'auto-detect package scripts and validation commands'

  return `Loop profile:
- Loop type: ${loopType}
- Target: ${targetType} - ${targetRef}
- Schedule: ${scheduleKind} (${scheduleDetail})
- Autonomy: ${autonomy}
- Stop condition: ${stopCondition}
- Commit behavior: ${commitBehavior}; push to GitHub is ${checkboxText(args.pushEnabled)}
- Validation commands: ${testCommands}
- Report format: ${reportFormat}
- Safety level: ${safetyLevel}

Operating rules:
- Analyze the target before changing it, pick a safe useful next action, and explain the plan briefly.
- Never run destructive commands, publish externally, or expose secrets without explicit approval.
- Respect .gitignore and never commit .env files, API keys, tokens, credentials, or private files.
- Run available validation commands before a meaningful commit when possible; report failures honestly.
- Keep the loop auditable: summarize actions, changed files, commands, tests, commits, blockers, and the next suggested step.`
}

/**
 * Phase 23: the user's prompt IS the goal — any autonomous task (research,
 * monitoring, building, …), not only project generation. We scaffold a working
 * folder (git repo, for an artifact/findings history) and bind a fresh loop
 * + auto-commit macro session to it. Idea-generation is only a fallback for an
 * empty prompt ("surprise me"). Does NOT start the loop — the renderer starts the
 * executor in `workspaceDir`, then calls macro:startAuto.
 */
async function createWorkspaceProject(args: WorkspaceCreateArgs): Promise<WorkspaceCreateResponse> {
  // 1. Prefer the user's own prompt as the goal; only invent one when it's blank.
  const userPrompt = args.seed?.trim()
  let idea: ProjectIdea
  if (userPrompt) {
    idea = {
      name: userPrompt.replace(/\s+/g, ' ').slice(0, 60),
      slug: slugify(userPrompt),
      summary: userPrompt,
      firstGoal: userPrompt
    }
  } else {
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
  }

  const loopIntent = normalizeLoopIntent(args.loopIntent)
  const cadenceMinutes = clampInt(
    args.cadenceMinutes ?? defaultCadenceMinutes(loopIntent),
    defaultCadenceMinutes(loopIntent),
    0,
    7 * 24 * 60
  )
  const rhythm = loopRhythmInstruction(loopIntent, cadenceMinutes)
  const profile = loopProfileInstruction(args, cadenceMinutes)
  const commitBehavior = safeText(args.commitBehavior, 'commit', 80)
  const autoCommit = commitBehavior !== 'suggest' && commitBehavior !== 'none'
  const mode: MacroMode = args.mode === 'approval' || args.autonomyLevel === 'guided' ? 'approval' : 'auto'

  // 2. Resolve the target workspace. Existing local-project targets are bound
  // conservatively (no scaffold/write); otherwise create a fresh Akorith repo.
  const existingTarget =
    args.targetType === 'local-project' &&
    typeof args.targetRef === 'string' &&
    isAbsolute(args.targetRef) &&
    existsSync(args.targetRef)
      ? args.targetRef
      : null
  const usingExistingProject = Boolean(existingTarget)
  let dir = existingTarget ?? ''
  if (!dir) {
    const base = args.basePath && isAbsolute(args.basePath) ? args.basePath : join(app.getPath('documents'), 'Akorith Projects')
    dir = join(base, idea.slug)
    for (let n = 2; existsSync(dir) && n <= 50; n++) dir = join(base, `${idea.slug}-${n}`)
  }

  // 3. Scaffold only for new Akorith workspaces.
  if (!usingExistingProject) {
    const init = await initWorkspace(dir, idea)
    if (!init.ok) return { ok: false, error: init.error ?? 'failed to initialize workspace' }
  }

  // 4. Persist/reuse a sidebar project row + a macro session bound to it.
  const project = ensureProjectForPath(dir, usingExistingProject ? basename(dir) : idea.name)
  const session = createMacroSession({
    goal: cleanText(`${idea.firstGoal}\n\n${rhythm}\n\n${profile}`, MAX_GOAL_CHARS),
    plannerProvider: args.plannerProvider,
    plannerModel: args.plannerModel || undefined,
    targetTerminal: args.targetTerminal,
    maxIterations: clampInt(args.maxIterations ?? args.maxRuns ?? 30, 30, 1, 200),
    goodEnoughThreshold: clampInt(args.goodEnoughThreshold ?? 90, 90, 1, 100),
    includeRepoDigest: true,
    mode,
    workspaceDir: dir,
    autoCommit,
    tokenBudget: clampInt(args.tokenBudget ?? 0, 0, 0, 100_000_000),
    // Phase 21: show the user's own words on the loop card (fallback to the idea name).
    title: (args.seed?.trim() || idea.name).slice(0, 200),
    loopIntent,
    cadenceMinutes,
    loopType: safeText(args.loopType, loopIntent, 80),
    targetType: safeText(args.targetType, 'project', 80),
    targetRef: safeText(args.targetRef, dir, 500),
    scheduleKind: safeText(args.scheduleKind, cadenceMinutes > 0 ? 'recurring' : 'continuous', 80),
    scheduleDetail: safeText(args.scheduleDetail, cadenceMinutes > 0 ? cadenceLabel(cadenceMinutes) : 'continuous', 200),
    stopCondition: safeText(args.stopCondition, 'manual, max runs, max commits, or budget', 300),
    maxRuns: clampInt(args.maxRuns ?? args.maxIterations ?? 0, 0, 0, 10_000),
    maxCommits: clampInt(args.maxCommits ?? 0, 0, 0, 10_000),
    commitBehavior,
    pushEnabled: args.pushEnabled === true,
    testCommands: typeof args.testCommands === 'string' ? args.testCommands.slice(0, 1000) : null,
    reportFormat: safeText(args.reportFormat, 'summary', 80),
    safetyLevel: safeText(args.safetyLevel, 'balanced', 80)
  })
  recordLoopEvent({
    loopId: session.id,
    type: 'loop_created',
    message: 'Created a new autonomous loop.',
    metadata: {
      loopType: args.loopType ?? loopIntent,
      targetType: args.targetType ?? 'project',
      scheduleKind: args.scheduleKind,
      autonomyLevel: args.autonomyLevel,
      commitBehavior,
      pushEnabled: args.pushEnabled === true
    }
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
    (a.tokenBudget === undefined || typeof a.tokenBudget === 'number') &&
    (a.loopIntent === undefined || (typeof a.loopIntent === 'string' && LOOP_INTENTS.has(a.loopIntent))) &&
    (a.cadenceMinutes === undefined || typeof a.cadenceMinutes === 'number') &&
    (a.mode === undefined || a.mode === 'approval' || a.mode === 'auto') &&
    (a.loopType === undefined || (typeof a.loopType === 'string' && a.loopType.length <= 80)) &&
    (a.targetType === undefined || (typeof a.targetType === 'string' && a.targetType.length <= 80)) &&
    (a.targetRef === undefined || (typeof a.targetRef === 'string' && a.targetRef.length <= 500)) &&
    (a.scheduleKind === undefined || (typeof a.scheduleKind === 'string' && a.scheduleKind.length <= 80)) &&
    (a.scheduleDetail === undefined || (typeof a.scheduleDetail === 'string' && a.scheduleDetail.length <= 200)) &&
    (a.autonomyLevel === undefined || (typeof a.autonomyLevel === 'string' && a.autonomyLevel.length <= 80)) &&
    (a.stopCondition === undefined || (typeof a.stopCondition === 'string' && a.stopCondition.length <= 300)) &&
    (a.maxRuns === undefined || typeof a.maxRuns === 'number') &&
    (a.maxCommits === undefined || typeof a.maxCommits === 'number') &&
    (a.commitBehavior === undefined || (typeof a.commitBehavior === 'string' && a.commitBehavior.length <= 80)) &&
    (a.pushEnabled === undefined || typeof a.pushEnabled === 'boolean') &&
    (a.testCommands === undefined || (typeof a.testCommands === 'string' && a.testCommands.length <= 1000)) &&
    (a.reportFormat === undefined || (typeof a.reportFormat === 'string' && a.reportFormat.length <= 80)) &&
    (a.safetyLevel === undefined || (typeof a.safetyLevel === 'string' && a.safetyLevel.length <= 80))
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

  ipcMain.handle('macro:archive', (_event, args: { sessionId: string }): MacroResponse => {
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) {
      return { ok: false, error: 'invalid macro:archive payload' }
    }
    try {
      return archiveLoop(args.sessionId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), state: state(args.sessionId) }
    }
  })

  ipcMain.handle('macro:remove', (_event, args: { sessionId: string }) => {
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) {
      return { ok: false, error: 'invalid macro:remove payload' }
    }
    try {
      return removeLoop(args.sessionId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
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

  ipcMain.handle(
    'macro:setPlanner',
    (_event, args: { sessionId: string; plannerProvider: string; plannerModel?: string | null; targetTerminal?: string }): MacroResponse => {
      if (
        typeof args?.sessionId !== 'string' ||
        !VALID_ID.test(args.sessionId) ||
        typeof args.plannerProvider !== 'string' ||
        !VALID_PROVIDER.test(args.plannerProvider) ||
        (args.plannerModel !== undefined && args.plannerModel !== null && (typeof args.plannerModel !== 'string' || !VALID_MODEL.test(args.plannerModel))) ||
        (args.targetTerminal !== undefined && (typeof args.targetTerminal !== 'string' || !VALID_TERMINAL.test(args.targetTerminal)))
      ) {
        return { ok: false, error: 'invalid macro:setPlanner payload' }
      }
      try {
        return setPlanner(args)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), state: state(args.sessionId) }
      }
    }
  )

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
