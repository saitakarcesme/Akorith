// Phase 9 macro-loop orchestration. This is semi-automatic only:
// planner proposals are meta calls, every executor send is approval-gated,
// and terminal injection still flows only through bridgeSend() -> PtyManager.write().

import { ipcMain } from 'electron'
import { bridgeSend } from './bridge'
import { getBridgeSettings } from './config'
import { buildDigest } from './digest'
import {
  createMacroSession,
  createMacroTurn,
  getMacroState,
  listMacroSessions,
  updateMacroSession,
  updateMacroTurn,
  type MacroSessionWithTurns
} from './db'
import { sendMetaPrompt } from './providers/registry'
import {
  buildPlannerPrompt,
  goodEnoughReached,
  maxIterationsReached,
  parsePlannerProposal
} from './macro-core'

const VALID_ID = /^[\w-]{1,64}$/
const VALID_PROVIDER = /^[a-z0-9-]{1,32}$/
const VALID_MODEL = /^[\w.:/-]{1,64}$/
const VALID_TERMINAL = /^[a-z0-9-]{1,32}$/
const MAX_GOAL_CHARS = 40_000
const MAX_SUMMARY_CHARS = 80_000
const MAX_PROMPT_CHARS = 200_000
const PROPOSE_TIMEOUT_MS = 600_000

type MacroResponse = { ok: true; state: MacroSessionWithTurns } | { ok: false; error: string; state?: MacroSessionWithTurns }

const activeProposals = new Map<string, AbortController>()

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
}): Promise<MacroResponse> {
  const session = createMacroSession({
    goal: cleanText(args.goal, MAX_GOAL_CHARS),
    plannerProvider: args.plannerProvider,
    plannerModel: args.plannerModel || undefined,
    targetTerminal: args.targetTerminal,
    maxIterations: clampInt(args.maxIterations, 5, 1, 50),
    goodEnoughThreshold: clampInt(args.goodEnoughThreshold, 85, 1, 100),
    includeRepoDigest: args.includeRepoDigest
  })
  return { ok: true, state: requireState(session.id) }
}

async function propose(sessionId: string): Promise<MacroResponse> {
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
  const prompt = buildPlannerPrompt({
    goal: s.session.goal,
    iteration: s.turns.length + 1,
    maxIterations: s.session.maxIterations,
    goodEnoughThreshold: s.session.goodEnoughThreshold,
    turns: s.turns,
    repoDigest: digest
  })

  updateMacroSession(sessionId, { status: 'proposing' })
  const controller = new AbortController()
  activeProposals.set(sessionId, controller)
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(PROPOSE_TIMEOUT_MS)])
    const result = await sendMetaPrompt(s.session.plannerProvider, s.session.plannerModel ?? undefined, prompt, signal)
    const current = requireState(sessionId)
    if (current.session.status === 'stopped') return { ok: true, state: current }

    const parsed = parsePlannerProposal(result.text)
    createMacroTurn({
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
    updateMacroSession(sessionId, {
      status: 'awaiting_approval',
      finalScore: parsed.doneScore ?? undefined
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

function approve(args: { sessionId: string; turnId: string; editedProposal?: string }): MacroResponse {
  const s = requireState(args.sessionId)
  const turn = s.turns.find((t) => t.id === args.turnId)
  if (!turn) return { ok: false, error: 'macro turn not found', state: s }
  const text = cleanText(args.editedProposal || turn.proposal || '', MAX_PROMPT_CHARS)
  if (!text) return { ok: false, error: 'approved prompt is empty', state: s }

  updateMacroSession(args.sessionId, { status: 'sending' })
  updateMacroTurn(args.turnId, { status: 'sending', editedProposal: text })
  const send = bridgeSend({
    text,
    targetTerminalId: s.session.targetTerminal,
    autoEnter: getBridgeSettings().autoEnter
  })
  if (!send.ok) {
    updateMacroTurn(args.turnId, { status: 'awaiting_approval', error: send.error })
    updateMacroSession(args.sessionId, { status: 'error', stopReason: send.error })
    return { ok: false, error: send.error, state: requireState(args.sessionId) }
  }
  updateMacroTurn(args.turnId, {
    status: 'awaiting_executor_result',
    editedProposal: text,
    sentPrompt: text,
    error: null
  })
  updateMacroSession(args.sessionId, { status: 'awaiting_executor_result' })
  return { ok: true, state: requireState(args.sessionId) }
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
  updateMacroSession(sessionId, { status: 'stopped', stopReason: reason })
  return { ok: true, state: requireState(sessionId) }
}

function complete(sessionId: string): MacroResponse {
  const s = requireState(sessionId)
  const score = s.turns
    .map((t) => t.goodEnoughScore)
    .filter((n): n is number => typeof n === 'number')
    .at(-1)
  updateMacroSession(sessionId, { status: 'completed', stopReason: 'user_complete', finalScore: score ?? undefined })
  return { ok: true, state: requireState(sessionId) }
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
    typeof a.includeRepoDigest === 'boolean'
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

  ipcMain.handle('macro:get', (_event, args: { sessionId: string }) => {
    if (typeof args?.sessionId !== 'string' || !VALID_ID.test(args.sessionId)) return null
    return getMacroState(args.sessionId)
  })

  ipcMain.handle('macro:list', (_event, args: { limit?: number }) =>
    listMacroSessions(typeof args?.limit === 'number' ? args.limit : 20)
  )
}
