# Loopex / Akorith — agent guide

Loopex is the current repository/package name. **Akorith** is the visible product name
introduced in Phase 9.1. It is an Electron + TypeScript + React desktop workspace that orchestrates coding
agents **without any API keys**: the center planning chat talks to the user's own
Claude / ChatGPT subscriptions (via their installed CLIs) or a local Ollama server; the
Activity drawer hosts two real per-project PTY terminals; the left sidebar holds projects,
provider folders, and session history. Built
with electron-vite, in strict numbered phases — currently through Phase 26 (Settings Center:
detailed profile/provider/workflow/Test Lab controls).

**Phase roadmap:** 1 shell · 2 PTY terminals · 3 provider registry · 4 chat→terminal
bridge · 5 SQLite history + dashboard · 6 macOS fix + suggest-only router + repo digest ·
7 isolated test page · 8 evaluate/ISAScore/PDF · 9 semi-automatic macro-loop ·
9.1 Akorith UI polish + workspace projects · 9.1.1 project-first workspace flow ·
9.1.2 workspace polish + app identity · 9.1.3 app identity + sidebar defaults ·
10 electron-builder packaging + macOS app identity · 11 agentic loop + final product polish ·
12 full product validation · 13 Codex-quality light UI + persistent history ·
13.1 chat-first Codex-style workspace ·
13.2 chat workflow polish + agent output feedback ·
13.3 per-project agent sessions + test-lab presets ·
14 project/chat separation + activity drawer fixes · 15 theme toggle ·
15.1 local-provider/workspace-context reliability polish ·
23 general-purpose task loops · 23.1 Fully Active/Passive Loop Switch ·
23.2 Loop Operations Center ·
24 Loop Completion ·
25 Test Lab Rebuild ·
**26 Settings Center** — all done.
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
  threshold, repeated failures, needs-attention, low confidence). **Phase 19:** accepts an
  optional `critic` — when present its measured `progressScore` replaces the planner's predicted
  `doneScore`, a `regressed` verdict or `escalate` recommendation pauses, and a critic-confirmed
  goal completes the loop. Legacy (no-critic) behavior is unchanged.
- **Phase 19 critic/verifier** (`buildCriticPrompt` / `parseCriticReview` / `heuristicCritic` /
  `renderCriticText`): grades the *actual* result against the goal → `{ progressScore 0..100,
  verdict advanced|stalled|regressed|complete, goalMet, gaps[], recommendation
  continue|refine|done|escalate, rationale, confidence, source }`. Deterministic heuristic
  fallback (derives a grade from the summary + prior scores, detecting regression). Unit-checked
  by `scripts/verify-critic-loop.ts`. This closes the loop: plan → act → summarize → **grade** →
  re-plan, with the latest gaps fed into the next `buildPlannerPrompt`.

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
  policy (auto-answer low-risk one-time, else pause) → **`criticTurn` (Phase 19, grades the real
  result, meta call + heuristic fallback)** → `evaluateAutoOutcome` (fed the critic). Planner
  `high` risk pauses. Every automatic action is appended to the session's `auto_actions` audit
  log. `criticTurn` also runs in approval mode's `summarize` so users see the measured grade.
- The renderer polls `macro:get` (~1.5s) while a loop is active; it does not drive the loop.

**Phase 20 — autonomous workspace loop (loop-commit projects), `workspace.ts`.** Turns the loop
into a "scaffold a project → build it → commit every change as `Phase N: <change>` → stop on
budget" pipeline. `workspace.ts` is self-contained (only node builtins; git runs `shell:false`
with the commit message via `-F -` over stdin, so a headline can never reach a shell) and is
headlessly verified by `scripts/verify-workspace-loop.ts` (drives real git in a temp repo):
- Pure: `parseHighestPhase` / `buildPhaseCommitMessage` / `deriveHeadline` / `slugify` /
  `buildIdeaPrompt` / `parseProjectIdea`.
- Git IO: `initWorkspace` (mkdir + `git init` + README + "Phase 0: scaffold project"),
  `nextPhaseNumber` (highest `Phase N` in the log + 1, so numbering survives restarts),
  `commitPhase` (stage-all → no-op if nothing changed → commit "Phase N: <headline>").
- `workspace:createProject` IPC (`window.api.macro.createWorkspaceProject`): generates an
  everyday-dev idea (meta call + deterministic fallback), scaffolds a unique dir under
  `~/Documents/Akorith Projects`, `git init`s it, and binds an **auto-mode + auto-commit** macro
  session. It does NOT start the loop itself.
- **One-click (Phase 20.1)**: ran the whole create→open→start sequence from a single button.
  Superseded by the dedicated Loop section in Phase 21.
- **Loop section (Phase 21, `LoopsPage.tsx`).** The autonomous loop is now a first-class
  top-level view (`AppView 'loops'`, sidebar "Loop" item), **removed from above the chatbox**
  (the old `MacroLoopPanel` is deleted). Deliberately non-technical: a card grid of existing
  loops + a "＋" card; the create flow is a single short description ("a sentence or two"),
  persisted as `macro_sessions.title` and shown on the card. Creating a loop auto-picks the first
  available provider, calls `createWorkspaceProject`, starts a **headless** executor terminal in
  the workspace cwd (`pty.setActiveProject(projectKey)` + `pty.create('t1::<key>', {cwd,
  commandKind:'claude'})` — no visible terminal UI), then `macro:startAuto`. The detail page shows
  a live timer, the saved changes (auto-commit log → "Phase N: …"), and Pause/Resume — all
  framed in plain language; the macro/critic/token machinery stays hidden.
- **Fully automatic + steering (Phase 22).** The loop never dead-pauses waiting on the user.
  `evaluateAutoOutcome` returns only continue / complete / stop (no `pause`): soft signals
  (needs-attention, low confidence, a one-off critic regression/escalation) keep it going — the
  critic's gaps steer the next plan — and it ends only on goal-met (complete), the iteration cap,
  or `MAX_AUTO_FAILURES` consecutive failures (stop). A high planner-risk label no longer pauses
  (destructive shell ops are still gated by the permission detector). Each plan also returns
  `next_options` (3 short plain-language directions, persisted on `macro_turns.next_options`); the
  Loop detail page shows the current activity + those as steer chips. Picking one calls
  `macro:steer` → `macro_sessions.pending_steering`, which the next `propose()` folds into the
  planner prompt and clears. No pick = it continues on the default. The detail page also shows
  Stop (reject) and a Resume only for the rare system pause.
- **General-purpose tasks (Phase 23).** Loops are no longer only project generation — the user's
  prompt IS the goal (research, monitoring, building, …). `createWorkspaceProject` uses the prompt
  verbatim as the goal (idea-generation is only an empty-prompt fallback) and still scaffolds a
  git working folder for an artifact/findings history. `buildPlannerPrompt` was rewritten to be
  task-agnostic and tool-aware: it tells the agent it has web search/fetch, a shell, and file I/O,
  and to keep a single results file (e.g. FINDINGS.md) updated each step — for monitoring goals,
  to track seen items and report only what's new. The Loop detail page shows a detailed **Steps**
  timeline (each step's plan + what happened + critic score) alongside the saved-changes commits.
  NOTE: "computer use" depends on what tools the executor CLI actually exposes — Akorith passes
  the instruction through, so web/shell/files work today; native screen-control needs the agent to
  have such a tool. Recurring cadence loops are supported while Akorith is running: each turn is one
  cycle, then `runAutoLoop` waits for the configured cadence before planning the next cycle.
- **Phase 23.1: Fully Active/Passive Loop Switch.** The Loop section has a **Fully loop**
  Active/Passive control on create and detail. Active creates/keeps a loop in Auto Mode and starts
  or resumes it without another click. Passive stores the session in Approval/passive mode and
  aborts Akorith's auto driver, leaving the loop idle until the user manually resumes or switches
  it back to Active. If a prompt was already sent to the executor terminal, that terminal command
  may finish, but Akorith will not plan or send the next cycle while Passive.
- **Phase 23.2: Loop Operations Center.** The Loop section is now the product home for
  autonomous workflows: project improvement, feature loops, GitHub/repo analysis, monitoring,
  research, maintenance, and project creation. `LoopsPage.tsx` has a dashboard (Active / Needs
  attention / Completed / Failed / Commits), template cards, a progressive create flow, advanced
  schedule/stop/autonomy/safety/provider/commit/report controls, loop cards with type/target/status/
  progress/latest result, detail controls for Active/Passive, model switching, Resume/Stop/Complete/
  Duplicate/Archive/Remove, and separate Now, Safety, Run timeline, Audit trail, Saved changes, and
  Final report panels. Remove deletes the loop record only; it never deletes the workspace folder.
- **Phase 23.2 data model.** `macro_sessions` remains the compatibility spine, now with additive
  Loop fields: `loop_type`, `target_type`, `target_ref`, `schedule_kind`, `schedule_detail`,
  `next_run_at`, `stop_condition`, `max_runs`, `max_commits`, `run_count`, `commit_behavior`,
  `push_enabled`, `test_commands`, `report_format`, `safety_level`, `latest_result`, and
  `archived_at`. New tables reserve the durable product model: `loop_targets`, `loop_runs`,
  `loop_events`, `loop_templates`, `loop_artifacts`, and `loop_reports`. Automatic actions still
  append to `macro_sessions.auto_actions`, and now also mirror into `loop_events`; each Auto cycle
  records a `loop_runs` row with summary, changed files, commands, tests/builds, commits, next step,
  and errors.
- **Phase 23.2 execution behavior.** `workspace:createProject` can now bind a loop to an existing
  local project path (conservatively: no scaffold/write on bind) or create a fresh Akorith workspace.
  Project loops use the loop workspace for `buildDigest()` instead of the app cwd. Planner prompts
  include a structured Loop profile plus safety rules. Auto-commit returns an explicit result, and
  project-like loops no longer mark themselves complete when the critic claims success but no files
  changed and no commit was made. Archive/remove IPC channels abort active drivers first.
- **Phase 24: Loop Completion.** Loop workspaces are first-class AkorithLoop outputs. The default
  loop repository is `https://github.com/saitakarcesme/AkorithLoop.git`, each loop lives in its own
  folder under `~/Documents/AkorithLoop`, and commit-producing loops force `push_enabled=true`
  even if a stale renderer payload says otherwise. `workspace.ts` exposes read-only
  `inspectLoopWorkspace()` plus `syncAndPushLoopWorkspace()`; `macro:inspectWorkspace` and
  `macro:syncWorkspace` are validated IPC endpoints. The Loop detail UI shows GitHub sync state
  (remote, branch, path-scoped commit count, latest phase, ahead/behind, dirty file count, head),
  and the **Sync to AkorithLoop** button records success/failure in `loop_events`. `loop_runs` and
  `loop_events` now have typed list APIs and render as Run ledger / Event log panels, so restarts
  do not hide what happened. `npm run verify:workspace-loop` is the canonical headless check for
  Phase-N commit numbering and loop workspace inspection.
- **Phase 25: Test Lab Rebuild.** Test Lab is now a guided user flow rather than a developer
  control panel. The primary English path is: choose the source (saved project, folder picker, or
  GitHub URL), choose the local Ollama model that writes the test, choose a fixed test subject
  preset (including **General coverage**, no free-form topic required), choose the result judge
  (Local, Claude, or ChatGPT), then run the test and automatically export a PDF. Local folders and
  GitHub clones are copied into a temporary sandbox before generated tests are written; the source
  repo remains read-only. Runner details stay collapsed as an escape hatch for auto-detection
  misses. A successful run now auto-scores with the selected judge, exports the PDF, and keeps the
  run locked until the report path is available. Historical runs can still be re-scored from the
  Review and PDF section. The PDF template is branded as an Akorith Test Report with verdict,
  ISAScore, metadata, objective metrics, run evidence, score breakdown, judge rationale, generated
  test excerpts, and bounded output excerpts.
- **Phase 26: Settings Center.** The profile footer now opens a real Settings Center instead of a
  small single-column popover. `SettingsCenter.tsx` owns five English sections: Profile
  (display name, light/dark theme, summary chips), Providers (registry availability plus Ollama
  endpoint, LAN/VPN suggestions, auto-start/LAN/discovery toggles), Workflow (bridge Auto-Enter,
  repo-context toggle/path, read-only AkorithLoop remote/folder), Test Lab (default source,
  install-deps toggle, timeout, retained sandboxes, report identity), and Data (local storage and
  safety boundaries). Existing validated IPC remains the only write path for each setting:
  `settings:*` for theme, `ollama:*` for local provider settings, `bridge:*` for Auto-Enter,
  `digest:*` for repo context, and the new `test:setSettings` for Test Lab defaults. The Settings
  Center does not introduce terminal writes, provider sends, secret storage, or filesystem writes
  from the renderer.
- **No permission stalls (Phase 22.1).** The loop's headless executor launches in bypass mode —
  new `pty` command kinds `claude-auto` (`claude --dangerously-skip-permissions`) / `codex-auto`
  (`codex --dangerously-bypass-approvals-and-sandbox`); the user-driven workspace keeps the plain
  interactive kinds. And `runAutoLoop` no longer pauses on a detected prompt — it auto-answers the
  safe default and continues (blast radius is the loop's own throwaway project folder).
- In `runAutoLoop`: after the critic, `maybeAutoCommit` commits the turn's work as the next
  `Phase N`; a metered meta-call **token budget** (`token_budget`, accumulated into `tokens_used`
  by `recordMetaUsage` on every planner/critic/summarizer call; `0` = unlimited) stops the loop
  with `token_budget_reached`. Only the loop's own meta calls are metered — the external executor
  agent's tokens are not visible to Akorith.

**Persistence (additive, safe `ensureColumn` migrations).** `macro_sessions`: `mode`,
`auto_actions` (JSON), `pause_reason`, and **Phase 20** `workspace_dir`, `auto_commit`,
`token_budget`, `tokens_used`, **Phase 21** `title`, and **Phase 22** `pending_steering`.
`macro_turns`: `summarizer_confidence`,
`permission_detection` (JSON), `terminal_snapshot_meta` (JSON), `auto_action`, `result_status`,
**Phase 19** `critic_score`, `critic_verdict`, `critic_review` (JSON), and **Phase 22**
`next_options` (JSON). **Phase 23.2** adds the Loop metadata columns listed above plus
`loop_targets`, `loop_runs`, `loop_events`, `loop_templates`, `loop_artifacts`, and
`loop_reports`. Verified present in the packaged app's DB schema.

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

### Chat-first Codex-style workspace (Phase 13.1)

Phase 13.1 is a **structural** UI pass (not just colors): the workspace becomes chat-first with
terminals hidden behind an activity drawer. Backend/orchestration/security are untouched.

**Layout shift.** The old `Sidebar | ChatPanel | TerminalColumn` becomes `Sidebar | ChatPanel`
(full-width chat-first), plus an `AgentDrawer` overlay. `App.tsx` no longer renders
`TerminalColumn` (the file is kept but unused); the right-side "Open a project to start agents"
onboarding is gone — project open/create is **sidebar-first** (the center hero just routes back to
that flow via `onOpenProject`/`onCreateProject`, the latter bumping `createSignal` so the sidebar
opens its existing create modal).

**Theme flip.** `:root` is now a **dark** Codex workspace (bg `#1a1a1d`, panels `#232327`, light
text) with a **near-monochrome accent** (`--accent` near-white `#ededf0`, `--on-accent` dark) — no
purple/indigo (the old indigo was globally replaced with white-alpha; a `--focus-ring` token was
added). The **sidebar keeps its own light scope** (`.sidebar { --sidebar-* }`) and now also
overrides surface tokens (`--bg-panel`/`--bg-raised`/`--bg-input`) to light + inverts the accent
(dark CTA on white) + a dark focus ring, so no dark surface leaks into the white sidebar. The
create modal (mounted inside the sidebar) uses `--bg-panel` so it's a readable light dialog.

**Agent drawer = background agents (`AgentDrawer.tsx`).** The two `TerminalPane`s (Olympus=Codex
`t2`, Atlantis=Claude `t1`) live here. The drawer is **always mounted while a project with a path
is active** and toggled by a CSS `translateX` — so closing it only hides it; the PTYs and their
snapshot buffers keep running (closing never kills agents). Opening reveals the live panes (already
sized, so xterm stays fitted). Selecting/opening/creating a project starts the agents in the
background immediately. `TerminalPane` gained an `onStatus` callback; statuses bubble through
`App` to a header **agent-status chip** ("Codex & Claude ready" / "Agents starting…" / shell-
fallback warning) so the user knows agents run without opening the drawer. The single write path
(`bridgeSend → PtyManager.write`) is unchanged.

**Chat-first ChatPanel.** Three states: (1) **no project** → centered hero "What should we work
on?" + Open/Create buttons (composer hidden); (2) **project, no messages** → hero "What should we
build in <project>?" + the large centered composer; (3) **conversation** → a centered max-760px
message column (Codex-style full-width turns, subtle user block, borderless assistant text) with
the composer docked at the bottom. The composer is one large rounded dark surface with inline
controls: target route (Olympus/Atlantis), Repo, Auto-Enter, ✦ Suggest, Show agents, Send/Stop.

**Macro-loop integrated.** `MacroLoopPanel` (unchanged engine/state) now renders **inside the
composer**, collapsed by default, restyled compact/dark (a status-chip head when collapsed;
proposal/result/permission cards when expanded). Approval/Auto toggle, status, and Stop are part
of the composer flow rather than a top debug strip.

**Manual UI inspection (REAL).** Packaged app launched + screenshotted
(`docs/validation/phase13-1-ui.png`): light simplified sidebar (compact provider rows, no color
blocks), dark Codex workspace, centered "What should we work on?" hero with Open/Create, top-bar
provider/model + Activity. No right terminal column, no purple. Project-active states (hero
composer, conversation, drawer) are code-verified (GUI click-through needs macOS Accessibility,
unavailable here — same limitation as Phase 12/13).

### Chat workflow polish + agent output feedback (Phase 13.2)

Phase 13.2 polishes the chat-first workspace and adds **terminal-output → chat summaries**.

- **Agent output summaries (the headline feature).** New sessionless main-process IPC
  `agent:summarize` (in `macro.ts`, `summarizeAgentOutput`): reads a **read-only** terminal
  snapshot, builds the agentic-core summarizer prompt, calls `sendMetaPrompt` (**meta call → no
  `usage_event`**) with the `heuristicSummary` fallback, and returns `{ summary, detection,
  signature }`; it returns a "No meaningful new output yet." signal when the snapshot is
  essentially empty. Exposed via `window.api.agent.summarize`. In `ChatPanel`, after a bridge
  send Akorith auto-summarizes once after a bounded delay (`AUTO_SUMMARY_DELAY_MS = 6000`),
  **deduped by `signature`** so unchanged output never spams; a manual **"Summarize output"**
  composer chip does the same on demand. The result is appended as a chat **summary card**
  (`.is-summary`, source = "Olympus / Codex" or "Atlantis / Claude") with status / files /
  commands / tests / failures / next step, and a permission-prompt note when detected. No second
  PTY write path; summaries are meta calls only.
- **Agent drawer resize + per-terminal collapse.** `AgentDrawer` is width-resizable (left-edge
  handle, persisted `akorith.drawerWidth`, clamped 380–980) and each agent collapses
  independently (persisted `akorith.olympusCollapsed`/`akorith.atlantisCollapsed`) — a collapsed
  pane shrinks to its header and the other takes the height; the split resizer shows only when
  both are expanded. `TerminalPane` gained `collapsed`/`onToggleCollapse` (header chevron); the
  host is hidden via CSS when collapsed so **the PTY stays alive** (collapse/close never kills
  agents). Closing the drawer is still just a transform.
- **Composer focus.** Replaced the thick/ring focus with a subtle Codex treatment — soft gray
  border + faint background lift, no glow; the textarea's own `:focus-visible` outline is removed
  (the box owns focus).
- **Dashboard colors (identity-based).** `Dashboard.colorOf` now maps by provider identity:
  **Claude = orange `#d08a4f`, ChatGPT/Codex = blue `#5a93d8`, Local/Ollama = purple `#9a8fe0`**
  (donut, stacked bars, legend dots, chips). The bar cursor tint is neutralized.
- **GitHub-style heatmap.** 11px adjacent squares, tight 3px gap, 7-row week columns, with a
  single-hue green intensity ramp (`--success`) instead of grayscale pills.
- **Chat spacing.** Wider message padding (`30px 32px`), centered max-720px column with
  `margin:auto`, and breathing room on user/assistant blocks; composer dock matches the column.
- **Sidebar brand = text only.** Removed the `<AkorithMark>` logo from the sidebar header;
  expanded shows "Akorith" + "Agent orchestration", collapsed shows a compact "A". The dock/app
  icon is separate.
- **New app icon (native macOS composition).** Source: `~/Downloads/akorithlogolatest.png`
  (purple/green marble gradient with a white `Ak` mark, 1254²). The raw square was making the Dock
  icon look un-native, so a Swift/CoreGraphics step (`/tmp/mkicon.swift`, AppKit + `CGContext`)
  composes a proper macOS icon: a 1024² canvas, the logo clipped into a rounded "body" (~824² inset
  ≈100px, corner radius ≈0.2247·body), transparent outer corners, and a subtle baked contact shadow.
  That rounded master is written to `assets/akorith-logo.png` (the runtime dock/window icon — note
  `app.dock.setIcon` overrides the bundle icon while running, so this MUST be the rounded version)
  and `build/icon.png`, and regenerated into `build/icon.icns` (sips → full `.iconset` 16–1024px →
  iconutil) and `build/icon.ico` (sips + a dependency-free Node packer → multi-size 16–256 PNG-backed
  ICO). The packaged bundle uses the new rounded `icon.icns`; the text-only sidebar/header brand mark
  and the SVG favicon are intentionally left unchanged. To regenerate: run the Swift composer on the
  source, then the `sips`/`iconutil` iconset steps. macOS caches Dock/Finder icons aggressively —
  after replacing the app, refresh with `touch dist/mac-arm64/Akorith.app && killall Dock Finder`
  (or re-login) if the old square lingers.

**Manual UI inspection (REAL).** Packaged app launched + screenshotted
(`docs/validation/phase13-2-ui.png`) in the project-active state: text-only "Akorith" brand,
top-bar agent-status chip "Codex & Claude ready" + Activity, hero "What should we build in
<project>?" with the integrated MACRO LOOP bar + dark composer (route / Repo / Auto-Enter /
Suggest / **Summarize output** / Show agents / Send), light sidebar with compact provider rows.
Dashboard colors/heatmap, drawer resize/collapse, and conversation spacing are code-verified
(GUI click-through needs macOS Accessibility, unavailable here).

### Usability fixes — per-project agents + test-lab presets (Phase 13.3)

- **Per-project agent session preservation (the fix).** PTY sessions are now keyed
  `t1::<projectId>` / `t2::<projectId>` (AgentDrawer builds the composite id; App calls
  `pty.setActiveProject(projectKey)` so the logical bridge targets `t1`/`t2` resolve to the active
  project's session). `PtyManager.create` **reuses** an already-live session for the same project
  cwd/command instead of kill+respawn, so switching projects and back keeps the running
  Codex/Claude; if project metadata changes to a different cwd, the stale PTY is replaced through
  the normal lifecycle path. `TerminalPane` no longer kills on unmount (detach only) and **replays
  the snapshot buffer** on re-attach. Bounded to `MAX_LIVE_PROJECTS = 3` (oldest project's sessions
  evicted). Still one write path (`bridgeSend → PtyManager.write`); `write`/`resize`/`kill`/
  `snapshot`/`isAlive` resolve logical → active.
- **Terminal restore handle.** A collapsed Olympus/Atlantis shows a clickable restore bar
  ("click to restore"); the chevron also toggles. Collapse hides the host but keeps the PTY alive.
- **Test Lab simple mode.** Project/repo selector uses workspace project paths (with custom path
  still editable). The main flow is repo -> test type (Debug regression / Security holes / Core
  unit logic / Edge cases / UI behavior) -> Local/Ollama test generation. Repo detection owns the
  framework/command/path and the editable runner details sit behind a **Runner details**
  `<details>`. ISAScore quality judging is a later explicit step with Claude or ChatGPT only.
- **Macro-loop simplification.** "Include repo context" → **"Repo context"** with help line
  *"Adds a compact project digest so Akorith understands your codebase. Better planning, more
  tokens."*; planner/model/executor/max/threshold moved behind an **Advanced** `<details>`; start
  button reads **"Plan with loop"** (Approval default) / "Start Auto loop"; Stop stays visible.
- **Small UI.** Recent-chat leading provider dots removed; collapsed sidebar profile centered;
  composer focus / dashboard colors / GitHub-style heatmap / centered chat column were settled in
  13.2 and retained.

### UI, Windows icon, local-provider, and chat polish (Phases 14.5-14.6)

Phases 14.5 and 14.6 are focused manual-feedback polish passes. No architecture or security
invariants changed: contextIsolation/sandbox/no nodeIntegration stay on, the contextBridge stays
frozen and validated, prompts still go to CLIs over stdin, the single `bridgeSend -> PtyManager.write`
path remains the only programmatic terminal write path, and provider sends still persist exactly one
normal-chat `usage_event`.

- **Windows icon fix (14.5).** `build/icon.ico` is included in packaged files and Windows resolves
  the BrowserWindow icon from it before falling back to PNG/SVG. Local unpacked builds can be
  stamped with the same `.ico`, so the exe, shortcuts, and taskbar show Akorith instead of the
  generic Electron icon.
- **Local/Ollama reliability (14.5).** The Local provider keeps the configured base URL but, for the
  default `http://localhost:11434`, retries `http://127.0.0.1:11434` when probing `/api/tags`. This
  covers Windows localhost resolution oddities while preserving custom base URLs.
- **Claude token accounting (14.5).** Claude cache counters are no longer shown as fresh prompt
  tokens. `promptTokens` now uses direct `input_tokens` only; the raw provider event still carries
  cache creation/read counters for audit, but tiny follow-up questions no longer show inflated
  visible usage.
- **Readability/UI fixes (14.5).** Native select popup options are forced to dark text on a white
  option background, and the app gets a small readability bump for chat, controls, sidebar, code,
  and terminal text.
- **Sidebar hover stability (14.6).** Recent-chat/provider row actions are absolute overlays with
  reserved row padding and opacity transitions, so hovering a row no longer changes text width or
  pushes neighboring content around.
- **Personalized empty chat (14.6).** Fresh general chats greet the local profile name
  (`Welcome back, Ibrahim`) and keep the project workspace empty state unchanged.
- **Collapsed brand (14.6).** The collapsed sidebar shows the inline Akorith mark instead of a
  plain letter.
- **Assistant message presentation (14.6).** Assistant text segments now render lightweight
  Markdown-style prose: paragraphs, ordered/unordered lists, `**bold**`, and inline code. This
  improves the visual quality of model output without changing model prompts or provider behavior.

### Logo, sidebar scroll, and copyable output polish (Phase 14.7)

Phase 14.7 is another manual-feedback UI polish pass. No architecture/security invariants changed.

- **Collapsed logo uses the current app icon.** The renderer now ships
  `src/renderer/public/akorith-logo.png` copied from `assets/akorith-logo.png`, and collapsed
  sidebar branding renders that PNG instead of the older inline SVG mark.
- **Sidebar scroll scope.** `.sidebar-scroll` is the single scroll container for everything from
  Projects through provider folders and Recent Chats. The profile/settings area stays fixed at the
  bottom. Project lists and Recent Chats no longer own separate nested scroll containers.
- **Copyable output in General Chat.** Fenced assistant blocks now always render a **Copy** button.
  Workspace chats still also show the existing Send-to-agent button, so project workflows keep the
  bridge affordance while general chats gain a direct copy path.
- **Lighter copy/code boxes.** Fenced blocks use a lighter dark surface, larger monospace text, a
  more readable header, and grouped action buttons. This is presentation-only; provider prompts and
  model behavior are unchanged.

### Chat scroll reliability + sidebar project polish (Phase 14.4)

Phase 14.4 is a focused usability bugfix pass over the latest manual testing. No new architecture,
no signing/notarization, no redesign. All invariants unchanged (contextIsolation/sandbox/no
nodeIntegration, frozen contextBridge, untrusted text via stdin, native modules main-only, the
single `bridgeSend → PtyManager.write()` write path, Approval Mode default, meta calls write no
`usage_events`, Workspace/General separation, per-project PTY reuse).

- **Chat scroll trap (the headline bug) — root cause.** Across phases, `.chat-messages` accumulated
  two rules that together made the scroll container `display:flex; flex-direction:column;
  justify-content:center; overflow-y:auto`. A flex container that **centers** its content along the
  scroll axis cannot scroll to the *start* once the content overflows — the top is laid out above
  the scrollable range and clipped. So whenever a chat was tall enough (especially with a large
  code/prompt block), everything **above** that block became unreachable. It looked restore-specific
  only because restored chats are long. **Fix:** `.chat-messages` is now `display:block`; the inner
  `.chat-messages-col` centers itself horizontally with `margin: 0 auto` and flows top→bottom, so the
  full history scrolls. Added `overflow-anchor: none` (so explicit scroll-to-bottom is never fought
  by scroll anchoring), larger bottom padding (last turn clears the docked composer), and hard
  bounds on code blocks (`.chat-code`/`pre`: `max-width:100%`, `overflow-x:auto`, `overflow-y:hidden`)
  so a long line scrolls the block horizontally and never blocks vertical page scroll. Auto-scroll
  behavior is unchanged: it only snaps to bottom when the user is already near the bottom
  (`nearBottomRef`), and a restored chat opens at the bottom but scrolls fully up.
- **Project `⋯` menu now opens.** It was rendered `position:absolute` inside the Projects list, which
  is `overflow-y:auto` — so it was clipped/hidden. It now renders **fixed-position**, anchored to the
  clicked button's `getBoundingClientRect()` (stored as `{ id, top, right }`), escaping the list's
  clip. Closes on backdrop click and on **Escape**. Items: **Rename**, **Reveal in Finder**, and
  **Remove from Akorith** (unchanged DB-only removal + the "does not delete files from disk" confirm;
  removing the active project falls back to a clean no-project Workspace).
- **Reveal in Finder.** New read-only IPC `projects:reveal` → `getProject(id)` + `shell
  .showItemInFolder(project.path)`; preload `projects.reveal`. Disabled in the menu when the project
  has no path. No write/exec surface.
- **Projects list is a folder list, not cards.** Each row (`.project-row`) is `FolderIcon` + name +
  muted path — the avatar/letter block is gone. Active project = subtle gray fill, hover is subtle,
  comfortable row height, `⋯` reveals on hover/active/open. The Projects header keeps its collapse
  arrow, folder icon, count badge, and `+` menu; the list still shows only real projects (no
  `All projects` row).
- **Global UI scale.** `mainWindow.webContents.setZoomFactor(1.1)` is applied on every
  `did-finish-load` (so it survives reloads). One uniform ~10% enlargement of every font/control/
  spacing — the layout viewport reflows, so nothing is clipped — chosen over scattering per-component
  font-size bumps. Sidebar fixed width scales with it (intended).
- **Validation.** `docs/validation/chat-scroll-validation.md` documents the repro and the manual
  scroll/menu/scale checks. All existing verify scripts still pass (`verify-macro-loop`,
  `verify-testlab`, `verify-agentic-loop`, `verify-conversation-context`, `verify-bridge-autoenter`).
- **Known limitations.** The UI scale is a single fixed factor (1.1), not a user preference; an open
  project menu does not reposition if the list is scrolled underneath it (the full-screen backdrop
  intercepts first, so it closes on interaction); Reveal in Finder is macOS Finder / OS file manager
  via Electron `shell` and is a no-op for path-less projects (menu item disabled).

### Sidebar cleanup + bridge auto-enter fix (Phase 14.3)

Phase 14.3 is a focused bugfix/usability pass over the latest manual screenshots. No new
architecture, no signing/notarization, no redesign. Security invariants are unchanged
(contextIsolation/sandbox/no nodeIntegration, frozen contextBridge, untrusted text via stdin,
native modules main-only, the single `bridgeSend → PtyManager.write()` write path, Approval Mode
default, meta calls write no `usage_events`, Workspace/General separation, per-project PTY reuse).

- **Auto-Enter bridge fix (the headline bug).** `Send to Atlantis/Olympus` pasted the prompt but,
  even with Auto-Enter ON, did not submit it. Root cause: `encodeForPty` appended the submit `\r`
  to the **same** write as the bracketed paste; the `claude`/`codex` TUIs treat that trailing `\r`
  as part of the paste and never run it. **Fix:** the pure encoding moved to an electron-free
  `src/main/bridge-core.ts` (`encodeForPty`, `SUBMIT_KEY = '\r'`, `planBridgeWrites`). `bridgeSend`
  now writes the paste, then — only when Auto-Enter is ON — writes the Enter as a **separate**
  keystroke after `SUBMIT_DELAY_MS` (90 ms), so it lands as a discrete submit once the paste has
  settled. Both writes still go through `PtyManager.write()` — **no second write path**. Auto-Enter
  OFF writes the paste only (manual Enter preserved); the Enter is never fused onto the paste and is
  never double-sent. This covers every send: message-level `Send to …` buttons, the composer
  send-to-agent flow, the macro-loop approval send (`macro.ts`, `autoEnter: true`), and the
  permission-answer send. Unit-checked by `scripts/verify-bridge-autoenter.ts`.
- **Remove projects from Akorith.** Each project row gains a `⋯` overflow menu with **Rename** and
  **Remove from Akorith**. `projects:delete` → `deleteProject(id)` deletes the project row and its
  workspace chats (messages cascade) from the local DB inside one transaction — it **never** touches
  the folder on disk. A confirmation modal says so verbatim ("This removes the project from Akorith.
  It does not delete files from disk."). If the removed project is active, the UI falls back to a
  clean no-project Workspace (`onSelectProject(null)`); unrelated project PTY sessions are left alone
  (bounded eviction handles them). Rename uses the existing `projects:update`.
- **Delete recent chats.** Each Recent-chats entry gains a two-click **Delete** (reusing
  `history:delete`; messages cascade). Deleting the active chat opens a clean new chat / clean state.
  The Recent row became a `div role="button"` so the delete control isn't an invalid nested button.
- **Projects list cleanup.** The `All projects` row inside the Projects folder is removed; the list
  now shows only real opened/created projects. The folder header, the `+` Open/Create menu, and the
  empty-state Open/Create actions all remain, so opening/creating projects is unchanged.
- **Collapsed sidebar profile.** When collapsed, the bottom profile button holds a single icon,
  which (as `svg:last-child`) inherited `margin-left:auto` + the dim `--text-faint`, so it looked
  shoved right and broken. Collapsed-mode CSS now zeroes that margin, restores `color: inherit`, and
  sizes the button (44×42, radius 11) to match the collapsed nav items. Clicking still opens
  settings; the expanded profile area is unchanged.
- **DB/IPC/preload surface.** New `deleteProject(projectId)` + `projects:delete` IPC; preload adds
  `projects.remove(projectId)` (typed in `index.d.ts`). No schema migration needed (the existing
  `sessions.project_id` FK already isolates per-project chats).
- **Known limitations.** Project removal is DB-only and irreversible from the UI (the disk folder is
  intentionally never deleted; re-add via Open Project). Recent-chat delete removes the whole session
  (messages cascade) rather than only hiding it. The deferred Auto-Enter uses a fixed 90 ms delay
  (not adaptive to TUI readiness); a removed active project's agent PTYs stay alive until normal
  recency eviction rather than being force-killed.

### Conversation memory + context reliability (Phase 14.2)

Phase 14.2 fixes a critical product bug: the chat UI showed history, but the model never
received it, so a visible session behaved as if it had no memory. Security invariants are
unchanged (single `bridgeSend → PtyManager.write()` path, meta calls write no `usage_events`,
contextIsolation/sandbox/frozen contextBridge, Workspace/General separation, per-project PTY
reuse).

- **Root cause.** `chat:send` (`providers/registry.ts`) sent only the current prompt to
  `provider.send()`. Every provider is single-shot/stateless (`claude -p` over stdin, `codex`
  CLI, Ollama single-message), so prior turns — though persisted per session in the DB — were
  never read back into the request.
- **The fix — assemble per-session context.** A new electron-free core `src/main/conversation.ts`
  turns a session's stored messages into a bounded provider prompt. `chat:send` now loads the
  session's prior messages (`getSessionMessages`, strictly `WHERE session_id = ?`) **before**
  persisting the new one, then `renderProviderPrompt` frames them as an ongoing conversation
  (role-tagged turns, new message last). Memory is keyed only by `session_id`, so there is no
  cross-chat or cross-project leakage, and General vs Workspace sessions stay separate.
- **Bounded context policy.** `selectContextWindow` keeps the recent turns verbatim, bounded by
  count (`recentVerbatim = 24`) and chars (`maxChars = 48k`), always keeping the newest message.
  Past that, older turns are compressed into a **cached session summary** via `sendMetaPrompt`
  (a meta call — **no `usage_event`**), stored on `sessions.context_summary` /
  `context_summary_count` and regenerated only when the older window grows. Recent turns are
  always verbatim.
- **New Chat / restore are context-safe.** New Chat opens a fresh `session_id` (no prior
  memory). Restoring a Recent Chat reloads that session's messages and its real memory stats.
  Switching projects restores that project's session.
- **Memory indicator + reset control** under the composer: `Memory: N msgs` (+ `summarized K`,
  + `Repo on` for Workspace), a tooltip explaining what the model sees, and a two-click
  **Reset context** that clears ONLY the active session (`history:clearMessages`). Backed by the
  read-only `chat:contextInfo` IPC (no model call).
- **Agent summaries join session memory.** `agent:summarize` accepts the active `sessionId` and
  persists the summary as an assistant message in that one session, so later follow-ups in the
  same Workspace chat can reference what the agent did. Still a meta call (no `usage_event`).
- **DB migrations.** Additive: `sessions.context_summary TEXT`, `sessions.context_summary_count
  INTEGER NOT NULL DEFAULT 0`. New helpers: `getSessionMessages`, `getContextSummary`,
  `setContextSummary`, `clearSessionMessages`. New IPC: `chat:contextInfo`,
  `history:clearMessages`.
- **Validation.** `scripts/verify-conversation-context.ts` unit-checks the assembly/bounded
  logic; `scripts/memory-behavioral-check.ts` proves it end-to-end against the **real `claude`
  CLI** (4/4: recalls a fact with memory; the no-memory baseline does not; a separate chat does
  not leak; multi-turn recall works). See `docs/validation/conversation-memory-validation.md`.
- **Known limitations.** Older-context summarization is model-generated and conservative
  (recent turns always verbatim); the behavioral harness exercises the `claude` CLI (the
  logged-in provider) though all providers share the same assembly; the indicator's token figure
  is approximate; context is assembled as an in-prompt transcript (the uniform approach for
  single-shot CLIs), not a provider-specific multi-message API.

### Chat workflow + Test Lab reliability (Phase 14.1)

Phase 14.1 is a focused fix pass over real workflow bugs found in manual use. No new
architecture, no signing/notarization, no redesign. Security invariants are unchanged
(contextIsolation/sandbox/no nodeIntegration, frozen contextBridge, untrusted text via stdin,
native modules main-only, the single `bridgeSend → PtyManager.write()` write path, Approval Mode
default, meta calls write no `usage_events`).

- **Sidebar "New chat".** The separate **Chat** nav item is gone. A dedicated **New chat** action
  sits above **Workspace** (order: New chat · Workspace · Dashboard · Test). Each click calls
  `App.startNewGeneralChat()` which always opens a *fresh* general chat (`selectHistory(null,
  'general')`, never loads the latest), with no project, no project title, and the user's current
  default provider. General chats still appear in Recent Chats as **General chat**. Workspace stays
  project-scoped. Provider-folder `+` buttons still start a fresh general chat for that provider.
- **Prominent model switcher.** The two provider/model `<select>`s are wrapped in a pill
  (`.model-switcher`) with a "MODEL" label in the workspace top bar — clearer selected provider/model,
  better spacing, still compact. Works in both Workspace and General Chat. Switching provider mid-thread
  clears the (provider-bound) session as before.
- **Chat scroll.** The conversation area auto-scrolls to the newest message **only when the user is
  already near the bottom** (`nearBottomRef`, 120px threshold tracked `onScroll`). Scrolling up to read
  history is never interrupted. Opening/switching a session resets to the bottom. The composer stays
  docked at the bottom; the empty state stays centered.
- **Readable chat + code blocks.** Chat content is 15px / 1.72 line-height with a `72ch` max text
  width; fenced code/prompt blocks get more padding, a softer border, a rounded raised surface, a
  13px monospace font, and horizontal scroll for long lines (Phase 14.1 CSS block, appended last).
- **Lighter dark surfaces.** Workspace base tokens were lifted a notch (`--bg #1a1a1d → #232327`,
  panel/raised/composer in step) for a more readable dark gray (still Codex-dark, no light theme, no
  purple). The Test page sandbox output (`TestTerminal` xterm theme + `.test-terminal-col`) moved from
  near-black `#0b0b10`/`#0e0e13` to a lighter, readable `#1b1b22`.
- **Terminal permission prompts surfaced in chat.** A new **read-only** `agent:detectPermission`
  IPC (`window.api.agent.detectPermission(terminalId)`) runs the existing `detectPermissionPrompt`
  over a terminal snapshot. ChatPanel polls the current bridge target every 4s while a project
  workspace is open, and renders a compact **permission card** (source agent Olympus/Codex or
  Atlantis/Claude · the detected question · answer buttons · **Open Activity** · **Dismiss**).
  `detectPermissionPrompt` now also returns `question` and concrete `options[]` (numbered menus
  surface one button per option; yes/no → Yes/No; allow-access → Allow once/Deny; press-enter →
  Press Enter). Answers are sent through the **existing** bridge (`bridge.send → PtyManager.write()`)
  — no second write path. Permanent "always allow" options are surfaced but never auto-selected;
  in Approval Mode the card always waits for the user; Auto-Mode safety gates are untouched.
- **Reliable agent-output summary.** After a bridge send (or a permission answer), the auto-summary
  no longer fires on one fixed 6s delay — it **polls the target terminal's snapshot until output
  stabilizes** (unchanged across 2 polls) or a 45s deadline, then summarizes once (deduped by
  signature). A newer send supersedes an older watcher (`summaryWatch` token). The summary appears
  in the active chat (project workspace for project work; general chat only if started there). The
  manual **Summarize output** button still surfaces the "no meaningful output" state. Summarizer
  calls remain meta calls — no `usage_events`.
- **Test Lab reliability.** A new read-only `test:context` IPC (`buildRepoContext` in `testlab.ts`)
  returns a bounded source-file tree + a few small importable sample files. TestPage prepends this to
  the generation prompt and adds framework-specific rules (real imports of real export names, correct
  pytest/vitest/jest syntax, ≥3 real executable tests, no network/DB/browser deps, no empty
  describe/"0 tests"). A **Repair & rerun** button feeds a failing test file + sandbox output back to
  the model for a corrected file and reruns once in a fresh sandbox (source stays read-only). Framework
  **detection** was fixed so a JS repo with a bare `tests/` dir (Playwright/Cypress e2e) is no longer
  mis-detected as pytest — Python detection now requires real Python evidence.
- **10-run Test Lab validation.** `scripts/testlab-validation.ts` drives the real Test Lab core
  (context → snapshot → install → run → metrics) against real Desktop projects. 12 real runs were
  recorded (10 passed, 2 deliberately-brittle failures, both repaired to pass) across pytest, vitest,
  and jest, plus detection/context checks on three large real repos. See
  `docs/validation/testlab-10-run-validation.md`. The only GUI substitution is the generator
  (structure-aware templates instead of the un-drivable headless model CLI); all execution is real.
- **PDF export preserved.** No change to the Phase 14 PDF flow (saves to Downloads, exact path
  feedback, Reveal/Open).
- **Known limitations.** Permission detection is conservative/heuristic over terminal text — it can
  miss an unusual prompt shape; the card polls every 4s on the current target only. The validation
  harness can't drive the logged-in model CLI headlessly (templated generation). Packaged macOS
  builds remain unsigned/not notarized.

### Project/chat separation + activity drawer fixes (Phase 14)

- **Two chat modes.** Sidebar nav now separates **Workspace** from **Chat**. Workspace is
  project-scoped orchestration: sessions are created/restored with `sessions.project_id`, the
  header shows the selected project, repo context/macro-loop/bridge/Activity controls are available
  only when a project folder is active, and Olympus/Atlantis remain tied to that project. **Chat** is
  general provider chat: sessions use `project_id = NULL`, no project title or project context is
  shown, and `chat:send` passes `includeDigest: false` so the global repo-context setting cannot
  leak project digest text into general conversations.
- **Project switching restores the matching conversation.** Selecting a project switches back to
  Workspace and loads that project's newest session when one exists; otherwise it opens a clean
  project workspace state. Recent chat clicks restore the correct mode: project sessions reopen
  Workspace with their project selected, while general sessions open Chat without forcing project
  context.
- **Activity drawer visibility.** Agent Activity still hosts both `TerminalPane`s and closing the
  drawer only hides it. Olympus/Codex and Atlantis/Claude are always represented for an active
  project, have independent collapse/restore controls, show clear `Starting...` / `Live` /
  `Exited (...)` states, and collapsed slots reserve a visible restore bar so one agent cannot
  silently disappear.
- **Sidebar information architecture.** Sidebar order is brand/nav, Projects, provider folders
  (general chats only), Recent Chats, then fixed profile/footer. The sidebar itself no longer
  scrolls; Recent Chats is the scrollable history region and each item labels **General chat** or
  **Workspace · <project>** with provider/date metadata.
- **PDF export clarity.** Evaluation PDFs now save automatically to the user's Downloads folder as
  `akorith-...pdf`; the Test/Evaluate UI shows the exact saved path, and both current and past
  evaluations offer **Reveal** (Finder at file) and **Open** (system PDF opener). Older internal
  report paths remain allowed for reveal/open.
- **Known limitations.** Project workspaces still choose the newest project-linked session on
  project selection; there is no dedicated project-chat picker beyond Recent Chats yet. Packaged
  macOS builds remain unsigned/not notarized.

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

**Icons.** Source is `assets/akorith-logo.png` (1024², the purple/green marble `Ak` logo).
Generated platform icons live in `build/` (electron-builder's `buildResources` dir):
`build/icon.icns` (macOS, via macOS `sips` → `.iconset` → `iconutil`, 16–1024px), `build/icon.ico`
(Windows, a valid multi-size PNG-backed ICO — 16/24/32/48/64/128/256 — packed by a small
dependency-free Node script since there is no ImageMagick on the build box), and `build/icon.png`
(1024², Linux / fallback). `mac.icon` / `win.icon` / `linux.icon` point at these. The packaged
`.app` uses `icon.icns` (Akorith), not the Electron icon.

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

## Phase 15 - Theme Toggle

Akorith now has a persisted Light/Dark theme selector in the sidebar profile Settings popover.
The renderer owns the selected theme in `App.tsx`, stores it in `localStorage` as
`akorith.theme`, and applies it through `<div className="app" data-theme="...">`.

Theme rules are token-first. Light mode keeps the navigation white and lifts workspace grays to
soft, readable product surfaces. Dark mode makes the former white navigation a dark gray surface
and pushes the workspace grays toward black, while preserving contrast for text, controls, recent
chats, copyable code blocks, and popovers. The sidebar no longer hardcodes light-only surface
tokens; it inherits `--sidebar-*` variables from the selected app theme.

Terminals and agent activity surfaces remain intentionally dark-scoped. Do not route terminal
colors through the user theme unless Phase 15.x explicitly asks for terminal theming.

## Phase 15.1 - Local Provider + Workspace Context Reliability

- **Local/Ollama provider:** the Local provider can auto-start `ollama serve` when the loopback
  server is down (`providers.local.autoStart`, default true). `exposeLan` binds auto-started
  Ollama as `0.0.0.0:11434`, or `ollamaHost` can provide a sanitized host override. Auto-start is
  loopback-only; remote `baseUrl`s are probed but never spawned locally. `localhost` still falls
  back to `127.0.0.1`, and Windows common install paths such as
  `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` are checked even when Electron's PATH cannot see
  `ollama`.
- **Workspace context is main-trusted:** renderer may pass a workspace hint, but `chat:send`
  derives the actual project name/path from the persisted session's `project_id` via
  `getSessionProjectContext()`. Repo digest for Workspace chats uses that validated stored project
  path, so General Chat and spoofed IPC payloads cannot point digest at arbitrary folders.
- **Permission prompts:** Codex-style "trust this folder/workspace/repo" output is detected in
  `agentic-core.ts` as a medium-risk access decision requiring review. PTY startup must not answer
  it directly; any response goes through the visible permission UI / Auto Mode policy and the
  existing `bridgeSend -> PtyManager.write()` path.
- **Test Lab polish:** the main Test route now stays intentionally narrow: choose a repo, choose a
  test type, generate with Local/Ollama, then score selected runs with Claude or ChatGPT to produce
  ISAScore. The repo input accepts local paths or GitHub repo URLs; GitHub URLs are validated as
  `github.com/owner/repo`, cloned with `git clone --depth 1` into Akorith's managed
  `testlab-github-repos` cache under `userData`, then fed into the same read-only snapshot/sandbox
  path. JS/TS repos with `package.json` but no configured test runner now fall back to
  `npx --yes vitest run` with an `akorith.generated.test.*` file instead of blocking as
  `unknown`. Multi-model comparison and optional quality toggles are no longer part of the primary
  flow. The verifier is Windows-safe (`node -e` timeout fixture, `execFileSync` for git status,
  `readdirSync` for prune counts).
- **Chat/sidebar/startup polish:** Recent chats render title-only like Codex, assistant responses
  expose a whole-message copy action as soon as text exists, scroll no longer clears selection state
  on every scroll event, and a small native splash window shows the Akorith logo over the purple /
  green marbled background while the renderer boots.

## Phase 16 - GitHub Test Lab, LAN Ollama, and Image Chat

- **Why the screenshot test failed:** the generated fallback Vitest test imported `@/lib/slugs`,
  but the temporary Vitest runner had no Next/TS alias config, so Vitest failed before executing
  any tests (`Cannot find package '@/lib/slugs'`). Phase 16 writes a sandbox-only
  `akorith.vitest.config.mjs` whenever Akorith uses the fallback Vitest command, mapping `@` and
  `~` to the sandbox repo root. The generator prompt also tells models to prefer relative imports
  and to use only real exported names from the source samples.
- **GitHub Test Lab source:** the Test repo input accepts local paths and GitHub repo URLs
  (`https://github.com/owner/repo`, `github.com/owner/repo`, or `git@github.com:owner/repo.git`).
  Main validates GitHub-only refs, clones with `git clone --depth 1` into the managed
  `userData/testlab-github-repos` cache, then feeds the resulting local folder into the existing
  read-only snapshot/sandbox path.
- **LAN Ollama discovery:** Local/Ollama defaults now include `exposeLan: true` and
  `lanDiscovery: true`. When Akorith starts Ollama itself for a loopback config, it binds with
  `OLLAMA_HOST=0.0.0.0:11434`; when localhost is unavailable (for example on a MacBook), the Local
  provider scans private IPv4 `/24` LAN candidates for `/api/tags` and reuses the first reachable
  Ollama server, so a Mac can see models exposed from the Windows host. If Ollama was already
  running localhost-only on the host, restart Ollama/Akorith so it can bind to LAN.
- **Image chat attachments:** the composer supports up to four PNG/JPEG/WebP/GIF images (6 MB each
  in the renderer, validated to 8 MB base64 in main). User messages show thumbnails. Local/Ollama
  receives real image bytes via `/api/chat` `images` for multimodal local models; text-only CLI
  providers receive an attachment-name note but not pixel data.

### Phase 23: Biggest Test Step of Akorith

`docs/validation/phase23-biggest-test-step.md` is the broad product validation pass for the current
Phase 23 surface. It records the combination matrix across General Chat, Workspace, bridge sends,
agent summaries, permission cards, Loops, Test Lab, dashboard, settings, packaging, and remote
Local/Ollama.

Results: `npm run typecheck`, `npm run build`, `verify-macro-loop`, `verify-agentic-loop`,
`verify-critic-loop`, `verify-conversation-context`, `verify-bridge-autoenter`,
`verify-workspace-loop`, and `verify-testlab` pass. Live Local/Ollama model calls were blocked
because the home PC was off, but the remote model path is documented: use Tailscale/WireGuard or a
protected tunnel, run Ollama on the PC with `OLLAMA_HOST=0.0.0.0:11434`, paste the PC's
`http://100.x.y.z:11434` endpoint into Mac Akorith Settings, Test, then Save.

Findings to remember for future phases: an already installed packaged app stays old until a fresh
build/package is launched or installed; `electron-vite dev` only hot-reloads renderer code, so
`src/main` and `src/preload` changes require restarting the dev server; `package.json` still says
`0.1.0`; and `npm run pack:mac` compiled but then hung silently during this validation window with
no `dist/mac-arm64/Akorith.app` output, so packaging needs another focused investigation before a
release.

### Phase 23.1: Fully Active/Passive Loop Switch

The Loop section now exposes a **Fully loop** Active/Passive switch. Active mode starts and keeps
the loop running automatically; Passive mode creates or returns the session to a waiting state so
the user manually resumes it. This maps to the existing macro `auto`/`approval` modes and preserves
the single executor write path.

### Phase 23.2: Loop Operations Center

The Loop section is now a final-product-quality autonomous automation center. Users can start from
templates or a natural-language instruction, choose a target (new project, local project, GitHub
repo, social source, research source, or custom source), schedule, autonomy mode, stop limits,
commit/push/report behavior, safety level, validation commands, provider/model, and executor.
Loops are auditable and manageable with Resume, Stop, Complete, Duplicate, Archive, and Remove.
The backend stores Loop-native targets/runs/events/templates/artifacts/reports, mirrors automatic
actions into `loop_events`, records each autonomous run in `loop_runs`, uses the loop workspace for
repo digest context, and refuses to mark project-like loops complete when no project change was
verified.

### Phase 24: Loop Completion

Loop output is now GitHub-auditable instead of only local. Existing Phase 23 loop folders were
migrated into `~/Documents/AkorithLoop` and pushed to `saitakarcesme/AkorithLoop` with one folder
per loop. New commit-producing loops normalize `push_enabled` to true in the main process, push the
Phase 0 scaffold immediately, and push every later `Phase N: ...` commit from `maybeAutoCommit()`.
The renderer cannot silently disable push while `commitBehavior` is `commit`.

The Loop detail page has a GitHub sync panel backed by main-process git inspection. It reports the
remote URL, branch, path-scoped commit count, latest Phase number, ahead/behind counts, dirty file
count, head, and latest commit subject. Manual **Sync to AkorithLoop** runs through the shared loop
git queue, repairs the origin URL, pulls/rebases with autostash, pushes to `main`, updates
`push_enabled`, and writes a success/failure `loop_events` record.

Loop history is now durable after restart: `listLoopRuns()` / `listLoopEvents()` expose the
persisted `loop_runs` and `loop_events` tables through `macro:listRuns` and `macro:listEvents`.
`LoopsPage.tsx` renders these as Run ledger and Event log panels in addition to the older turn
timeline and `auto_actions` audit trail. Keep loop deletes DB-only; never delete loop folders.

### Phase 25: Test Lab Rebuild

Test Lab is now a guided English workflow: source selection, Local/Ollama test writer, fixed test
subject preset, Local/Claude/ChatGPT result judge, then one run action that evaluates and exports a
PDF. Sources can come from saved projects, a folder picker, or GitHub URLs; generated tests still
write only into a temporary sandbox copied from the source. The old advanced runner controls remain
available but collapsed.

The PDF report is now an Akorith Test Report with a dark header, verdict, ISAScore, metadata,
objective metrics, run evidence, score breakdown, judge rationale, generated test excerpts, and
bounded output excerpts. The primary Test Lab flow keeps running until the PDF path is available.

### Phase 26: Settings Center

The sidebar profile footer opens `SettingsCenter.tsx`, a tabbed settings surface with Profile,
Providers, Workflow, Test Lab, and Data sections. It centralizes the knobs that had been scattered
across the sidebar and workflow surfaces without adding new unsafe capabilities.

Settings writes still go through their existing main-process owners: theme via `settings:*`, Ollama
via `ollama:*`, bridge Auto-Enter via `bridge:*`, repo context via `digest:*`, and Test Lab defaults
via the new validated `test:setSettings` IPC. `config.ts` clamps Test Lab timeout, retained sandbox
count, source length, and provider id before writing `loopex.config.json`. Renderer folder choices
reuse the validated `projects:pickDirectory` dialog; renderer code never writes project files.

## Conventions

- Surgical edits; keep the security posture intact (CSP, sandbox, frozen bridge).
- Mark future integration points with `// TODO(phase N):` comments.
- Prompts and other untrusted text go to CLIs via **stdin**, never argv.
- **At the end of EVERY phase, update BOTH `AGENTS.md` and `codex.md`** (flip the phase
  checklist, record the new state) and commit + push to `origin main`.
