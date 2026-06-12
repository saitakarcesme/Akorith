# Loopex — agent guide

Loopex is an Electron + TypeScript + React desktop workspace that orchestrates coding
agents **without any API keys**: a planner chat on the right talks to the user's own
Claude / ChatGPT subscriptions (via their installed CLIs) or a local Ollama server; the
center hosts two real PTY terminals; the left sidebar will hold session history. Built
with electron-vite, in strict numbered phases — currently through Phase 9 (semi-automatic
macro-loop orchestration).

**Phase roadmap:** 1 shell · 2 PTY terminals · 3 provider registry · 4 chat→terminal
bridge · 5 SQLite history + dashboard · 6 macOS fix + suggest-only router + repo digest ·
7 isolated test page · 8 evaluate/ISAScore/PDF · **9 semi-automatic macro-loop** — all done.
Pending: **9.1 UI revision** (usage-driven, surgical — not a redesign) · 10 packaging +
`productName`.

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

**Target terminal**: a single current target (`t1` = Terminal 1, default, or `t2` =
Terminal 2), shown and changed via the segmented control in the bridge bar at the top
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

- `sessions(id, provider_id, title, created_at, updated_at)` — **a session belongs to
  one provider**; switching provider in the chat starts a new session context.
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

The sidebar shows one collapsible folder per registry provider (plus orphaned
providers that still have sessions) with rename/delete/new-chat; clicking a session
restores its conversation into the chat panel. Sidebar nav switches between
**Workspace** (default, 3-pane) and **Dashboard**; the workspace stays mounted
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
  on usage recorded in Loopex, not your official plan limit"* — and for Asker/Albay nudges
  (does not force) toward local. We cannot read official plan limits; this is Loopex's own
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

The Workspace chat panel now includes a compact **Macro loop** area near the bridge controls.
It is intentionally not a UI redesign. The user enters a high-level goal, chooses a planner
provider/model from the registry, picks target terminal `t1`/`t2`, sets max iterations and a
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
step, preserve Loopex security invariants, avoid unsafe architecture changes, prefer surgical
edits, and require the executor to report changed files, tests run, failures, and commit status.
If JSON parsing fails, the raw response becomes an editable proposal and is marked with an error
on the turn.

**Repo context reuse.** When enabled, the loop calls the existing `buildDigest()` and stores the
bounded snapshot on `macro_sessions.repo_digest_snapshot`; there is no second repo scanner.

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
