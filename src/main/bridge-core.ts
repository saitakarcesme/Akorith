// Pure, dependency-free bridge encoding helpers. Kept separate from bridge.ts
// (which pulls in electron + node-pty) so the auto-Enter behavior can be unit
// tested in plain Node. bridge.ts is the only module that performs the writes.

// The submit keystroke. Enter is a carriage return (\r) under both a Unix PTY
// and ConPTY. It is sent as its OWN write, after the paste — never appended to
// the paste tail — because TUI CLIs (claude/codex) swallow a \r that arrives in
// the same chunk as a bracketed paste, leaving the prompt un-submitted.
export const SUBMIT_KEY = '\r'

/**
 * Make text land at an interactive prompt the way a terminal paste would.
 * Multi-line text is wrapped in bracketed-paste markers (ESC[200~ … ESC[201~)
 * with inner newlines normalized to \r (mirroring xterm.js paste), so TUI CLIs
 * take it as one paste instead of executing each line. No Enter is appended.
 */
export function encodeForPty(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  return normalized.includes('\n')
    ? `\x1b[200~${normalized.replace(/\n/g, '\r')}\x1b[201~`
    : normalized
}

/**
 * The ordered writes a bridge send performs:
 * - always: the encoded paste body
 * - Auto-Enter ON only: a SEPARATE SUBMIT_KEY write afterward
 *
 * Returning discrete writes (rather than one concatenated string) is the whole
 * fix: it guarantees the Enter is never fused onto the paste, and is omitted
 * entirely when Auto-Enter is off (manual Enter preserved).
 */
export function planBridgeWrites(text: string, autoEnter: boolean): string[] {
  const writes = [encodeForPty(text)]
  if (autoEnter) writes.push(SUBMIT_KEY)
  return writes
}
