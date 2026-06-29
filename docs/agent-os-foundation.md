# Agent OS Foundation

Phase 28 adds a behavior-preserving foundation for turning Akorith into a local-first AI Agent Control Center. This phase does not replace the existing provider registry, PTY manager, macro loop, local executor, Test Lab, settings, or current user workflow.

## What Agent OS Means

Agent OS means Akorith can eventually coordinate multiple coding and automation agents through one local-first control center:

- Codex CLI
- Claude Code / Claude CLI
- Ollama and other local models
- OpenCode
- Future Hermes-style memory, skills, workflow memory, and automations
- Akorith's existing terminals, workspace projects, Test Lab, macro loop, autonomous loop, local executor, and AkorithLoop workspace concepts

The near-term goal is not a rewrite. The first step is a small typed foundation that can describe, detect, and later launch or orchestrate agents without disturbing existing runtime paths.

## Added In This Phase

- `src/main/agents/types.ts` defines Agent OS metadata, detection, status, and capability types.
- `src/main/agents/capabilities.ts` defines human-readable capability labels.
- `src/main/agents/status.ts` adds shared safe detection helpers.
- `src/main/agents/registry.ts` lists adapters and exposes read-only detection functions.
- `src/main/agents/adapters/claude.ts` documents the existing Claude provider and PTY integration.
- `src/main/agents/adapters/codex.ts` documents the existing Codex provider and PTY integration.
- `src/main/agents/adapters/ollama.ts` documents the existing Ollama/local provider and uses a conservative HTTP reachability check.
- `src/main/agents/adapters/opencode.ts` adds a future-ready OpenCode metadata/detection placeholder.
- `src/main/agents/adapters/memory.ts` adds a future internal Memory / Skills placeholder.
- `src/main/loops/types.ts` centralizes main-process macro loop status, mode, and executor type aliases.
- The existing preload `agent` namespace now includes read-only `list`, `detect`, and `detectAll` calls.
- Settings now includes a minimal Agent Hub surface for metadata and detection.
- `src/renderer/src/styles.css` includes unused future monochrome token notes for the eventual black-and-white identity.

## Intentionally Not Changed

- Existing Claude, Codex, and Ollama provider behavior remains in `src/main/providers/*`.
- Existing provider/model selectors remain unchanged.
- Existing PTY command kinds and terminal startup remain unchanged.
- The chat-to-terminal invariant remains `bridgeSend()` to `PtyManager.write()`.
- The DB filename remains `loopex.db`.
- The config filename remains `loopex.config.json`.
- AkorithLoop remains separate.
- The app was not globally redesigned and logo/icon assets were not replaced.
- No OpenCode execution path was added.
- No durable memory or skills store was added.

## Existing Providers And New Adapters

The new Agent OS adapters are parallel metadata and detection objects. They do not send prompts and do not start sessions.

- Claude still runs through `src/main/providers/claude.ts` for chat/meta calls and `src/main/pty.ts` for terminal sessions.
- Codex still runs through `src/main/providers/chatgpt.ts` for chat/meta calls and `src/main/pty.ts` for terminal sessions.
- Ollama still runs through `src/main/providers/local.ts`, `src/main/ollama-connection.ts`, and local executor paths.
- The new adapters only describe those integrations and provide safe detection results for the future Agent Hub.

## OpenCode Later

OpenCode should be added as a true AgentAdapter after its CLI behavior, session model, output format, permission prompts, and file-editing semantics are verified. The placeholder adapter only runs `opencode --version` and clearly reports that OpenCode is not connected to chat, PTY, or loop execution yet.

## Memory And Skills Later

The Memory / Skills adapter represents a future internal layer for project memory, reusable skills, workflow recipes, and automation memory. It does not replace SQLite chat history or conversation summaries in this phase. Future memory should be local, auditable, permissioned, and wired into the Mission Engine deliberately.

## AkorithLoop Relationship

AkorithLoop should remain separate for now. The current Akorith structure already treats AkorithLoop as a workspace/output repository for generated loop projects and automation artifacts. If a headless loop runtime is needed later, it should be extracted deliberately from Akorith's loop core instead of merging the AkorithLoop workspace repository into the app.

## Future Monochrome UI Direction

Akorith is expected to move toward a radical black-and-white identity: mostly black, white, and dark gray, with no colorful provider branding unless absolutely necessary. This phase only adds future token notes. The existing provider colors, logo assets, dashboard colors, loop status colors, and terminal theme are intentionally unchanged.

## Branch Strategy

Phase 28 lives on `feature/phase-28-agent-os-foundation`.

Phase 29 lives on `feature/phase-29-universal-agent-adapter`.

Phase 30 lives on `feature/phase-30-runtime-session-observation`.

Phase 31 lives on `feature/phase-31-runtime-inspector-dashboard-polish`.

Phase 32 lives on `feature/phase-32-mission-engine-skeleton`.

`main` must remain untouched until this branch is reviewed and merged later.

## Phase 29: Universal Agent Adapter Foundation

Phase 29 adds typed Universal Agent Adapter rails behind the Phase 28 registry. The current active runtime is intentionally unchanged.

Universal Agent Adapter means Akorith can describe an agent's metadata, detection behavior, current integration stage, runtime capabilities, and placeholder sessions through one internal shape. It does not mean all live chat, PTY, loop, or test execution has moved to AgentSession yet.

### Added In Phase 29

- `src/main/agents/runtime.ts` defines `AgentRuntimeCapability`.
- `src/main/agents/session.ts` defines `AgentSession`, mode, origin, status, and create-input types.
- `src/main/agents/events.ts` defines `AgentSessionEvent`.
- `src/main/agents/session-manager.ts` adds an in-memory `AgentSessionManager`.
- `src/main/agents/types.ts` now allows optional runtime methods on `AgentAdapter`.
- `src/main/agents/registry.ts` now reports integration stage and runtime capabilities.
- The existing `window.api.agent` namespace now includes read-only session inspection and low-risk placeholder session creation.
- The Settings Agent Hub shows runtime capability summaries, integration stage, and in-memory placeholder sessions.

### What AgentSession Means Now

`AgentSession` is a typed placeholder for future orchestration. In Phase 29 it can be created in memory from the Agent Hub, listed, inspected, and given events. Creating one does not start a process, attach a terminal, call a provider, send a prompt, edit a file, or write to SQLite.

The in-memory manager supports:

- `createPlaceholderSession`
- `listSessions`
- `getSession`
- `updateSessionStatus`
- `appendSessionEvent`
- `listSessionEvents`
- `stopSession`

No session persistence or database migration was added.

### Current Active Runtime

```text
Renderer
  -> existing provider / PTY IPC
  -> src/main/providers/* or src/main/pty.ts
  -> Claude, Codex, Ollama
```

Claude still uses `src/main/providers/claude.ts` for provider calls and `src/main/pty.ts` for Atlantis terminal sessions.

Codex still uses `src/main/providers/chatgpt.ts` for provider calls and `src/main/pty.ts` for Olympus terminal sessions.

Ollama still uses `src/main/providers/local.ts`, `src/main/ollama-connection.ts`, and the existing local executor path.

### New Foundation Runtime

```text
Renderer
  -> agent IPC
  -> AgentRegistry
  -> AgentAdapter metadata, detection, runtime capability metadata
  -> AgentSessionManager placeholder sessions
```

This foundation is intentionally parallel to the active runtime. It is safe to inspect and safe to create placeholder sessions because it has no prompt-sending or process-starting path.

### Future Runtime

```text
Mission Engine
  -> AgentRegistry
  -> AgentSessionManager
  -> AgentAdapter runtime methods
  -> provider, PTY, tool, memory, and review execution
```

The future Mission Engine can use the same registry to pick Claude, Codex, OpenCode, Ollama, or Memory/Skills by capability instead of hardcoding each tool in loop code.

### OpenCode Preparation

OpenCode remains detection-only. Phase 29 gives it runtime capability metadata and placeholder sessions, but no chat execution, PTY integration, loop execution, or file-editing path.

### Memory And Skills Preparation

Memory / Skills remains an internal future adapter. Phase 29 gives it placeholder sessions and capability metadata, but it does not replace conversation summaries, SQLite history, or repo context digests.

### Why Providers Were Not Replaced

The existing providers and PTY manager are working runtime code with important safety and product invariants. Replacing them during this foundation phase would risk regressions in chat, terminals, macro loops, Test Lab, local executor, and workspace loops. Phase 29 only adds typed rails beside them.

## Phase 30: Runtime Session Observation

Phase 30 attaches the Agent OS foundation to the existing runtime as read-only observation. It does not make AgentSession the source of execution. Existing chat sends, PTY lifecycle, Ollama usage, macro loops, workspace loops, and Test Lab execution remain on their current paths.

### Added In Phase 30

- `src/main/agents/observation.ts` defines runtime attachment and snapshot types.
- `src/main/agents/session-manager.ts` can create in-memory observed sessions and attach runtime metadata to them.
- `src/main/providers/registry.ts` wraps existing provider sends with best-effort observation around the unchanged `provider.send(...)` call.
- `src/main/pty.ts` exposes a metadata-only `listSessionSnapshots()` method for live PTY sessions.
- `src/main/agents/registry.ts` exposes read-only runtime snapshot IPC through the existing `agent` namespace.
- `src/preload/index.ts` and `src/preload/index.d.ts` expose `window.api.agent.getRuntimeSnapshot()`, `refreshRuntimeSnapshot()`, and runtime attachment readers.
- `src/renderer/src/components/SettingsCenter.tsx` shows a small Runtime Observation panel in Agent Hub.
- `src/renderer/src/styles.css` styles the new panel without changing the broader UI theme.

### Observation Model

Provider calls are observed in memory only. The observation records structural metadata such as provider id, model id, whether images were present, whether repo digest was enabled, and the associated project path when available. It does not store the user prompt, generated answer text, streamed tokens, images, or secrets.

PTY sessions are observed as metadata snapshots only. The snapshot includes the terminal id, logical terminal, command kind, cwd, project key, timestamps, and inferred agent id for Claude or Codex terminal roles. It does not expose terminal scrollback, command contents, prompts, passwords, or permission prompt text.

Ollama is observed with the same conservative detection path used by the Agent OS adapter. Refreshing the Runtime Observation panel may check local Ollama availability, but it does not start models, send prompts, or mutate Ollama settings.

### Current Active Runtime

```text
Renderer
  -> existing chat/provider IPC
  -> src/main/providers/registry.ts
  -> src/main/providers/claude.ts, chatgpt.ts, local.ts
  -> Claude CLI, Codex CLI, Ollama HTTP API

Renderer
  -> existing PTY IPC / bridgeSend()
  -> src/main/pty.ts
  -> live Claude, Codex, or shell terminals
```

### Phase 30 Observation Path

```text
Existing provider sends and PTY metadata
  -> observation hooks and snapshots
  -> AgentSessionManager in-memory sessions and attachments
  -> agent IPC
  -> Settings Agent Hub Runtime Observation
```

This path is intentionally one-way. It observes active runtime state but cannot send prompts, write to terminals, start sessions, edit files, or commit changes.

### Future Runtime

```text
Mission Engine
  -> AgentRegistry
  -> AgentSessionManager
  -> AgentAdapter runtime methods
  -> provider, PTY, tool, memory, test, review, and commit execution
```

Phase 30 gives the future Mission Engine a safer map of the current runtime before any control surface is added.

### Privacy And Safety Boundaries

- No full prompts are stored in AgentSession metadata.
- No assistant outputs or streamed token contents are stored in AgentSession metadata.
- No terminal output or scrollback is exposed through runtime observation.
- No SQLite migration was added; observed sessions remain process-memory only.
- Observation failures are swallowed so provider sends keep their existing behavior.
- The `bridgeSend()` to `PtyManager.write()` invariant remains unchanged.

## Phase 31: Runtime Inspector And Dashboard Polish

Phase 31 makes the Agent OS visibility layer more useful without adding execution or control paths. Agent Hub becomes a read-only runtime/session inspector, and Dashboard becomes a calmer Agent OS command surface. Existing providers, PTYs, macro/workspace loops, Test Lab behavior, usage accounting, and provider prompt construction remain unchanged.

### Agent Hub Inspector

The Settings Agent Hub now shows clearer cards for each adapter:

- display name, detection status, integration stage, runtime capability summary, and capabilities
- current observed runtime state such as idle, active provider call, active terminal, local runtime available, metadata only, or future memory/skills
- short current and future integration notes for every adapter
- a compact Runtime Observation summary with observed sessions, active provider calls, active PTY sessions, Ollama status, last checked time, and a read-only refresh button

The session inspector expands observed sessions in memory only. It shows safe fields:

- shortened session id
- agent id, mode, origin, and status
- project path when already available
- created, updated, and last activity timestamps
- linked runtime attachment count
- error summary when present

Runtime attachment rows show safe fields only:

- kind, agent id, and status
- shortened external id
- source file label
- project path when already available
- timestamps
- filtered metadata summaries

The metadata summary deliberately filters suspicious key names such as prompt, content, text, output, secret, token, password, env, and command.

### Privacy And Safety

Phase 31 still does not store or display full prompts, assistant outputs, streamed token contents, terminal output, terminal scrollback, secrets, command contents, raw environment variables, or hidden IPC payloads. Runtime sessions and attachments remain process-memory only. No SQLite tables or migrations were added.

No control or execution APIs were added. In particular, Phase 31 does not add `sendMessage`, `execute`, `startRealSession`, `routeToProvider`, `stopRealSession`, `killPty`, `writeToPty`, `rerunProvider`, `startLoop`, or commit buttons.

### Dashboard Polish

Dashboard now reads existing local data once and presents it as a cleaner command surface:

- active workspace/project summary from the current App state
- runtime observation summary from the Phase 30 read-only snapshot
- provider usage totals from existing usage IPC
- recent Test Lab signal from existing test run history
- recent evaluation/report signal from existing evaluation history
- recent loop activity from existing macro loop list
- Agent OS visibility preview with registered adapters, connected existing runtime paths, observed sessions, local runtime status, and recent chat activity

The Dashboard styling moves toward the future black-and-white Agent OS direction with neutral cards, restrained provider indicators, better spacing, clearer headings, and useful empty states. This is not the full monochrome redesign: logo assets, sidebar behavior, provider colors elsewhere, terminal theme, chat UI, Test Lab, and loop pages are intentionally not globally redesigned.

### Current Active Runtime After Phase 31

```text
Existing chat, provider, PTY, macro, workspace loop, and Test Lab execution
  -> unchanged runtime behavior

Existing runtime metadata
  -> read-only Agent OS observation
  -> Settings Agent Hub inspector and Dashboard preview
```

### Phase 31 Handoff

Phase 32 should add a Mission Engine skeleton only:

- `Mission`
- `MissionStep`
- `MissionPlanner`
- `MissionExecutor`
- `MissionReviewer`
- `MissionCommitPolicy`
- read-only UI skeleton

Phase 32 should still avoid execution routing. It should define typed mission shapes and read-only planning surfaces before any adapter starts controlling providers, PTYs, tests, reviews, or commits.

## Phase 32: Mission Engine Skeleton

Phase 32 adds a preview-only Mission Engine foundation for the future Agent OS direction. Akorith can now describe, create, list, and inspect in-memory draft missions and mission steps, but it still does not execute missions through the new engine.

### Added In Phase 32

- `src/main/missions/types.ts` defines `Mission`, `MissionStep`, `MissionEvent`, `MissionPolicy`, template, preview-plan, risk, status, role, and permission-mode types.
- `src/main/missions/policies.ts` defines read-only and manual-only non-executing default policies.
- `src/main/missions/templates.ts` defines preview templates for repository health review, feature implementation loops, test coverage improvement, release prep, documentation improvement, local model benchmark visualization, and autonomous project creation preview.
- `src/main/missions/store.ts` adds an in-memory mission and event store.
- `src/main/missions/engine.ts` adds `createDraftMission`, `listMissions`, `getMission`, `listMissionEvents`, `updateMissionStatus`, `createMissionFromTemplate`, and `createSafePreviewPlan`.
- `src/main/missions/inspector.ts` registers safe mission IPC channels.
- `src/main/index.ts` registers the mission IPC namespace.
- `src/preload/index.ts` and `src/preload/index.d.ts` expose `window.api.mission`.
- `src/renderer/src/components/MissionCenter.tsx` adds a preview-only Mission Center under Settings.
- `src/renderer/src/components/Dashboard.tsx` shows Mission Engine skeleton visibility on Dashboard.
- `src/renderer/src/styles.css` adds scoped Mission Center and Dashboard mission styles.

### Mission Engine Boundaries

Missions and mission events are process-memory only. Restarting the app clears draft missions. Phase 32 adds no SQLite migrations and does not change `loopex.db`.

Default policies are non-executing:

- no provider calls
- no PTY writes
- no file writes
- no tests
- no commits
- no pushes
- no background loops

Mission templates are preview-only. Steps such as execute, test, handoff, review, and commit can be represented in the timeline, but execution-capable steps are marked unsupported until a later phase deliberately adds a permissioned control path.

### Mission Center UI

The Settings Mission Center shows:

- available mission templates
- template details and safe step previews
- "Create preview" and "Blank preview" actions that create in-memory drafts only
- draft mission list
- selected mission detail
- step timeline
- risk, status, permission, role, and preferred-agent badges
- safe mission event metadata
- explicit "Preview only" and safety notes

It intentionally does not show a Run Mission button or any execute, stop, commit, push, test, terminal, or provider-control action.

### Dashboard Visibility

Dashboard now includes a compact Mission Engine skeleton card with:

- template count
- in-memory draft mission count
- preview-only execution state
- recommended next direction

This is still not the full black-and-white redesign. The Dashboard remains monochrome-ready and calm, but logo assets, sidebar behavior, provider colors outside this surface, terminal theme, chat UI, Test Lab, and loop pages are not globally redesigned.

### Relationship To Existing Runtime

Phase 32 does not replace or route through the existing runtime. These paths remain unchanged:

- Claude, Codex, and Ollama providers in `src/main/providers/*`
- provider prompt construction and return values
- token accounting and usage logging
- PTY lifecycle and command kinds in `src/main/pty.ts`
- `bridgeSend()` to `PtyManager.write()`
- macro loop and workspace loop execution in `src/main/macro.ts` and `src/main/workspace.ts`
- Test Lab behavior in `src/main/testlab.ts` and `src/main/testlab-ipc.ts`
- runtime observation and Agent Hub session inspection
- AkorithLoop as a separate repository/product surface

### Future Preparation

The skeleton prepares the future orchestration layer:

```text
Mission
  -> MissionStep timeline
  -> MissionPolicy safety gates
  -> Agent roles: planner, executor, reviewer, tester, committer, memory, observer
  -> Future AgentAdapter sessions for Claude, Codex, OpenCode, Ollama, and Memory / Skills
```

This gives Akorith a typed place for multi-agent planning, planner/executor/reviewer/tester/committer pipelines, OpenCode integration, Hermes-style memory/skills, and the future loop-engine upgrade before any execution routing is introduced.

### Recommended Phase 33

Recommended Phase 33: Mission Engine persistence and read-only history.

That is the safest next step because Phase 32 missions are useful for previewing structure but disappear on restart. A persistence phase can add durable mission history, read-only inspection, and migration planning without routing mission steps to providers, PTYs, Test Lab, macro loops, commits, or pushes yet.

## Phase 33 — UI Command Surface Overhaul

Phase 33 is a UI/UX-first phase that turns Akorith into a serious, black-heavy,
technical Agent-OS command surface (Codex / OpenCode inspired), with no change to
provider runtime, PTY behaviour, macro/workspace loops, Test Lab, token accounting,
usage logging, the `bridgeSend → PtyManager.write` invariant, the `loopex.db` /
`loopex.config.json` filenames, or AkorithLoop. See
`docs/phase-33-ui-command-surface.md` for the full audit and commit plan.

### Monochrome, borderless, sharper direction

- Black-heavy monochrome token palette: near-black window with small surface-tone
  steps for depth instead of borders; provider identity reduced to neutral grays
  (no orange/blue/purple blocks) — provider names survive as text/labels.
- Sharper geometry: smaller radius scale (sm 3 / 5 / lg 8 / xl 10) and a mapped-down
  pass over hardcoded radii (status pills and circles preserved).
- Borderless pass on composer, dashboard cards, model picker, chips, segmented
  controls — surface contrast and type hierarchy carry structure.

### Sidebar: project-first navigation

- Provider folders (Claude / Codex / Local) removed from the sidebar.
- Projects is a section heading; each project is an expandable group revealing its
  chat threads inline (grouped from existing sessions by `projectId` — no migration),
  with per-chat rename/delete and a per-project "New chat". A "Chats" section lists
  general threads and surfaces orphaned chats so no history disappears.
- The sidebar now vanishes/appears (opacity + tiny scale) instead of sliding.

### Multiple chats per project

`SessionRow.projectId` already supported this at the DB layer; Phase 33 exposes it.
`App.startNewProjectChat` keeps the project (and its agents/cwd) active while opening
an empty thread, persisted on first message via the existing `history.create`.

### Composer-integrated model picker

- Provider/model selection moved out of the top bar into a custom dark popover
  listbox (`ModelPicker`) in the composer — provider-grouped, keyboard + mouse
  friendly, source-labelled, opens upward near the composer. No native white
  dropdown on the dark UI.

### Settings as a real page

- `SettingsCenter` is now a full-window page (fixed host + centred max-width column)
  with its existing left-tab navigation, instead of a centred modal card. All
  settings functionality (Profile / Providers / Agents / Missions / Workflow / Test /
  Safety) is preserved.

### Usage chart polish

- Thicker daily-usage bars, a chunkier donut ring, and higher-contrast gridlines and
  axis labels — monochrome, no new chart dependency.

### Remote Ollama auto-connect

- `LocalProviderSettings` additively gains `remoteProfiles[]` (id, name, baseUrl,
  priority, enabled, network hint, last health status/error/model count/timestamps)
  and `lastSuccessfulBaseUrl`, persisted with a strict sanitizer (valid http(s) only,
  capped count, never secrets).
- `ollama:autoConnect` tries configured → last successful → enabled remote profiles by
  priority, picks the first healthy endpoint (read-only `/api/tags`, short timeouts, no
  polling), switches the active endpoint only when the current one is unreachable, and
  records per-profile health. ChatPanel runs it once on launch and labels local-provider
  models with their source (Local / Remote: profile). Settings → Providers gains a
  remote-endpoints editor with Auto-connect, plus the private-route security note
  (Tailscale/VPN/SSH; never public exposure).

### Terminal docking + bottom workbench

- Agent terminals dock three ways (right Drawer / bottom Dock / Focus view) via a header
  switcher; switching modes only changes the container class, so PTYs are never
  remounted.
- A bottom workbench (`BottomWorkbench`) docks under the chat with read-only tabs:
  Changes (a new bounded, read-only `git:status` IPC — branch, file list, `diff --stat`;
  never stages/commits/pushes; path must be a managed project), Runtime (observation
  snapshot counts), and Missions (draft overview). No mission execution, no Run buttons.

### Codex / OpenCode inspirations borrowed

- Composer-integrated model picker, command-palette-style dark listbox, project→chats
  tree sidebar, a bottom workbench with a read-only changes panel, dockable terminals,
  a compact full-page settings view, and stronger monochrome usage graphics.

### Intentionally unchanged

Provider runtime/prompts/returns, token accounting, usage logging, PTY command kinds,
`bridgeSend → PtyManager.write`, macro/workspace loops, Test Lab, Agent Hub/Mission
preview behaviour, `loopex.db`, `loopex.config.json`, and AkorithLoop.

### Recommended Phase 34

Phase 34: Mission Engine persistence and read-only history (still the safest next
backend step — Phase 33 deliberately avoided deeper Mission work). Strong alternatives
once persistence lands: a real OpenCode adapter integration, or deeper bottom-workbench
git features (per-file diff view) building on the read-only `git:status` IPC.

## Phase 34 — UI Refinement · GPU Telemetry · Plugins Foundation

Phase 34 acts on the user's Phase 33 screenshot feedback plus two safe, read-only
system-observation additions. No Mission/provider execution, no backend architecture
changes. Full plan: `docs/phase-34-ui-refinement-gpu-plugins.md`.

### Sidebar + project/chat hierarchy
- Project rows are calmer and Codex-like: no folder icon, no long path subtitle (path
  → hover title), thinner rows, single-line ellipsised names.
- Chat rows under a project show a compact relative age ("3d", "1w") from the existing
  `updatedAt`, dropping the per-row icon; the timestamp yields to hover actions.

### Composer focus
- The visible focus border/ring on the composer is gone; focus shows only as a subtle
  surface lift (no outline, no layout shift). Keyboard affordances elsewhere unchanged.

### Usage Activity card
- Filled the half-empty card: larger heatmap cells, a Less/More legend, and a summary
  stat strip (active days, total sends, total tokens, peak day, last active).

### GPU / Local runtime telemetry (honest, read-only)
- `src/main/gpu-status.ts` + `gpu:getStatus` (`window.api.gpu.getStatus`). NVIDIA
  (Win/Linux) via read-only `nvidia-smi` with a timeout; macOS and unsupported
  platforms return `unavailable` with a clear reason — **never fabricated**. Reports the
  configured Ollama endpoint as Local/Remote; remote GPU telemetry is explicitly noted
  as unavailable via the Ollama API (future: companion/SSH/secured telemetry endpoint).
- Dashboard "GPU / Local runtime" card: per-GPU name, utilization %, VRAM, temperature;
  honest unavailable state; loads on mount + manual Refresh; no polling.

### Plugins foundation
- First-class Plugins view (sidebar nav + route), **static metadata only**: category
  filter, plugin cards (name, category, status, description, permissions preview,
  disabled "Coming soon"). No execution, install, remote code, marketplace, or DB tables.

### Resizable bottom agent dock
- Bottom-dock mode gains a draggable top handle (min 180 / default 360 / max 75vh,
  persisted, double-click reset). Terminals refit via their existing ResizeObserver —
  no remount, no PTY restart. Drawer/Focus modes unchanged.

### Intentionally unchanged
Provider runtime/prompts/returns, token accounting, usage logging, PTY command kinds,
`bridgeSend → PtyManager.write`, macro/workspace loops, Test Lab, Agent Hub / Mission
preview, `loopex.db`, `loopex.config.json`, AkorithLoop. GPU + plugin surfaces are
read-only; no secrets, no hardcoded IPs, no polling, no privileged telemetry.

### Recommended Phase 35
Plugin system architecture (turn the static registry into a real, sandboxed,
permission-gated plugin loader) — it now has a UI to grow into. Strong alternatives:
a Remote GPU Telemetry companion (secured endpoint feeding the new GPU card for remote
machines), Mission Engine persistence/read-only history, or a real OpenCode adapter.

## Phase 35 — Controller API · Real Plugin Foundation · vLLM Studio Gap

Phase 35 adds an **optional** local controller HTTP API, turns the static Plugins page
into a real permission-gated plugin foundation with honest diagnostics, and records a
gap analysis vs. Local Studio (`docs/vllm-studio-gap-analysis.md`). Akorith stays
local-first and provider-API-key-free; the controller is a separate, opt-in surface.

### Controller API (`docs/controller-api.md`)
- `src/main/controller/` — pure, unit-testable Node `http` server factory (no electron/
  config imports) + an electron bootstrap. **Disabled by default, loopback-only,
  token-protected, read-only.** Non-loopback host requires an explicit Allow-LAN toggle;
  never binds `0.0.0.0` implicitly; token never logged.
- Endpoints: `/health` (no auth) + token-gated `/v1/status|agents|runtime|projects|chats
  (summaries)|missions|plugins|gpu|ollama|events (SSE)|docs` and a single safe
  `POST /v1/controller/refresh`. No execution/write endpoints.
- Settings → API tab: enable, host/port, base URL + token (reveal/copy), Allow-LAN +
  warning, start/stop/restart, regenerate token, example curl, endpoint catalogue.
- Verified by `npm run verify:controller` (ephemeral loopback port; auth + read checks).

### Plugin foundation (`docs/plugin-system.md`)
- `src/main/plugins/` — types, permissions, diagnostics (read-only CLI/path checks),
  built-in manifests, and a config-only manager. **No execution runtime.**
- Built-ins: OpenCode Agent, GitHub Workbench, Remote Ollama Telemetry, Hermes Memory,
  Chroma Memory, Browser/Chrome Automation, Test Lab Extensions, Mission Runners,
  Controller API. Live diagnostics via `opencode/gh/ollama --version`, `python3`+`chromadb`,
  and Chrome path detection (no browser data). Chroma: no ingestion/embeddings; Browser:
  detection only.
- Plugins page reads the live registry: status badges, diagnostics, config-only
  enable/disable, per-plugin Check, category filters, sensitive-permission highlighting,
  details with safety notes, and an optional Chroma endpoint placeholder.
- Dashboard gains a Controller-API-and-plugins card.

### vLLM Studio gap
Local Studio (formerly `0xSero/vllm-studio`) is a model-serving control panel; Akorith
adopted its **controller-API backbone, loopback+token security model, SSE stream, and a
diagnostics/doctor concept**, and deliberately skipped the OpenAI-compatible proxy, model
lifecycle, recipes, and remote deploy scripts (different identity).

### Intentionally unchanged
Provider runtime/prompts/returns, token accounting, usage logging,
`bridgeSend → PtyManager.write`, PTY command kinds, macro/workspace loops, Test Lab,
Agent Hub / Mission preview, `loopex.db`, `loopex.config.json`, AkorithLoop. Controller and
plugins are read-only; no secrets exposed, no hardcoded IPs, no privileged telemetry.

### Recommended Phase 36
An Akorith **CLI** that talks to the controller (status/plugins/gpu) — the single most
valuable Local-Studio idea still missing. Alternatives: a secured **remote GPU telemetry
companion**, the sandboxed **plugin execution runtime**, or **Mission persistence**.
