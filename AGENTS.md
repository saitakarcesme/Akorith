# Loopex / Akorith — agent guide

Loopex is the current repository/package name. **Akorith** is the visible product name
introduced in Phase 9.1. It is an Electron + TypeScript + React desktop workspace that orchestrates coding
agents **without any API keys**: the center planning chat talks to the user's own
Claude / ChatGPT subscriptions (via their installed CLIs) or a local Ollama server; the
right execution area hosts two real PTY terminals; the left sidebar holds projects and session
history. Built
with electron-vite, in strict numbered phases — currently through Phase 13 (Codex-quality
light UI + persistent workspace history).

**Phase roadmap:** 1 shell · 2 PTY terminals · 3 provider registry · 4 chat→terminal
bridge · 5 SQLite history + dashboard · 6 macOS fix + suggest-only router + repo digest ·
7 isolated test page · 8 evaluate/ISAScore/PDF · 9 semi-automatic macro-loop ·
9.1 Akorith UI polish + workspace projects · 9.1.1 project-first workspace flow ·
9.1.2 workspace polish + app identity · 9.1.3 app identity + sidebar defaults ·
10 electron-builder packaging + macOS app identity · 11 agentic loop + final product polish ·
12 full product validation · **13 Codex-quality light UI + persistent history** — all done.
Remaining: code signing/notarization + a built Windows installer (config is in place).

## Prerequisites

- **Node.js 22+** and npm (Node 20+ works; developed on 22).
- **Windows 10 1809+** (ConPTY) and **macOS (Apple Silicon)** are both supported as of
  Phase 6 (see the spawn-helper note below). Linux is untested.
- For the chat providers (all optional — the app runs with any subset):
  - `claude` CLI installed and logged in (Claude provider; uses the user's subscription).
  - `codex` CLI installed and logged in (ChatGPT provider; uses the user's ChatGPT login).
  - Ollama running at `http://localhost:11434` with at least one pulled model (Local provider).
- No API keys anywhere, by design.

## Install & run

```powershell
npm install
npm run dev        # electron-vite dev server + Electron window
npm run typecheck  # tsc over main, preload, and renderer
```

Native modules — two different stories, both in `dependencies` (electron-vite's
`externalizeDepsPlugin` keeps them out of the bundle) and both main-process only:

- **node-pty 1.1.0** ships N-API prebuilds that load in Electron without any rebuild.
  Never rebuild it — compiling node-pty from the npm tarball fails (missing winpty git
  metadata, `GetCommitHash.bat`).
- **better-sqlite3** is ABI-specific (not N-API), so `postinstall` runs
  `electron-rebuild -f -o better-sqlite3` — for this module that's a prebuilt-binary
  download for Electron's ABI, not a compile, so clean installs work without VS Build
  Tools. `npm run rebuild` is the same command. The `-o` (only) flag matters: a bare
  rebuild would walk node-pty too and fail.
- **macOS spawn-helper fix (Phase 6).** node-pty's npm tarball ships its prebuilt
  `prebuilds/darwin-*/spawn-helper` companion binary with mode `0644` — no execute bit.
  On macOS node-pty `exec()`s that helper to launch the shell, so without `+x` *every*
  PTY spawn dies with `posix_spawnp failed` and both terminals fail to open. This hits
  every macOS user on a clean install, so `postinstall` chains `node
  scripts/fix-spawn-helper.js`, which on macOS only chmods `+x` each darwin spawn-helper
  it finds (idempotent, defensive about node-pty's layout, never fails the install,
  no-op on Windows/Linux). The shell-resolution logic in `pty.ts` was already
  cross-platform (`$SHELL`/zsh/bash on non-Windows) and was **not** the bug.

**Dev-server caveat:** `electron-vite dev` does NOT hot-rebuild `src/main` or
`src/preload`. After changing anything there, restart the dev server. Renderer code
hot-reloads normally.

## Architecture

- `src/main/` — Electron main process. `pty.ts` owns the PTY sessions (node-pty,
  PowerShell, ids `t1`/`t2`); `providers/` is the chat-provider system.
- `src/preload/` — the only bridge between renderer and main: a frozen, typed
  `window.api` (`pty` + `chat` namespaces) over validated IPC channels.
  contextIsolation and sandbox are ON; nodeIntegration is OFF. Keep it that way.
- `src/renderer/` — React UI. The chat panel renders whatever the provider registry
  reports; it never hardcodes a backend list.

### Provider system (Phase 3)

Every chat backend implements the `Provider` interface in
`src/main/providers/types.ts` (`id`, `label`, `kind`, `isAvailable()`, `listModels()`,
`send()` with streaming `onToken` and a `SendResult` whose `usage` object is a contract
later phases depend on). Providers are equal citizens: no provider file imports another.

The registry (`src/main/providers/registry.ts`) is the single source of truth for which
backends exist. It reads `loopex.config.json` from Electron's userData dir
(`%APPDATA%\letsgetit\loopex.config.json` on Windows), created on first run as:

```json
{
  "providers": {
    "claude":  { "enabled": true },
    "chatgpt": { "enabled": true },
    "local":   { "enabled": true, "baseUrl": "http://localhost:11434" }
  }
}
```

- Disable/remove an entry and the provider disappears from the UI — no code change.
- `models: [...]` overrides a provider's model list.
- An unavailable provider (CLI missing, not logged in, Ollama down) never crashes the
  app; it shows greyed-out in the UI with its reason.
- Config is re-read on every provider-list fetch — the ↻ button in the chat header picks
  up edits without restarting.

### Adding a new provider

1. Implement the `Provider` interface (see `types.ts`; `claude.ts` is the reference).
2. Either add it to the `BUILT_IN` map in `registry.ts` (one line, for in-tree
   providers), **or** drop a compiled `.js` file anywhere on disk exporting
   `createProvider(entry)` (or a default class) and reference it from config with no
   code change at all:

   ```json
   "my-provider": { "enabled": true, "module": "providers/my-provider.js" }
   ```

   Relative `module` paths resolve against the userData dir.
3. Populate `SendResult.usage` honestly: real numbers with `estimated: false` when the
   backend reports them, char-count approximations with `estimated: true` when it
   doesn't. Never fabricate costs.

### How each built-in provider works

- **claude** — `claude -p --output-format stream-json --verbose
  --include-partial-messages`, prompt over stdin; streams `text_delta`s; real token
  counts and `total_cost_usd` from the final `result` event.
- **chatgpt** — `codex exec --skip-git-repo-check --output-last-message <tmpfile>`,
  prompt over stdin; the clean answer is read from the tmpfile; usage is estimated
  (`estimated: true`), cost never fabricated.
- **local** — Ollama HTTP API: `/api/tags` for models, `/api/chat` with `stream: true`;
  real `prompt_eval_count`/`eval_count`, `costUsd: 0`.

### Chat→terminal bridge (Phase 4)

The bridge sends chat-produced text into a terminal with one click — no copy-paste.
**There is exactly one injection path**: `bridgeSend({text, targetTerminalId, autoEnter})`
in `src/main/bridge.ts`, which calls `PtyManager.write()`. Never add a second way to
write programmatically to a PTY. The UI reaches it via the validated `bridge:send` IPC
channel (`window.api.bridge.send`); the Phase 9 macro-loop calls `bridgeSend()` directly
after user approval — design changes must keep it callable headlessly.

Three send modes in the chat panel, all funneling through that one function:

1. **Per code block** — each fenced code block in an assistant message renders with its
   own "→ Terminal" button sending exactly that block's content.
2. **Whole message** — a "→ Terminal" button in the message footer sends the **full
   message text** (deliberate choice: literal and predictable; the per-block buttons
   already cover the code-only case).
3. **Manual selection** — highlighting text in the chat area shows a floating
   "Send selection →" popover that sends just the highlighted text.

**Target terminal**: a single current target (`t1` = **Atlantis**, default, or `t2` =
**Olympus**), shown and changed via the segmented control in the bridge bar at the top
of the chat panel. Every send goes to the current target; it is never re-asked per send.

**Auto-Enter**: the bridge-bar toggle, persisted in `loopex.config.json` as
`"bridge": { "autoEnter": false }` (default OFF). OFF = text lands at the prompt and
waits for the user's own Enter; ON = a trailing `\r` is appended so the CLI executes
immediately. Multi-line text is wrapped in bracketed-paste markers
(`ESC[200~ … ESC[201~`, inner newlines normalized to `\r`) so interactive TUIs
(`claude`, `codex`) accept it as one paste without running lines early; note the plain
PowerShell 5.1 prompt does not support bracketed paste, so multi-line sends are
intended for the interactive CLIs. Dead-target sends return a clear error (surfaced as
a toast), never a silent drop.

### Persistence + dashboard (Phase 5)

SQLite database at `loopex.db` in the userData dir (co-located with
`loopex.config.json`), opened by `src/main/db.ts` (better-sqlite3, WAL,
foreign keys ON). All DB access is main-process; the renderer uses validated IPC only
(`history:*`, `usage:*`, `test:*`, `evaluate:*`). Core history/usage tables:

- `projects(id, name, path nullable, color nullable, icon nullable, created_at, updated_at)` —
  Phase 9.1 workspace folders. Paths are user-provided metadata and are only acted on by an
  explicit user button.
- `sessions(id, provider_id, title, project_id nullable, created_at, updated_at)` — **a session belongs to
  one provider**; switching provider in the chat starts a new session context. Phase 9.1 adds
  nullable `project_id` so new chats can be associated with the selected project without breaking
  old sessions.
- `messages(id, session_id FK CASCADE, role user|assistant, content, provider_id,
  model, created_at)`.
- `usage_events(id, ts, provider_id, model, prompt_tokens, completion_tokens,
  cost_usd, estimated 0/1, session_id nullable FK)` — **exactly one row per assistant
  send**, written from the `SendResult.usage` contract inside the `chat:send` handler
  (the single choke point). Claude/Local write real counts (`estimated=0`); ChatGPT
  writes approximations (`estimated=1`). Indexed on `ts` and `(provider_id, ts)`.
  The Phase 6 router will read `usage_events`.

Phase-specific persistence also lives here:

- `test_runs(...)` — Phase 7 test-lab metrics. Phase 8 adds nullable
  `generated_files` JSON metadata for newly generated tests so reports and judges can
  include the generated code excerpt; old rows remain valid and use the retained sandbox
  path as a best-effort fallback.
- `evaluations(id, ts, kind single|comparison, test_run_ids JSON, judge_model nullable,
  dimension_scores JSON, weights JSON, total_score, rationale nullable, pdf_path nullable)` —
  one row per Evaluate action. `dimension_scores` stores every per-run dimension, the
  formulas used, active/effective weights, optional judge usage, and any judge-failure note.
- `macro_sessions(id, created_at, updated_at, status, goal, planner_provider,
  planner_model, target_terminal, max_iterations, good_enough_threshold, include_repo_digest,
  repo_digest_snapshot, final_score, stop_reason)` — one row per Phase 9 loop.
- `macro_turns(id, session_id FK CASCADE, turn_index, created_at, status, proposal,
  edited_proposal, sent_prompt, executor_result_summary, planner_rationale, expected_result,
  confidence_score, good_enough_score, risk_level, provider_used, model_used, error)` — one row
  per proposed/approved/skipped loop turn.

The sidebar shows the Akorith brand, icon nav, project folders, recent chats, one colored
folder per registry provider (plus orphaned providers that still have sessions), rename/delete/
new-chat, and a local profile/settings entry. Clicking a session restores its conversation into
the chat panel. Sidebar nav switches between **Workspace** (default, 3-pane), **Dashboard**, and
**Test**; the workspace stays mounted
(`display:none`) while the dashboard is open so the terminal PTYs are never disturbed.
The dashboard (recharts + a CSS-grid calendar heatmap) reads only `usage_events`:
activity heatmap, per-day stacked token bars by provider, provider-distribution donut,
and summary cards. Providers with estimated counts render hatched with an "≈" tag.

### Model router — SUGGEST ONLY (Phase 6)

`src/main/router.ts` proposes a provider/model for a prompt's difficulty and warns when
recorded subscription usage is high. It **never switches providers** — the renderer shows
the suggestion and the user Accepts (selectors switch for that send) or Ignores it. Every
send still goes through the unchanged `chat:send` path with the user's own selection.

- **Difficulty tiers** `Asker` / `Albay` / `General` (Soldier / Colonel / General):
  trivial-mechanical / moderate / hard-complex-large.
- **Classifier** runs **on demand** (the "✦ Suggest" button), never per keystroke. It
  calls a **local Ollama** model *directly* (`/api/chat`, `stream:false`, temp 0) — never
  through `chat:send` — so it **writes no `usage_event`** and burns no subscription tokens.
  Model = `router.classifierModel` (default: first installed Ollama model). With no local
  model it falls back to a rule-based heuristic (length/keywords/file-mentions/fences) and
  the suggestion is tagged `heuristic`.
- **tier→provider/model** is config-driven (`router.tierMap`, editable, never hardcoded in
  logic). Default `Asker→local`, `Albay→chatgpt`, `General→claude`. Only available
  providers (per the registry) are suggested; if the mapped one is unavailable the router
  **degrades** to the best available and says why.
- **Limit awareness — WARN ONLY.** It sums `usage_events` over a rolling window
  (`router.warnThresholds`: `windowHours`, `costUsd`, `events`, `tokens`) per provider.
  When a subscription provider is over threshold it shows a non-blocking warning — *"based
  on usage recorded in Akorith, not your official plan limit"* — and for Asker/Albay nudges
  (does not force) toward local. We cannot read official plan limits; this is Akorith's own
  recorded usage only. Fulfils the old `TODO(phase 6)` in `db.ts`/`registry.ts`.

Config keys (defaults filled in by `getRouterSettings()` so pre-Phase-6 config files still
work): `router.classifierModel`, `router.tierMap`, `router.warnThresholds`.

### Repo context digest — opt-in (Phase 6)

`src/main/digest.ts` builds a **bounded** read-only snapshot of the working repo. The chat
has an "Include repo context" toggle (default OFF, persisted in `digest.enabled`). When ON,
`chat:send` prepends the digest to what the **provider** sees — the stored user message and
the `usage_event` stay the clean typed prompt, and a digest failure never blocks the send.

The digest is `git diff --stat` + a capped `git diff` + `git log --oneline -n 10` + a
depth-limited file tree from `git ls-files` (tracked + untracked-not-ignored, so `.gitignore`
is respected). A **hard total cap** (`digest.maxTotalBytes`) governs everything; the heavy
full diff is included only if it fits, else a truncation note replaces it. A non-git dir
yields just a filesystem tree and a clear "not a git repository" note instead of an error.
It is prepended as a delimited `## Repo context` block labelled context, not instructions.
Config: `digest.enabled`, `digest.workingDir` (default the app cwd), `digest.maxDiffBytes`,
`digest.maxTotalBytes`, `digest.treeDepth`. The Phase 9 macro-loop reuses `buildDigest()`
directly when its "Include repo context" option is enabled.

### Macro-loop orchestration — semi-automatic planner/executor loop (Phase 9)

The Workspace chat panel includes a compact **Macro loop** area near the bridge controls.
Phase 9.1 polishes its presentation without changing the safety model. The user enters a
high-level goal, chooses a planner provider/model from the registry, picks target terminal
Atlantis/Olympus (`t1`/`t2` internally), sets max iterations and a
good-enough threshold, and chooses whether to include repo context. The loop is
semi-automatic only: every turn produces one proposed executor prompt, and the user must approve
or edit it before anything is sent to a terminal.

State machine statuses are explicit and persisted:

- `idle`
- `preparing_context`
- `proposing`
- `awaiting_approval`
- `sending`
- `awaiting_executor_result`
- `completed`
- `stopped`
- `error`

`src/main/macro.ts` owns the IPC/state transitions; `src/main/macro-core.ts` is the
Electron-free parser/prompt helper exercised by `scripts/verify-macro-loop.ts`.

**Planner calls are meta calls.** The macro-loop uses `sendMetaPrompt()` from the provider
registry, so proposals use the same provider implementations (Claude CLI, Codex CLI, Ollama, or
external providers) but write no chat messages and no `usage_event`. The dashboard remains
reserved for normal visible planner chat sends. If the selected provider is unavailable or the
call fails, the loop records an actionable error and leaves the persisted session recoverable.

**Planner prompt contract.** Each proposal asks the planner for strict JSON:
`next_prompt`, `rationale`, `expected_result`, `done_score`, `risk_level`, and
`requires_user_approval`. The prompt instructs the planner to produce one paste-ready executor
step, preserve Akorith security invariants, avoid unsafe architecture changes, prefer surgical
edits, and require the executor to report changed files, tests run, failures, and commit status.
If JSON parsing fails, the raw response becomes an editable proposal and is marked with an error
on the turn.

**Repo context reuse.** When enabled, the loop calls the existing `buildDigest()` and stores the
bounded snapshot on `macro_sessions.repo_digest_snapshot`; there is no second repo scanner.
If a Phase 9.1 project with a path is selected, the macro UI can point the existing digest
working directory at that project before creating the loop.

**Approval-gated executor send.** Approving a turn calls `bridgeSend()` in `src/main/bridge.ts`
with the selected terminal and persisted Auto-Enter setting. This preserves the single
programmatic write path: `bridgeSend()` → `PtyManager.write()`. The sent prompt is recorded on
`macro_turns.sent_prompt`.

**Awaiting executor result.** Phase 9 does not parse terminal output. After sending, the loop
enters `awaiting_executor_result` and waits for the user to paste or summarize the executor
report before continuing. The next proposal includes prior proposals, sent prompts, result
summaries, current iteration, and optional repo digest.

Stop conditions:

- Manual Stop aborts an in-flight planner call when possible and marks the session `stopped`.
- Max iterations stops after the user records a result for the last allowed turn.
- Good-enough threshold (`done_score >= good_enough_threshold`) is shown in the UI, but does not
  auto-send. The user can mark complete, continue anyway, or stop.
- Mark complete is available after proposals/results and sets status `completed`.

Known limitations for Phase 9:

- No fully automatic/autopilot mode yet.
- Terminal output is not auto-interpreted; the user pastes or summarizes executor results.
- The router remains suggest-only and is not allowed to auto-switch planner providers.
- Ollama may be absent; Local provider paths degrade through existing availability checks.

### Akorith UI + workspace projects (Phase 9.1)

Phase 9.1 starts the visible rename from **Loopex** to **Akorith**. The app window title,
top-left brand, renderer favicon/logo, terminal/product text, and PDF report branding now say
Akorith. The repository, package name, `loopex.config.json`, `loopex.db`, and native packaging
identifiers remain Phase 10 work.

UI direction: deep neutral gray base, lifted dark panels, muted purple accent, restrained success/
warning/error states, and subtle provider identity colors (Claude = clay, ChatGPT/Codex = muted
blue, Local/Ollama = muted purple). Motion is intentionally fast and small (about 120-220ms), and
the stylesheet respects `prefers-reduced-motion`.

Sidebar changes:

- Collapsible left sidebar, persisted in renderer `localStorage`.
- Icon nav for Workspace / Dashboard / Test.
- Colored provider groups, plus compact collapsed provider indicators.
- Recent chats section backed by existing SQLite sessions.
- Project folders backed by the `projects` table. Creating a new chat while a project is selected
  writes that project id to `sessions.project_id`; old chats remain valid with `NULL`.
- Phase 9.1.1 supersedes the earlier "move terminals to folder" action: selecting/opening a
  project with a valid path now restarts the execution panes in that cwd through the PTY lifecycle
  path instead of sending `cd` into already-running terminals.
- Local profile/settings entry stores a display name in renderer `localStorage`.

Workspace changes:

- User-facing terminal names are **Olympus** (`t2`, top) and **Atlantis** (`t1`, bottom). Internal
  IDs remain stable.
- Terminal headers show live/exited status plus the actual requested/fallback command role
  (`Codex`, `Claude`, or `Shell`) for the current project-first PTY session.
- Terminal vertical split is draggable and persisted.
- The center planning-chat surface stays available while the Macro loop strip is collapsible; the
  right execution column and terminal split are resizable, and xterm panes still use their existing
  resize observers.
- Planner composer and Macro loop presentation are polished, but provider calls, router behavior,
  dashboard usage semantics, and semi-automatic approval gates are unchanged.

Known limitations after Phase 9.1:

- Full package/app identity rename and native `.icns` / `.ico` packaging icons remain Phase 10.
- No fully automatic autopilot yet.
- Terminal output is not parsed automatically.
- Akorith does not auto-answer permission prompts or type `yes`, `1`, or similar into terminals.
- CLI startup reflects the fixed project-first mapping, not terminal-output detection.

### Project-first workspace flow (Phase 9.1.1)

Phase 9.1.1 corrects the day-to-day workspace flow without a broad redesign. The main Workspace
layout is now **Sidebar | center planning chat | right execution terminals**. The center surface
keeps provider/model controls, bridge target controls, the semi-automatic Macro loop, normal chat
messages, and the composer. Collapsing the Macro loop hides only that planning tool strip; normal
chat and the composer remain available.

The right execution column is project-first:

- With no active project folder, it shows an onboarding surface instead of blank anonymous shells.
- **Open Project** uses a main-process Electron folder dialog, validates the selected directory,
  persists/reuses a `projects` row, selects it, and refreshes the sidebar.
- **Create Project** asks for a project name in the renderer, then a parent folder in the main
  process, creates the directory with conservative name validation, persists/selects it, and
  refreshes the sidebar.
- Filesystem work for Open/Create Project is main-process only; the renderer only calls validated
  preload APIs.

Once a project with a valid path is selected, Akorith starts the execution agents through the
existing PTY/session manager:

- **Olympus (`t2`) starts `codex`** in the project cwd.
- **Atlantis (`t1`) starts `claude`** in the project cwd.
- The PTY create path accepts only fixed command kinds (`shell`, `codex`, `claude`) plus a
  validated absolute cwd. This is terminal lifecycle, not a second prompt/write path.
- If `codex` or `claude` is missing from PATH, the pane falls back to a shell in the project folder
  and prints a clear Akorith message instead of crashing.
- Terminal split resizing and the right execution-column width resize remain local renderer layout
  state; xterm panes still fit through their existing resize observers.

Phase 9.1.1 also compacts Recent chats in the sidebar, adds clearer vertical separation between
cards, and adds a subtle composer info row showing selected provider/model, last available usage
from a completed assistant response, repo-context state, and target executor. It does not add
autopilot, terminal-output parsing, or automatic permission prompt approval.

### Workspace polish + app identity (Phase 9.1.2)

Phase 9.1.2 is a focused polish/fix pass after 9.1.1; it does not start packaging.

- **Equal terminal split by default.** The execution column's two panes now divide the available
  height by `flex-grow` (Olympus = `split`, Atlantis = `100 - split`, `flex-basis: 0`) instead of
  percentage `flex-basis`, so Olympus and Atlantis open ~50/50 regardless of the fixed project
  strip + resizer heights. The split still persists to `akorith.terminalSplit` (default 50) and
  drag-resize is unchanged; xterm panes keep fitting through their existing resize observers.
- **Lighter center chat surface.** New theme tokens lift the planning area above the dark base
  while terminals stay darkest, preserving hierarchy and the muted-purple direction (no light
  theme, no neon): `--bg-chat` (#1a1922, the `.chat-panel` surface), `--bg-chat-bubble` (#232230,
  assistant bubbles), `--bg-composer` (#14131b, the composer tray). Background `--bg` (#0b0b10)
  remains the terminal column so the execution area reads darker than the thinking area.
- **Sidebar "All projects" + menu.** The `+` next to *All projects* opens a small popover menu —
  **Open Project** and **Create Project** — instead of the old inline metadata form. Open Project
  reuses the validated main-process `projects:openFolder` dialog; both actions persist/select the
  project and trigger the existing project-first terminal startup via `activeProject`.
- **Create Project modal.** A centered `.modal-overlay` dialog collects a project name and a
  parent folder. The parent is chosen through a new main-process `projects:pickDirectory` dialog
  (validated, returns the path to display); **Create Project** then calls the extended
  `projects:createFolder` with that `parentPath` (the picker is skipped when a parent is supplied).
  Name validation (`SAFE_PROJECT_DIR_NAME`, no traversal/reserved chars) and main-process-only
  filesystem work are unchanged; the renderer never touches the filesystem directly. On success
  the project is created, persisted, activated, and Olympus/Atlantis start as Codex/Claude in it.
- **Akorith app identity (dev/runtime).** `app.setName('Akorith')`, BrowserWindow `title: 'Akorith'`
  (already set), and a raster logo `assets/akorith-logo.png` used for the BrowserWindow `icon` and
  the macOS dock via `app.dock.setIcon(nativeImage…)` (SVG can't be a nativeImage, so the PNG is
  required for the dock). `resolveAppIcon()` prefers the PNG, falling back to `akorith-icon.svg`.
  Native `.icns`/`.ico` bundle identity and `package.json` `name`/`productName` remain Phase 10.
- **Layout preserved.** Sidebar | center planning chat | right execution terminals is unchanged;
  Olympus = Codex, Atlantis = Claude; collapsing the Macro loop still leaves chat + composer
  visible. No second PTY write path, no autopilot, no auto-approval of permission prompts.

### App identity + sidebar defaults (Phase 9.1.3)

Phase 9.1.3 is a focused follow-up after 9.1.2; still no packaging.

- **App identity — what's fixed in dev/runtime.** `package.json` now carries `name: "akorith"`,
  `productName: "Akorith"`, and an Akorith `description` (the only `letsgetit` string is gone;
  `name` is not self-imported anywhere, so the build/imports are unaffected — userData is pinned by
  `app.setName('Akorith')`, not the package name). The main process keeps `app.setName('Akorith')`,
  adds `app.setAboutPanelOptions({ applicationName: 'Akorith', … })`, sets the BrowserWindow
  `title: 'Akorith'`, and applies the raster dock icon. Result: the window title, the **About
  Akorith / Hide Akorith / Quit Akorith** menu roles, the About panel, and the dock *icon* all say
  Akorith.
- **App identity — the documented limitation.** Running in **dev** (`npm run dev` launches
  `node_modules/.../Electron.app`), the macOS **menu-bar bold app name** and the **dock tooltip**
  are read from that bundle's `Info.plist` (`CFBundleName` = "Electron") and **cannot be changed at
  runtime** by `app.setName` or any JS API. Overriding those two specific labels requires a
  **packaged build** whose own `Info.plist` carries `CFBundleName`/`CFBundleDisplayName` = Akorith
  (electron-builder `productName`) — that is **Phase 10**. This is the only place "Electron" can
  still appear, and only in dev.
- **Provider folders default collapsed.** The sidebar's Claude / ChatGPT / Local (Ollama) provider
  groups now default to collapsed for a cleaner first load. State is per-provider and persists in
  `localStorage` under `akorith.providerCollapsed` (a provider absent from the map reads as
  collapsed); clicking a group header expands/collapses it. The colored group cards stay visible
  when collapsed; Recent chats and project folders are unchanged.
- **Profile/settings gear icon.** `SettingsIcon` was a tangled hand-drawn path that rendered broken
  at 16px; it's replaced with a clean standard stroked gear (circle + cog outline). The profile
  button also pins both its icons with `flex: 0 0 auto` so the gear stays correctly sized, centered,
  and right-aligned in both expanded and collapsed sidebar states.
- **No regressions.** Equal Olympus/Atlantis split, lighter center chat, All-projects Open/Create
  menu + Create Project modal, project activation starting Olympus=Codex / Atlantis=Claude, the
  right execution column, chat-visible-on-macro-collapse, semi-automatic macro-loop, and the
  Dashboard/Test routes are all preserved.

### Agentic loop + product polish (Phase 11)

Phase 11 adds an optional **Auto Mode** to the macro-loop and polishes the UI, without
changing any invariant: the single write path, meta-call/no-`usage_event` accounting, and
the manual Approval flow all stand.

**Product polish.**
- *Sidebar logo* renders via an inline `<AkorithMark>` SVG (in `icons.tsx`), not
  `<img src="/akorith-icon.svg">` — an absolute `/` asset path resolves under the dev server
  but against filesystem root under `file://`, which is why the packaged logo was a broken
  box. The favicon in `index.html` is now `./akorith-icon.svg` (relative).
- *Terminal split* root-cause fix: `storageNumber` returned `Number(null)=0` when the key was
  missing, opening the split at 0/100. It now returns the fallback for missing/empty, and the
  split is clamped/`sanitizeSplit`'d to 30–70 (stale/invalid → even 50/50).
- *Theme*: lighter center chat (`--bg-chat` #201f29), light **borderless** chat bubbles
  (`--bubble-user`/`--bubble-assistant`, dark text, larger radius; dark code blocks restore
  light text inside them), a soft translucent **glass sidebar** (`--bg-sidebar` rgba +
  `backdrop-filter`, solid `@supports` fallback), and slightly larger global radii
  (`--radius-*` + a one-step bump of existing radii).

**agentic-core.ts (electron-free, headlessly verified).** Pure functions only — no terminal,
DB, or provider access — so `scripts/verify-agentic-loop.ts` exercises them directly:
- `stripAnsi` / `boundSnapshot` — clean + bound a terminal snapshot (last N lines / chars).
- `detectPermissionPrompt(snapshot)` → `{ detected, kind, suggestedAction, riskLevel,
  rationale, requiresUserReview }`. Conservative: numbered menus pick the **one-time** "Yes"
  (never an "always allow"), destructive context (`rm -rf`, `sudo`, `--force`, …) forces
  `high` risk and no auto-answer, access/permission requests always require review.
- `buildSummarizerPrompt` / `parseSummaryJson` / `heuristicSummary` — executor-result summary
  with a deterministic fallback when the model call fails or returns unusable JSON. Output:
  `changedFiles, commandsRun, testsRun, failures, currentStatus, likelyNextStep, confidence,
  needsUserAttention, source`.
- `decidePermissionPolicy({mode, detection, confidence})` → `auto_send | pause_for_user |
  ignore`. Approval Mode **never** auto-answers; Auto Mode auto-sends only low-risk, one-time,
  high-confidence (≥0.6) confirmations.
- `evaluateAutoOutcome(...)` → `continue | complete | stop | pause` (max iterations, good-enough
  threshold, repeated failures, needs-attention, low confidence).

**Terminal snapshot API (read-only).** `PtyManager` keeps a bounded ring buffer per session
(`MAX_BUFFER_CHARS = 120k`, sliced on each `onData`). `ptyManager.snapshot(id, maxChars)` and
the `pty:snapshot` IPC / `window.api.pty.snapshot` return the raw tail only — **no write, no
exec, no filesystem**. This is the input to the summarizer/detector; it is not a second write
path.

**Orchestration (`macro.ts`).** New session field `mode` (`approval` default | `auto`).
- `summarizeTurn` reads the snapshot, calls the planner provider via `sendMetaPrompt` (a meta
  call → **no `usage_event`**) with a `heuristicSummary` fallback, and persists the summary +
  `summarizer_confidence` + `permission_detection` + `terminal_snapshot_meta` + `result_status`.
- `respondPermission` sends a short one-time token (`"1"`, `"y"`, Enter) through `bridgeSend`
  — the **same single write path**, never arbitrary commands.
- `runAutoLoop` (abortable via `activeLoops`; Stop wins at every await): propose → auto-send
  proposal (bridge) → `waitForOutput` (bounded poll, never spins) → summarize → permission
  policy (auto-answer low-risk one-time, else pause) → `evaluateAutoOutcome`. Planner `high`
  risk pauses. Every automatic action is appended to the session's `auto_actions` audit log.
- The renderer polls `macro:get` (~1.5s) while a loop is active; it does not drive the loop.

**Persistence (additive, safe `ensureColumn` migrations).** `macro_sessions`: `mode`,
`auto_actions` (JSON), `pause_reason`. `macro_turns`: `summarizer_confidence`,
`permission_detection` (JSON), `terminal_snapshot_meta` (JSON), `auto_action`, `result_status`.
Verified present in the packaged app's DB schema.

**Safety summary.** Default is Approval Mode (unchanged Phase 9 flow). Auto Mode is opt-in with
a visible note, never auto-selects "always allow", never auto-answers medium/high-risk or
low-confidence prompts, pauses on failures/attention, and Stop always aborts. Planner +
summarizer are meta calls and never touch the dashboard.

### Codex-quality light UI + persistent history (Phase 13)

Phase 13 is a product-feel phase: a light/neutral "developer workbench" look and workspace
continuity. No functional invariant changed — same IPC, same single write path, same safety.

**Theme token architecture (the whole change is token-first).** `:root` now defines a *light*
neutral system: workspace base `--bg` #f4f4f3, panels `--bg-panel` #fff, center chat
`--bg-chat` #fafafa, dark-neutral text, a restrained muted-indigo accent (`--accent` #6257c9),
black-alpha `--border-soft`, and `--hover`/`--hover-strong`/`--on-accent` tokens. Two areas keep
their own **scoped dark token overrides** so they stay dark on the light app:
`.terminal-column` (the whole right execution subtree — headers, chips, onboarding) and
`.chat-code` / `.test-terminal-col` (dark code/terminal surfaces carry light text). xterm content
is themed in JS, independent of CSS. The old lavender `rgba(169,150,255,…)` accent was unified to
the new indigo `rgba(98,87,201,…)` everywhere (focus rings, tints, selection).

**Light/white sidebar.** `.sidebar` gets its own token scope (`--sidebar-*`): white background,
dark text, gray icons, a hairline border, calm black-alpha hovers, and a subtle indigo
active state. Provider colors survive only as small chips/tints, not loud blocks. A polished
empty state (no projects) shows Open Project / Create Project CTAs reusing the existing flow.

**Persistent workspace history (Part A).** On launch, `App.tsx` restores the last active project
from `localStorage` `akorith.lastActiveProjectId` (looks it up in `projects.list()`), so the app
resumes previous work instead of opening empty. Restoring re-starts that project's Codex/Claude
terminals **only** through the existing safe PTY startup (a logged-in CLI launch in the project
cwd — never a destructive command) and the panes show visible live/exited status, so the resume
is never hidden. `akorith.lastActiveSessionId` is also persisted; recent chats stay one click to
resume. Sidebar collapse, provider-folder collapse (default collapsed), terminal split (clamped
30–70, null-safe), and display name were already persisted in earlier phases. Projects and recent
chats are listed recency-first from SQLite.

**Other surfaces.** Light chat bubbles (white assistant card with a hairline border; faint-tint
user bubble); a filled-accent primary Send button; the BrowserWindow `backgroundColor` is now
light (`#f4f4f3`) to avoid a dark first-paint flash. Radius system tightened to a consistent
8/11/14/18. Motion still respects `prefers-reduced-motion`.

**Manual UI inspection (REAL).** The packaged app was launched and screenshotted
(`docs/validation/phase13-ui.png`): white sidebar with logo/nav/empty-state/recent-chats/profile,
light planning chat with macro-loop Approval/Auto toggle and filled Send, dark right execution
column. Menu bar shows "Akorith". Reads as a calm, intentional developer product.

### Packaging — electron-builder + macOS app identity (Phase 10)

Phase 10 turns Akorith from a dev Electron app into a packaged desktop app, macOS first.
Nothing in the runtime architecture or security model changed — packaging is config + assets.

**electron-builder.** `electron-builder` 25.x is a devDependency; config lives in the
`build` field of `package.json`. Scripts: `pack` / `pack:mac` (`electron-builder --dir`,
fast unpacked `.app`), `dist` / `dist:mac` (installers: macOS `dmg` + `zip`), `dist:win`
(NSIS config, build on Windows). Each script runs `npm run build` (electron-vite) first, so
`out/{main,preload,renderer}` exists before packaging. `npm run dev` / `build` / `typecheck`
are unchanged.

**Identity.** `package.json` carries `name: "akorith"`, `productName: "Akorith"`,
`description`, `author`. `build.appId = com.akorith.app`, `build.productName = Akorith`. The
packaged macOS bundle's `Info.plist` therefore has `CFBundleName` / `CFBundleDisplayName` =
**Akorith** and `CFBundleIdentifier = com.akorith.app` — so the packaged app shows **Akorith**
in the **menu bar, Dock tooltip, Finder, and window title**, which the dev Electron bundle
could not. Runtime identity (`app.setName('Akorith')`, `app.setAboutPanelOptions`, window
`title`, dock icon via `nativeImage`) is still applied and is now consistent with the bundle.

**Icons.** Source is `assets/akorith-logo.png` (1254²). Generated platform icons live in
`build/` (electron-builder's `buildResources` dir): `build/icon.icns` (macOS, via macOS
`sips` → `.iconset` → `iconutil`), `build/icon.ico` (Windows, a valid 256² PNG-backed ICO —
no ImageMagick on the build box, so a single-size ICO was written directly; regenerate
multi-size with `icon-gen`/ImageMagick when convenient), and `build/icon.png` (1024², Linux
/ fallback). `mac.icon` / `win.icon` / `linux.icon` point at these. The packaged `.app` uses
`icon.icns` (Akorith), not the Electron icon.

**Native modules (the load-bearing packaging detail).**
- `build.npmRebuild = false` — **critical.** electron-builder's default rebuild runs
  `@electron/rebuild` over *all* native deps, which would try to compile node-pty from the
  tarball and fail (missing winpty git metadata). We disable it; `postinstall` has already
  rebuilt better-sqlite3 for Electron's ABI (`electron-rebuild -f -o better-sqlite3`) and
  node-pty uses its N-API prebuilds as-is. The build log confirms
  `skipped dependencies rebuild reason=npmRebuild is set to false`.
- `build.asarUnpack = ['**/node_modules/node-pty/**', '**/node_modules/better-sqlite3/**']`
  so the `.node` binaries and node-pty's `darwin-*/spawn-helper` live on disk under
  `Contents/Resources/app.asar.unpacked/...` (verified: `better_sqlite3.node`,
  `darwin-arm64/pty.node`, and `spawn-helper` present with mode `-rwxr-xr-x` — the
  `fix-spawn-helper` postinstall +x is preserved into the bundle).
- `build.files = ['out/**/*', 'assets/**/*', 'package.json']`; electron-builder adds the
  production `node_modules` automatically. `assets/**` is included so `resolveAppIcon()` /
  the dock icon can read `assets/akorith-logo.png` from inside the asar at runtime.

**Packaged-app PATH (macOS GUI launch).** A Finder/Dock-launched app inherits a minimal
`PATH`, so `claude`/`codex`/`ollama` in Homebrew or a user bin dir would be invisible —
terminals would always fall back to a shell and providers would read unavailable. `main/
index.ts` `ensureCliPath()` (run first in `whenReady`) **prepends** the well-known install
dirs that exist (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin`,
`~/.bun/bin`, `~/.cargo/bin`, the standard system dirs, …) to `process.env.PATH`. No shell is
spawned and nothing is eval'd — just static dirs. The existing PATH-based resolution in
`pty.ts` (`resolveExecutable`) and the providers then works in a packaged build; a still-
missing CLI degrades exactly as before (shell fallback + clear message; provider unavailable).

**Smoke test (this build).** `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack:mac` produced
`dist/mac-arm64/Akorith.app` (ad-hoc/linker-signed arm64, so it launches locally). Verified:
bundle `Info.plist` name = Akorith / id = com.akorith.app / icon = icon.icns; app launches
(main + renderer helper processes alive); `~/Library/Application Support/Akorith/loopex.db` is
created on startup — i.e. **better-sqlite3 loads in the packaged context** (initDb runs every
launch and would crash on a load failure); node-pty + spawn-helper unpacked and executable.
GUI interaction (Open/Create Project, terminals, macro-loop) uses the unchanged dev code
paths and the PATH fix above.

**Known packaging limitations / how to continue.**
- **Not code-signed/notarized.** The build is ad-hoc signed (runs on the build machine);
  distributing to other Macs will hit Gatekeeper. Next: an Apple Developer ID + electron-
  builder `mac.notarize` / `afterSign` notarization.
- **Windows `.exe` not built here** (config is in place; build on Windows with `dist:win`).
  Regenerate a multi-resolution `build/icon.ico` there if the single-size ICO looks coarse.
- **`dist/` is git-ignored** — packaged artifacts are attached to GitHub Releases, not committed.
- **userData dir is now `…/Akorith/`** (driven by `app.setName`), holding `loopex.db` /
  `loopex.config.json`. The DB/config *filenames* still say `loopex` — harmless, optional
  rename later. The internal repo/package history name remains "Loopex/loopex".

### Test page — isolated local-model test lab (Phase 7)

A **separate route** (sidebar nav: Workspace / Dashboard / **Test**; Workspace stays default).
Simple layout: one chat (left) + one read-only output terminal (right). A local model writes
tests for code in a repo the user picks, the tests run automatically in a **safe isolated
sandbox**, and objective metrics are collected. Comparing how well local models write tests is
a first-class use. Phase 7 ends at "tests ran, here are the metrics," persisted for Phase 8.

- **Frameworks**: Python (`pytest`) and JS/TS (`jest`/`vitest`, or the package.json `test`
  script). Auto-detected from the repo (pyproject/pytest.ini/requirements → pytest;
  vitest/jest dep or `test` script → that runner). The user can override the runner/command;
  if nothing is detected they must supply the test command.
- **Source = read-only, execution = ephemeral sandbox (the safety contract).** The source
  repo is **never written to** from this page. Each run creates a fresh dir under
  `os.tmpdir()/loopex-testlab/<runId>` and **snapshots** the source in (git repos: copy the
  `git ls-files` + untracked-not-ignored set — current working state, `.gitignore` respected,
  heavy dirs excluded; non-git: recursive copy minus a denylist). Generated tests + auto-run
  all happen in the sandbox.
- **Execution = a bounded child process** (not a PTY), cwd = sandbox, with a configurable
  **timeout** and a whole-**process-tree kill** (detached process group → `kill(-pid)` on
  POSIX, `taskkill /T /F` on Windows). A manual **Stop** aborts a run the same way. Generated
  file paths are confined to the sandbox (no absolute/`..`). Sandboxes are pruned to
  `keepLastN`. **Residual risk:** generated code runs automatically — isolation (temp dir +
  timeout + no-write-to-source + tree-kill) is what makes that acceptable; **network is not
  sandboxed**, and nothing runs as admin/sudo.
- **Dependencies**: configurable `installDeps` (default ON when a lockfile is present) runs
  e.g. `npm ci` / `pip install -r` in the sandbox first; an install failure is its own
  `install-failed` status, never reported as a misleading test failure.
- **Metrics per run**: framework, pass/fail/error counts, total + per-test duration, exit
  code, tokens used to generate (from `SendResult.usage`), model, attempts, sandbox path,
  capped raw output. The test-page chat omits `sessionId`, so it writes **no `usage_event`**
  (no dashboard pollution); tokens come from the send result.
- **Multi-model comparison** (a mode, not the default): the same task runs against several
  selected models in turn, each in its own fresh sandbox, metrics shown side by side.
- **Persistence**: every run is written to the `test_runs` table (`id, ts, source_repo,
  target_desc, provider_id, model, framework, passed, failed, errored, duration_ms, exit_code,
  tokens, attempts, sandbox_path, raw_output [capped], status`) so runs survive restart.
  Phase 8 reads `test_runs` and writes ISAScore/PDF results to `evaluations`; the Test page still
  does not score while tests are being generated/run.
- **Code layout**: `src/main/testlab.ts` is the electron-free safety core (detect / snapshot /
  bounded run / parse / prune — headlessly verifiable); `src/main/testlab-ipc.ts` is the
  electron wiring (sandbox lifecycle, streaming, persistence). Config: `test.sourceRepo`
  (defaults to `digest.workingDir`), `test.installDeps`, `test.timeoutMs`, `test.keepLastN`,
  `test.defaultProviderId`.

### Evaluate + PDF — ISAScore reports (Phase 8)

The Test page now evaluates existing `test_runs`; it **never re-runs tests** and does not change
the Phase 7 sandbox safety model. "Evaluate" can target one finished run or a selected comparison
set. The main process owns scoring, optional judging, persistence, PDF generation, and OS reveal/open
actions via the frozen `window.api.evaluate` bridge.

**ISAScore is dimensional.** Each evaluation stores the full breakdown, not just the total:

- **TESTS** (objective, dominant): parsed from `test_runs` as
  `passed / (passed + failed + errored) * 100`; `install-failed`, `timeout`, `aborted`, and
  `no-tests` score 0 even if other fields are missing.
- **SPEED** (objective): normalized within the selected evaluation set as
  `fastest selected duration / this duration * 100`; missing/zero duration is omitted.
- **TOKEN EFFICIENCY** (objective): normalized within the selected set as
  `lowest selected token count / this token count * 100`; missing/zero token counts are omitted.
- **QUALITY** (optional): the only LLM-scored dimension. It is omitted when the user skips the LLM
  step or the judge returns invalid/unusable JSON. When any dimension is omitted, the weighted
  total re-normalizes over the remaining active dimensions, so objective-only scoring is fully
  meaningful with zero LLM calls.

Weights live in `loopex.config.json` under `isascore.weights` and default to
`tests=0.55`, `speed=0.15`, `tokens=0.15`, `quality=0.15`. `src/main/config.ts` merges defaults
so old config files still work.

**Optional quality judge.** The user selects a chat-capable registry provider/model for each
evaluation (Claude, ChatGPT, Local, or any external chat provider). The judge prompt includes
generated test code when available plus objective run metrics and asks for strict JSON:
per-run `qualityScore` 0–100 and a short rationale covering coverage intent, readability,
assertion correctness, and idiomatic framework use. `src/main/evaluate.ts` parses defensively;
on failure it records the failure note, omits Quality, and keeps the objective score. Judge calls
use `sendMetaPrompt()` in `providers/registry.ts`: they write no messages, no `usage_event`, and
do not include repo digest. Judge usage may be recorded inside the evaluation JSON for transparency,
and `judge_model` is stored/displayed so scores from different judges are not silently compared.

**PDF reports.** `pdfkit` is the only report renderer (pure JS dependency, main process only).
PDFs are written under `app.getPath('userData')/reports` and can be opened/revealed through
validated `evaluate:*` IPC. A single reusable template covers both modes:

- **Single**: project/source/target/date, objective metrics, dimensional ISAScore breakdown,
  weighted total, judge label (`objective-only` when skipped), LLM rationale when present, and
  generated test code excerpt.
- **Comparison**: same template/branding with a ranked side-by-side table
  (model, pass rate, duration, tokens, each dimension, total), judge label, rationale, and
  generated-test excerpts.

`test_runs.generated_files` is nullable metadata added in Phase 8 for new runs. Older rows remain
valid; evaluation falls back to scanning the retained sandbox for generated test-like files and
otherwise reports that the generated code excerpt is unavailable.

## Conventions

- Surgical edits; keep the security posture intact (CSP, sandbox, frozen bridge).
- Mark future integration points with `// TODO(phase N):` comments.
- Prompts and other untrusted text go to CLIs via **stdin**, never argv.
- **At the end of EVERY phase, update BOTH `AGENTS.md` and `codex.md`** (flip the phase
  checklist, record the new state) and commit + push to `origin main`.
