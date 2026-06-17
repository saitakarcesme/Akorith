// The chat→terminal bridge: the ONE programmatic path for putting chat-
// produced text in front of a terminal. Everything funnels through
// bridgeSend() → PtyManager.write(); no second write path may exist.

import { ipcMain } from 'electron'
import { ptyManager } from './pty'
import { getBridgeSettings, setBridgeAutoEnter, type BridgeSettings } from './config'
import { planBridgeWrites } from './bridge-core'

const TERMINAL_LABELS: Record<string, string> = {
  t1: 'Atlantis',
  t2: 'Olympus'
}

const VALID_ID = /^[a-z0-9-]{1,32}$/
const MAX_TEXT_CHARS = 200_000

// How long to wait after writing the paste before sending the submit Enter.
// The paste must be fully ingested first; otherwise the Enter races the paste
// and is dropped. Codex/Claude TUIs can need a beat after bracketed paste
// finishes, especially for long prompts. Exposed for tests.
export const SUBMIT_DELAY_MS = 220

export interface BridgeSendArgs {
  text: string
  targetTerminalId: string
  /** true → submit the prompt automatically (Enter) after pasting. */
  autoEnter: boolean
}

export type BridgeSendResponse = { ok: true } | { ok: false; error: string }

/**
 * Send text into a terminal exactly as if pasted there.
 *
 * Callable by the UI (via bridge:send IPC) and by non-human callers.
 * Phase 9: the semi-automatic macro-loop calls this directly after approval.
 *
 * Auto-Enter semantics (Phase 14.3):
 * - ON  → write the paste, then write a SEPARATE Enter so the CLI runs it.
 * - OFF → write the paste only; the user presses Enter themselves.
 * Both writes go through ptyManager.write() — still the single write path.
 */
export function bridgeSend({ text, targetTerminalId, autoEnter }: BridgeSendArgs): BridgeSendResponse {
  const label = TERMINAL_LABELS[targetTerminalId] ?? targetTerminalId
  if (!ptyManager.isAlive(targetTerminalId)) {
    return { ok: false, error: `${label} has no live shell` }
  }
  // planBridgeWrites returns [paste] or [paste, Enter]. The paste goes now; the
  // Enter (Auto-Enter ON only) is deferred so it arrives as its own keystroke
  // once the paste has settled — fixing "pasted but not submitted" without ever
  // fusing the \r onto the paste or double-submitting.
  const [paste, submit] = planBridgeWrites(text, autoEnter)
  ptyManager.write(targetTerminalId, paste)
  if (submit !== undefined) {
    setTimeout(() => {
      if (ptyManager.isAlive(targetTerminalId)) ptyManager.write(targetTerminalId, submit)
    }, SUBMIT_DELAY_MS)
  }
  return { ok: true }
}

export function registerBridgeIpc(): void {
  ipcMain.handle('bridge:send', (_event, args: BridgeSendArgs): BridgeSendResponse => {
    if (
      typeof args?.text !== 'string' ||
      args.text.length === 0 ||
      args.text.length > MAX_TEXT_CHARS ||
      typeof args.targetTerminalId !== 'string' ||
      !VALID_ID.test(args.targetTerminalId) ||
      typeof args.autoEnter !== 'boolean'
    ) {
      return { ok: false, error: 'invalid bridge:send payload' }
    }
    return bridgeSend(args)
  })

  ipcMain.handle('bridge:getSettings', (): BridgeSettings => getBridgeSettings())

  ipcMain.handle('bridge:setAutoEnter', (_event, autoEnter: unknown): BridgeSettings => {
    if (typeof autoEnter !== 'boolean') return getBridgeSettings()
    return setBridgeAutoEnter(autoEnter)
  })
}
