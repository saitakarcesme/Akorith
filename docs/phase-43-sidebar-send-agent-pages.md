# Phase 43 — Sidebar Simplification, Icon Send Controls, Agent Activity Scroll, Companions & Agents Pages

Branched from `main` (`c5aaa94`). Focused UI/UX polish — no runtime, provider, controller,
PTY/bridge, or mission changes.

## Audit (starting state)

- **Send/Stop** — `ChatPanel.tsx` renders `.send-button` with a `<SendIcon/>` + the text
  "Send" (and a text "Stop" while busy). `.send-button` is a pill (`padding: 8px 18px`,
  `border-radius: var(--radius-sm)`).
- **Agent Activity** — `AgentDrawer.tsx` `.agent-drawer-body` is a flex column of three
  `.terminal-slot`s (`flexBasis: 0` + `flexGrow`, `flexShrink: 1`). With no min-height floor
  and no `overflow`, three expanded panes **squish** rather than scroll.
- **Sidebar** — `Sidebar.tsx` opens with a `.sidebar-brand` block ("Akorith" / "Agent
  orchestration") that also holds the collapse button, then "New chat", then `NAV_ITEMS`
  (Workspace, Loop, Dashboard, Test, Plugins), then Projects, then the profile footer.
- **Views** — `App.tsx` `AppView = ChatMode | 'dashboard' | 'test' | 'loops' | 'plugins'`;
  `handleNavigate` falls through to `setView` for non-chat views.

## Plan / commits

1. Audit (this doc).
2. **Send/Stop → circular icon-only**: add `StopIcon`; `.send-button` becomes a 44px circle,
   icon-only, `aria-label`/`title` for Send/Stop. Enter-to-send and Auto-Enter untouched.
3. **Agent Activity internal scroll**: `.agent-drawer-body { overflow-y: auto }` +
   `.terminal-slot:not(.is-collapsed) { min-height }` so panes keep a usable height and the
   body scrolls in dock/right/full/drawer. No PTY remount; fit/ResizeObserver preserved.
4. **Remove sidebar brand header**: drop `.sidebar-brand`; move the collapse control to the
   nav area. Resize/collapse/profile-footer unchanged; sidebar starts at "New chat".
5. **Companions + Agents nav + views**: add `CompanionsIcon`/`AgentsIcon`, extend `AppView`,
   `NAV_ITEMS`, and `App` routing.
6. **Placeholder pages**: `CompanionsPage.tsx` + `AgentsPage.tsx` (title · subtitle · "Soon!"
   · subtle pulse), command-surface styling.
7. Docs + final polish.

## Intentionally unchanged

Provider runtime (Claude/Codex/OpenCode/Ollama), Controller security, PTY/bridge,
Olympus/Gaia/Atlantis, model picker / More menu, chat memory, no mission execution.
