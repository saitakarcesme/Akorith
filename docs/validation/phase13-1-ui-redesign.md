# Phase 13.1 — Chat-first Codex-style workspace (UI redesign addendum)

A structural UI pass on top of Phase 13. Not a color change — the visible component hierarchy,
layout, and workflow changed. Screenshot: `phase13-1-ui.png`.

## What changed structurally

- **Layout:** `Sidebar | ChatPanel | TerminalColumn` → `Sidebar | ChatPanel` (full-width
  chat-first) + an `AgentDrawer` overlay. `TerminalColumn` is no longer rendered.
- **Removed:** the always-visible right "Open a project to start agents" onboarding panel and the
  permanent right terminal column.
- **Theme:** dark Codex-style main workspace; light/white sidebar kept (own token scope);
  near-monochrome accent — purple/indigo removed.

## Agent drawer (background agents)

- `AgentDrawer.tsx` hosts Olympus (Codex, `t2`) and Atlantis (Claude, `t1`).
- It is **always mounted while a project with a path is active**; open/close is a CSS transform,
  so the PTYs and snapshot buffers keep running when the drawer is closed (closing never kills
  agents). Opening reveals the already-sized, live terminals.
- Toggled from the top-bar **Activity** button, the agent-status chip, or the composer **Show
  agents** chip; closed via the ✕ or the scrim.
- Terminal split (30–70 clamp), snapshot reads, and the single `bridgeSend → PtyManager.write`
  path are preserved.

## Project flow (sidebar-first)

- Open/Create live in the sidebar. Selecting/opening/creating a project sets the active project,
  which mounts the drawer and **starts Codex + Claude in the project cwd** through the existing
  safe PTY startup.
- The center hero's Open/Create buttons route back to that same sidebar flow (`onOpenProject`,
  and `onCreateProject` bumps a `createSignal` the sidebar watches to open its create modal).
- A header **agent-status chip** ("Codex & Claude ready" / "Agents starting…" / shell-fallback
  warning) shows agents are running without opening the drawer.

## Chat-first ChatPanel

- **No project:** centered hero "What should we work on?" + Open/Create (composer hidden).
- **Project, no messages:** hero "What should we build in <project>?" + the large centered composer.
- **Conversation:** centered max-760px message column (Codex-style turns) + composer docked at bottom.
- **Composer:** one large rounded dark surface with inline controls — target route
  (Olympus/Atlantis), Repo context, Auto-Enter, ✦ Suggest, Show agents, Send/Stop.

## Macro-loop integration

- `MacroLoopPanel` engine/state unchanged. It now renders **inside the composer**, collapsed by
  default (a compact status-chip head; proposal/result/permission cards when expanded). Approval is
  still the default mode; Auto remains explicit + safety-gated; Stop stays visible when running.

## Verification

- `npm run typecheck`, `npm run build` pass.
- `verify-macro-loop` ok · `verify-testlab` 19/0 · `verify-agentic-loop` ok.
- `npm run pack:mac` builds; packaged `Akorith.app` launches (menu bar "Akorith"), DB initializes.

## Known limitations

- Project-active states (hero composer, conversation, drawer open with live terminals) are
  code-verified; full GUI click-through capture needs macOS Accessibility permission, which isn't
  grantable non-interactively here (same limitation noted in Phase 12/13). The empty-state hero is
  screenshot-verified.
- `TerminalColumn.tsx` is retained but unused (superseded by `AgentDrawer`).
- Packaged app is still ad-hoc signed only (Gatekeeper); Windows installer config present, unbuilt.
