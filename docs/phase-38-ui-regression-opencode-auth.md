# Phase 38 — UI Regression Fixes · Persistent Thinking · OpenCode Auth

Branched from `main` (`d07c09c`, Phase 37). Focused fixes for regressions found in the
post-Phase-37 build. No Mission execution, no provider runtime changes, no controller
security changes, no Gaia breakage.

## Audit — real root causes

1. **User messages left-aligned.** A later "Codex-style" override (`styles.css:~6118`)
   sets `.chat-msg.user { align-self: stretch }`, overriding the Phase 37 `flex-end`. The
   column IS flex, so fixing that rule (flex-end, white, dark text, big radius, max-width)
   makes the bubble right-align.
2. **Project/chat ⋯ menus do nothing.** `.sidebar-surface` has `will-change: opacity,
   transform` (added for the Phase 33 vanish) which establishes a **containing block for
   `position: fixed` descendants**, and `overflow: hidden` then **clips the fixed menu** —
   it renders but is invisible. Fix: render both menus through a **React portal to
   `document.body`** so they escape the surface.
3. **Thinking disappears.** The single ChatPanel stays mounted, but the history-reload
   effect can still wipe the in-flight message. Lift **pending-session tracking to App**
   (a durable Set keyed by session id) and skip the reload while a session is pending.
4. Loop page gray bg, composer top separator line, project child vertical guide line,
   per-project count badge, project chevrons, and the profile footer are all CSS/markup.

## Plan & commits

- `38.1` Audit + plan (this doc).
- `38.2` Right-align user message bubbles (fix the overriding rule).
- `38.3` Resizable sidebar width (handle, min/max, persisted, double-click reset).
- `38.4` Portal the project + chat ⋯ menus to document.body (fixes both menus).
- `38.5` Remove the project child vertical guide line and the per-project count badge.
- `38.6` Replace project chevrons with folder icons (open/closed).
- `38.7` Normalize Loop page background + remove the composer top separator line.
- `38.8` Polish the profile footer (balanced, symmetric, monochrome).
- `38.9` Persist thinking state across navigation (App-level pending sessions).
- `38.10` OpenCode auth status + docs.
- `38.11` Final validation + visual QA.

## Preservation

No change to Claude/Codex/Ollama runtime/prompts/returns, token accounting, usage logging,
`bridgeSend → PtyManager.write`, PTY kinds, Olympus/Gaia/Atlantis, controller security,
`loopex.db`/`loopex.config.json`, AkorithLoop. No secrets stored; OpenCode tokens never
read/printed.

## Validation

`typecheck`, `verify:local-executor`, `verify:workspace-loop`, `verify:controller`,
`build`, `git diff --check`; `opencode --version` + `opencode auth list`; manual smoke,
left open; then merge to main.
