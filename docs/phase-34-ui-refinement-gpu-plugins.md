# Phase 34 — UI Refinement · GPU Telemetry · Plugins Foundation

Branched from `feature/phase-33-ui-command-surface-overhaul`. A focused UI
refinement pass driven by the user's screenshot feedback, plus two safe,
read-only system-observation additions (GPU/local runtime visibility and a
static Plugins foundation). No Mission execution, no provider execution, no
backend architecture changes.

## Feedback being addressed

1. **Projects sidebar too crowded** — large folder icons, expand arrows, and a
   long file-path subtitle on every row make it read like a file browser. Make it
   Codex-like: a calm "Projects" heading with thin, text-focused project rows and
   nested chats; no path subtitle by default (path → hover tooltip only).
2. **Usage Activity card half-empty** — the heatmap sits at the top and the rest of
   the card is dead space. Fill it with a summary stat strip + slightly taller cells.
3. **Composer focus border** — a visible border/outline appears on focus. Replace
   with a subtle non-border focus state (background shift only), no layout shift.
4. **Bottom agent dock not resizable** — add a draggable top handle to resize the
   bottom-docked terminals vertically; persist height; never remount PTYs.
5. **GPU/local runtime visibility** — add an honest, read-only GPU telemetry card
   (nvidia-smi where present; honest "unavailable" otherwise; never fake data).
6. **Plugins section** — add a static Plugins foundation page (no execution, no
   marketplace, no remote code).

## Plan & commit split

- `34.1` Audit + plan (this doc).
- `34.2` Simplify project sidebar density (drop path subtitle, slimmer rows, subtle icon).
- `34.3` Refine project/chat hierarchy (active/empty states, indentation, ellipsis).
- `34.4` Remove composer/textbox focus border; subtle focus state across composer controls.
- `34.5` Fix Usage Activity card (summary stat strip + taller cells; balance vs Provider mix).
- `34.6` GPU telemetry foundation in main (`gpu-status.ts`) + IPC + preload types.
- `34.7` Dashboard GPU / Local Runtime card (honest states, manual refresh).
- `34.8` Plugins page foundation (static registry, nav entry, plugin cards).
- `34.9` Resizable bottom agent dock (drag handle, persisted height, no PTY remount).
- `34.10` Final visual QA polish + docs.

## UI-only vs observation-only

- **UI-only (renderer):** sidebar density, project/chat hierarchy, composer focus,
  usage card, Plugins page, bottom-dock resize.
- **Main/preload observation-only (read-only, no writes/secrets/polling):** GPU status
  (`gpu:getStatus`), static plugin registry (`plugins:list`).

## GPU telemetry limitations (honest by design)

- **NVIDIA (Win/Linux):** read-only `nvidia-smi --query-gpu=...` with a timeout; parsed
  safely; returns `unavailable` if the binary is missing or errors.
- **macOS / Apple Silicon:** no privileged telemetry (no sudo/powermetrics). GPU
  utilization is reported `unavailable` with a clear reason. Renderer/vendor info may be
  shown only if trivially available; utilization is never fabricated.
- **Remote Ollama:** `/api/tags` does not expose GPU; remote endpoints report
  "remote GPU telemetry unavailable". A companion/SSH/secured-telemetry endpoint is the
  future path (noted, not implemented).

## Preservation contract

No edits to provider runtime/prompts/returns, token accounting, usage logging,
`bridgeSend → PtyManager.write`, PTY command kinds, Test Lab, Agent Hub / Mission
preview, `loopex.db`, `loopex.config.json`, or AkorithLoop. No mission execution / Run
buttons. GPU + plugin surfaces are read-only; no secrets, no hardcoded IPs, no polling.

## Validation

`npm run typecheck`, `npm run verify:local-executor`, `npm run verify:workspace-loop`,
`npm run build`, `git diff --check`; then a manual `npm run dev` smoke pass, left open.
