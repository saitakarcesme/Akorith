// The chat→terminal bridge: the ONE programmatic path for putting chat-
// produced text in front of a terminal. Everything funnels through
// bridgeSend() → PtyManager.write(); no second write path may exist.

import { ipcMain } from 'electron'
import { ptyManager } from './pty'
import { getBridgeSettings, setBridgeAutoEnter, type BridgeSettings } from './config'

const TERMINAL_LABELS: Record<string, string> = {
  t1: 'Terminal 1',
  t2: 'Terminal 2'
}

const VALID_ID = /^[a-z0-9-]{1,32}$/
const MAX_TEXT_CHARS = 200_000

export interface BridgeSendArgs {
  text: string
  targetTerminalId: string
  /** true → append Enter so the CLI executes immediately. */
  autoEnter: boolean
}

export type BridgeSendResponse = { ok: true } | { ok: false; error: string }

/**
 * Send text into a terminal exactly as if pasted there.
 *
 * Callable by the UI (via bridge:send IPC) and by non-human callers.
 * Phase 9: the semi-automatic macro-loop calls this directly after approval.
 */
export function bridgeSend({ text, targetTerminalId, autoEnter }: BridgeSendArgs): BridgeSendResponse {
  const label = TERMINAL_LABELS[targetTerminalId] ?? targetTerminalId
  if (!ptyManager.isAlive(targetTerminalId)) {
    return { ok: false, error: `${label} has no live shell` }
  }
  ptyManager.write(targetTerminalId, encodeForPty(text, autoEnter))
  return { ok: true }
}

/**
 * Make text land at an interactive prompt the way a terminal paste would:
 * - Enter is a carriage return (\r) under ConPTY — appended only with autoEnter.
 * - Multi-line text is wrapped in bracketed-paste markers (ESC[200~ … ESC[201~)
 *   with inner newlines normalized to \r (mirroring xterm.js paste), so TUI
 *   CLIs like `claude`/`codex` take it as one paste instead of executing each
 *   line. The auto-Enter \r goes after the closing marker.
 */
function encodeForPty(text: string, autoEnter: boolean): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  const body = normalized.includes('\n')
    ? `\x1b[200~${normalized.replace(/\n/g, '\r')}\x1b[201~`
    : normalized
  return autoEnter ? `${body}\r` : body
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
