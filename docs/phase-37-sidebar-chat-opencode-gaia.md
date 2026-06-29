# Phase 37 — Sidebar Actions · Chat Polish · Thinking State · OpenCode "Gaia"

Branched from `main` (`728d213`, Phase 36). Fixes concrete sidebar/chat issues from the
user's visual review and adds OpenCode as a third agent terminal — **Gaia** — between
Olympus (Codex) and Atlantis (Claude). No change to Claude/Codex/Ollama provider runtime;
the PTY bridge invariant is preserved.

## Audit (root causes)

- **Project three-dot menu**: the row menu code exists but is being rebuilt for clarity —
  new layout puts a small new-chat icon + a ⋯ menu (Rename / Reveal / Copy path / Remove)
  on the project row (hover/active), and removes the inline "+ New chat" text row and the
  inline "Edit/Remove" text on chat rows (those move to a per-chat ⋯ menu).
- **User chat bubbles**: `.chat-msg.user` is full-width left like the assistant. The user
  wants their messages right-aligned, white, more rounded; assistant stays as-is.
- **Thinking state lost on navigation**: ChatPanel stays mounted, but navigating back
  re-runs the `historySel` effect which reloads messages from the DB and wipes the
  in-flight streaming assistant message. Fix: skip the reload when the selected session is
  the one already shown **and** a request is in flight (`busyRequestId`).
- **Thinking animation**: the streaming placeholder is a bare "…". Replace with a proper
  monochrome thinking indicator that persists while pending.
- **OpenCode/Gaia**: not installed; `AgentId` already includes `'opencode'`; PTY logical
  ids resolve generically (`tN` → `tN::project`), so Gaia = `t3` slots in cleanly.

## Plan & commits

- `37.1` Audit + plan (this doc).
- `37.2` Project three-dot menu (Rename / Reveal / Copy path / Remove) — robust + working.
- `37.3` Project-row new-chat icon; remove the "+ New chat" text row.
- `37.4` Per-chat ⋯ menu (Rename / Delete); remove inline Edit/Remove text; hover polish.
- `37.5` Right-aligned white rounded user chat bubbles (assistant unchanged).
- `37.6` Persist thinking state across navigation (guard the history reload).
- `37.7` Improved monochrome thinking indicator.
- `37.8` OpenCode detection + install (npm global) + plugin diagnostics update.
- `37.9` Gaia OpenCode PTY kind + third terminal between Olympus and Atlantis.
- `37.10` Gaia composer target + output capture/summarize (reuse existing flow).
- `37.11` OpenCode Go setup guidance (Settings/plugin notes; no secrets).
- `37.12` Docs + validation + visual QA.

## OpenCode / Gaia

- Agent order becomes **Olympus · Gaia · Atlantis** (`t2 · t3 · t1`). Gaia launches the
  `opencode` TUI in the project folder via a new `opencode` PTY command kind; if the CLI
  is missing the pane falls back to a shell with install guidance (never crashes).
- Composer target segmented control gains Gaia; the existing bridge (`bridgeSend →
  PtyManager.write`) writes to logical `t3`; auto-enter, snapshot, summarize, and
  permission detection all work via the existing terminal-id paths.
- OpenCode Go login is interactive (`opencode auth login`) — Akorith surfaces the exact
  command and status; it never bypasses auth, stores, or prints tokens.

## Preservation

No change to Claude/Codex/Ollama runtime/prompts/returns, token accounting, usage logging,
`bridgeSend → PtyManager.write`, existing PTY kinds, controller security, `loopex.db`/
`loopex.config.json`, AkorithLoop. No mission execution, no unsafe plugin execution, no
secrets stored.

## Validation

`typecheck`, `verify:local-executor`, `verify:workspace-loop`, `verify:controller`,
`build`, `git diff --check`; `opencode --version` if installed; manual `npm run dev` smoke,
left open; then merge to main.
