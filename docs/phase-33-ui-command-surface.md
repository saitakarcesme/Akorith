# Phase 33 — UI Command Surface Overhaul

Branched from `feature/phase-32-mission-engine-skeleton`. This is a UI/UX-first phase:
push Akorith toward a serious, black-heavy, technical Agent-OS command surface
(Codex / OpenCode inspired) without touching provider runtime, PTY, macro/workspace
loops, Test Lab, token accounting, or database/config filenames.

## Audit (current state)

- **Layout** — `App.tsx` holds a 3-region shell: `Sidebar` + `workspace` (ChatPanel
  + AgentDrawer overlay) + page wrappers (Test, Loops) + Dashboard. Views:
  `workspace | general | dashboard | test | loops`. **Settings + Missions are not
  routed views** — `SettingsCenter` is rendered as a modal overlay from the sidebar
  profile button; `MissionCenter` is reachable from inside SettingsCenter.
- **Sidebar** (`Sidebar.tsx`) — renders: New chat, primary nav, a **Projects** section
  (flat rows, no chats shown), then **provider folders** (Claude / Codex / Local) listing
  general chats, then a **Recent chats** section. Collapse uses a translateX *slide*
  with a hover-zone + edge button.
- **Data model** — `SessionRow` already carries `projectId` (null = general). So
  *multiple chats per project is already supported at the DB layer*; the sidebar simply
  never exposes per-project chats. No migration needed for multi-chat.
- **Composer** (`ChatPanel.tsx`) — model/provider pickers are two **native `<select>`**
  elements in the top bar (`ws-topbar-right .model-switcher`). Composer chips live at the
  bottom. Sending, sessions, memory, bridge, permissions all flow through existing IPC.
- **Tokens** (`styles.css`) — full token system across `:root`, `[data-theme='dark']`,
  `[data-theme='light']`. A `--mono-*` set was pre-staged in Phase 28 "for later" — that
  later is now. Radii are soft (sm 8 / 12 / lg 16 / xl 22).
- **Ollama** — `ollama-connection.ts` + `ollama:*` IPC expose getSettings / setSettings /
  testEndpoint / getShareInfo. No remote-profile list or priority auto-connect yet.
- **Terminals** — `AgentDrawer` (overlay) hosts two `TerminalColumn`/`TerminalPane`s.
  Only a hidden/drawer toggle exists; no dock/expand modes.

## Plan & commit split

1. `33.1` Audit + plan (this doc).
2. `33.2` Monochrome design tokens (black-heavy values for dark/light/root).
3. `33.3` Sharper radius + base surface geometry.
4. `33.4` Remove provider folders from the sidebar.
5. `33.5` Project-first sidebar: expandable projects with their chats.
6. `33.6` Per-project "New chat" + chat rows; general chats section (no provider folders).
7. `33.7` Sidebar vanish/fade collapse (replace slide).
8. `33.8` Move model picker into the composer.
9. `33.9` Custom dark model/provider listbox (kill native white dropdown).
10. `33.10` Settings as a real full-page view (route, not modal).
11. `33.11` Borderless component pass.
12. `33.12` Dashboard + usage chart polish (thicker, higher-contrast, monochrome).
13. `33.13` Remote Ollama profiles (settings + persistence + IPC).
14. `33.14` Ollama auto-connect by endpoint priority + active-endpoint surfacing.
15. `33.15` Remote models in the composer model picker (source labels).
16. `33.16` Terminal docking modes (drawer / bottom dock / focus).
17. `33.17` Bottom workbench shell (Terminal / Changes / Runtime / Missions tabs).
18. `33.18` Read-only Changes panel (safe `git status`/`diff --stat` IPC).
19. `33.19` Light/dark readability QA pass.
20. `33.20` Final visual smoke polish + docs.

## Preservation contract

- No edits to `src/main/providers/*` runtime, prompt construction, return values.
- No change to token accounting / usage logging / `bridgeSend → PtyManager.write`.
- No PTY command-kind breakage; no terminal-output parsing/storage beyond existing.
- DB stays `loopex.db`; config stays `loopex.config.json`; additive-only schema.
- Changes panel and remote-Ollama health checks are **read-only**, timeout-bounded.
- No private IPs / machine names hardcoded; no public Ollama exposure encouraged.

## Validation

`npm run typecheck`, `npm run verify:local-executor`, `npm run verify:workspace-loop`,
`git diff --check`, then a manual `npm run dev` visual smoke pass; leave the app open.
