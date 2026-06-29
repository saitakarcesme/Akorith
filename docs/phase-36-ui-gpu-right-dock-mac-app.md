# Phase 36 — UI Fixes · Remote GPU Telemetry · Right Dock · macOS App Refresh

Branched from `main` (`8114736`, Phase 35 merge). Targeted product-polish + UX
correctness from the user's screenshot feedback, plus a real remote GPU telemetry path
and a macOS app refresh. No Mission execution, no provider runtime changes.

## Audit (root causes found)

- **Sidebar Projects** is a collapsible `sidebar-fold` (chevron + folder icon) — it should
  be a plain heading with the list always visible.
- **Selected "pills":** `.project-row.is-active` uses `background: var(--hover-strong)` +
  `box-shadow: inset 2px 0 0 accent` (left accent bar); `.project-chat.is-active` uses a
  strong fill. Feedback: hover-only, no big selected pill, no accent bar.
- **Plugins grid:** `display:grid` defaults to `align-items: stretch`, so expanding one
  card's details stretches its row neighbours. Fix → `align-items: start`.
- **Test Lab output:** rendered by xterm (`TestTerminal`). The constructor lacks
  `convertEol`, so child-process stdout using `\n` (no `\r`) staircases — the "half a
  sentence top / half below" misalignment. The host also has padding that skews the fit
  addon's column count. Fix → `convertEol: true` + remove host padding + refit.
- **Agent Activity** modes are Drawer / Bottom(dock) / Focus(full); needs a **Right** dock
  beside the chat, horizontally resizable, PTYs never remounted.
- **GPU telemetry:** the Mac honestly reports local GPU unavailable. The PC's GPU can only
  be seen if the PC exposes it — so add **remote telemetry profiles** that call a remote
  Akorith **Controller API** (`/v1/gpu`, `/v1/ollama`) over Tailscale/VPN/LAN.

## Plan & commits

- `36.1` Audit + plan (this doc).
- `36.2` Projects as a plain heading (not a collapsible folder); always-visible list.
- `36.3` Remove selected pills from project/chat rows (hover-only, subtle active text).
- `36.4` Plugins grid `align-items: start` so expansion doesn't resize neighbours.
- `36.5` Test Lab output: `convertEol`, host padding fix, refit — readable terminal output.
- `36.6` Right dock mode for Agent Activity (horizontal resize; PTY-preserving).
- `36.7` Remote GPU telemetry profiles (config + main fetch via controller + IPC + preload).
- `36.8` Dashboard source-aware GPU card (remote PC → local → unavailable + setup CTA).
- `36.9` Settings remote-telemetry UI + macOS app refresh script.
- `36.10` Build, package, install latest macOS app, docs, final QA.

## Remote GPU telemetry (honest, secure)

The Mac stores remote telemetry profiles `{ name, baseUrl, token, enabled, priority }`
pointing at a **remote Akorith Controller** (the PC running Ollama, with Controller API
enabled + Allow-LAN on a trusted private network). The Mac calls the remote `GET /v1/gpu`
and `GET /v1/ollama` with the bearer token (read-only). The Dashboard chooses: healthy
remote → PC GPU; else local; else honest unavailable + a "configure a remote profile" CTA.
Never fabricates data; token masked in UI; no public exposure; Phase 35 controller
security unchanged (loopback default, LAN opt-in, token required, read-only).

## Preservation

No change to provider runtime/prompts/returns, token accounting, usage logging,
`bridgeSend → PtyManager.write`, PTY command kinds, Test Lab execution/scoring/PDF,
`loopex.db`/`loopex.config.json`, AkorithLoop. No execution endpoints; controller defaults
unchanged. macOS app cleanup moves old copies to a timestamped backup (never `rm -rf`).

## Validation

`typecheck`, `verify:local-executor`, `verify:workspace-loop`, `verify:controller`,
`build`, `git diff --check`; then `pack:mac`, install, `npm run dev` smoke (left open),
then merge to main.
