import { ipcMain } from 'electron'
import { addMessage, sessionExists } from './db'
import { ptyManager } from './pty'
import { sendMetaPrompt } from './providers/registry'
import {
  boundSnapshot,
  buildSummarizerPrompt,
  detectPermissionPrompt,
  heuristicSummary,
  parseSummaryJson,
  renderSummaryText,
  type ExecutorSummary,
  type PermissionDetection
} from './agentic-core'

const VALID_ID = /^[\w-]{1,64}$/
const VALID_PROVIDER = /^[a-z0-9-]{1,32}$/
const VALID_MODEL = /^[\w.:/-]{1,64}$/
const VALID_TERMINAL = /^[a-z0-9-]{1,32}(::[a-z0-9-]{1,40})?$/
const MAX_GOAL_CHARS = 40_000
const MAX_PROMPT_CHARS = 200_000
const SNAPSHOT_CHARS = 8_000
const SUMMARIZE_TIMEOUT_MS = 120_000

type AgentSummaryResponse =
  | { ok: true; summary: ExecutorSummary; detection: PermissionDetection; signature: string; persisted: boolean }
  | { ok: false; error: string; signature?: string }

function cleanText(text: string, max: number): string {
  return text.trim().slice(0, max)
}

function terminalRole(terminalId: string): { label: string; role: string } {
  return terminalId.split('::')[0] === 't2'
    ? { label: 'Olympus', role: 'Codex' }
    : { label: 'Atlantis', role: 'Claude' }
}

function renderExecutionSummaryMessage(terminalId: string, summary: ExecutorSummary): string {
  const terminal = terminalRole(terminalId)
  return `[Execution activity — ${terminal.label} / ${terminal.role}]\n${renderSummaryText(summary)}`
}

async function summarizeTerminalOutput(args: {
  terminalId: string
  providerId: string
  model?: string
  goal?: string
  lastPrompt?: string
  sessionId?: string
}): Promise<AgentSummaryResponse> {
  const snapshot = ptyManager.snapshot(args.terminalId, SNAPSHOT_CHARS + 4_000)
  const bounded = boundSnapshot(snapshot.text, SNAPSHOT_CHARS, 200)
  const signature = `${args.terminalId}:${bounded.chars}`
  if (bounded.text.trim().length < 12) return { ok: false, error: 'No meaningful new output yet.', signature }

  const detection = detectPermissionPrompt(snapshot.text)
  let summary: ExecutorSummary
  try {
    const prompt = buildSummarizerPrompt({
      goal: cleanText(args.goal ?? 'Summarize what the executor just did in the terminal.', MAX_GOAL_CHARS),
      lastPrompt: cleanText(args.lastPrompt ?? '', MAX_PROMPT_CHARS),
      snapshot: bounded.text,
      turnIndex: 1,
      repoDigest: null
    })
    const result = await sendMetaPrompt(args.providerId, args.model || undefined, prompt, AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS))
    summary = parseSummaryJson(result.text) ?? heuristicSummary(snapshot.text)
  } catch {
    summary = heuristicSummary(snapshot.text)
  }

  let persisted = false
  if (args.sessionId && sessionExists(args.sessionId)) {
    try {
      addMessage(args.sessionId, 'assistant', renderExecutionSummaryMessage(args.terminalId, summary), args.providerId, args.model)
      persisted = true
    } catch (error) {
      console.error('[agent-chat] failed to persist execution summary:', error)
    }
  }
  return { ok: true, summary, detection, signature, persisted }
}

export function registerAgentChatIpc(): void {
  ipcMain.handle('agent:summarize', async (_event, args: {
    terminalId: string
    providerId: string
    model?: string
    goal?: string
    lastPrompt?: string
    sessionId?: string
  }) => {
    if (
      typeof args?.terminalId !== 'string' || !VALID_TERMINAL.test(args.terminalId) ||
      typeof args.providerId !== 'string' || !VALID_PROVIDER.test(args.providerId) ||
      (args.model !== undefined && (typeof args.model !== 'string' || !VALID_MODEL.test(args.model))) ||
      (args.goal !== undefined && typeof args.goal !== 'string') ||
      (args.lastPrompt !== undefined && typeof args.lastPrompt !== 'string') ||
      (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !VALID_ID.test(args.sessionId)))
    ) return { ok: false, error: 'invalid agent:summarize payload' }
    try {
      return await summarizeTerminalOutput(args)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agent:detectPermission', (_event, args: { terminalId: string }) => {
    if (typeof args?.terminalId !== 'string' || !VALID_TERMINAL.test(args.terminalId)) {
      return { ok: false, error: 'invalid agent:detectPermission payload' }
    }
    try {
      const alive = ptyManager.isAlive(args.terminalId)
      const snapshot = ptyManager.snapshot(args.terminalId, SNAPSHOT_CHARS)
      return { ok: true, detection: detectPermissionPrompt(snapshot.text), alive }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
