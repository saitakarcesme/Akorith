# Loopex / Akorith — Codex continuation guide

This is the hand-off doc so the **Codex CLI** can continue Loopex if Claude Code is
unavailable. `AGENTS.md` is the deep architecture/spec reference; this file is the shorter
"how we work + where we are" companion. **Keep both in sync** (see the rule at the bottom).

## What Loopex / Akorith is

Loopex is the current repo/package name. **Akorith** is the visible product name introduced in
Phase 9.1; full package identity cleanup remains Phase 10. It is an Electron + TypeScript + React
desktop workspace that orchestrates coding agents **without any API keys**. A planner chat on the
right talks to the user's own **Claude** / **ChatGPT**
subscriptions via their installed CLIs (`claude`, `codex`) or a local **Ollama** server; the
center hosts two real PTY terminals; the left sidebar holds session history. Built with
electron-vite in strict numbered phases.

- Run: `npm install` then `npm run dev`. Type-check: `npm run typecheck`.
- Config + DB live in Electron's userData dir: `loopex.config.json`, `loopex.db`.

## Working conventions (do not violate)

- **One phase at a time.** Build only the requested phase; mark future hooks
  `// TODO(phase N):`. Surgical edits, correctness over speed.
- **Security invariants — keep intact:** `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`; the renderer's only capability is the **frozen** `window.api`
  contextBridge over validated IPC; CSP in `index.html`; untrusted text (prompts) reaches
  CLIs via **stdin, never argv**.
- **Single PTY write path:** everything that writes to a terminal goes through
  `bridgeSend()` → `PtyManager.write()`. Never add a second programmatic write path.
- **One `usage_event` per assistant send,** written only at the `chat:send` choke point in
  `registry.ts`. Meta calls (e.g. the router's classifier) must not write one.
- **Providers are equal:** no provider file imports another; `registry.ts` + config are the
  single source of truth. Don't change provider internals without cause.
- **Native modules:**
  - `node-pty` ships N-API prebuilds — **never** rebuild it from the npm tarball (winpty
    git metadata is missing; the build fails).
  - `better-sqlite3` needs `electron-rebuild -f -o better-sqlite3` (prebuilt download for
    Electron's ABI) — that's the `postinstall` / `npm run rebuild`.
  - **macOS:** `postinstall` also runs `node scripts/fix-spawn-helper.js` to `chmod +x`
    node-pty's `darwin-*/spawn-helper` (the tarball ships it non-executable, which breaks
    every PTY spawn with `posix_spawnp failed`). Keep this; it must be part of clean install.
- **electron-vite dev does NOT hot-rebuild `src/main` or `src/preload`** — restart the dev
  server after changing either before verifying. Renderer hot-reloads.
- **Git:** commit + push to `origin main` at the end of each phase. **Do not guess git
  credentials** — if auth/identity is missing, stop and ask.

## Phase checklist

- [x] **Phase 1** — static three-region Electron shell.
- [x] **Phase 2** — real interactive PTY terminals via node-pty (`t1`/`t2`).
- [x] **Phase 3** — pluggable, config-driven provider registry (Claude / ChatGPT / Ollama).
- [x] **Phase 4** — chat→terminal bridge (per-block / whole-message / selection, target
      switch, auto-Enter) — the single `bridgeSend` injection path.
- [x] **Phase 5** — SQLite chat history (sidebar folders) + usage dashboard.
- [x] **Phase 6** — macOS PTY spawn fix; **suggest-only** router (local classifier,
      `tierMap`/`warnThresholds`/`classifierModel`, warn-not-switch, usage-based-not-
      official-limit, classifier writes no usage_event); **opt-in** bounded repo digest.
- [x] **Phase 7** — isolated local-model **test page** (separate route, one chat + one
      terminal). Local model writes pytest / jest|vitest tests for a user-picked repo;
      they auto-run in a fresh ephemeral **temp sandbox** (source is read-only;
      timeout + process-tree kill + Stop + prune); objective metrics collected and
      persisted to `test_runs`; multi-model comparison mode. No score computed here.
- [x] **Phase 8** — evaluate / PDF / ISAScore. Reads `test_runs` without re-running tests;
      computes dimensional ISAScore (Tests, Speed, Token efficiency, optional Quality),
      stores one `evaluations` row per action, and exports one consistent PDF template for
      single and comparison reports via main-process `pdfkit`.
- [x] **Phase 9** — semi-automatic macro-loop orchestration. A compact loop panel creates
      persisted `macro_sessions` / `macro_turns`, reuses `buildDigest()` for optional repo
      context, calls planner providers as hidden meta calls, shows one structured proposal,
      and sends only user-approved prompts to executor terminals through `bridgeSend()`.
- [x] **Phase 9.1** — Akorith UI polish and workspace projects. Visible app branding, icon
      asset/fav icon, calm dark-gray + muted-purple theme, collapsible sidebar, icon nav,
      recent chats, SQLite project folders, local settings/profile entry, Olympus/Atlantis
      terminal display names, terminal role labels, planner panel resize/collapse, terminal
      split resize, and polished macro-loop presentation.
- [ ] **Phase 10** — packaging + `productName` fix (scope: distributable build, app name,
      full package identity cleanup, native `.icns` / `.ico` assets).

## Locked design decisions

- **No API keys, ever** — subscriptions via CLIs, or local Ollama. Never fabricate costs;
  `usage.estimated=true` when numbers are approximations.
- **Router suggests, the user decides.** No automatic provider switching. The classifier
  runs on a **local** model only, called directly (not via `chat:send`).
- **Limit warnings are based on Akorith's own recorded usage**, never an official plan limit,
  and must say so.
- **Repo digest is opt-in and hard-capped**, prepended only to what the provider sees, never
  persisted into history and never treated as instructions.
- **Test page: the source repo is read-only; all generated code runs in an ephemeral temp
  sandbox** with a timeout + process-tree kill. Never write back to the source, never run as
  admin/sudo. Keep the safety core (`testlab.ts`) electron-free so it stays headlessly
  verifiable (`node --experimental-strip-types scripts/verify-testlab.ts`).
- **ISAScore is dimensional, not a single opaque number.** Objective dimensions always work
  without an LLM: Tests uses parsed pass/fail/error counts with bad exit statuses scoring 0,
  Speed normalizes against the fastest selected run, and Token efficiency normalizes against
  the lowest token count. Optional Quality is the only LLM-judged dimension; if skipped or
  invalid, the total re-normalizes over the active objective dimensions.
- **Evaluation judge calls are meta calls.** The user selects the judge provider/model each
  time; the evaluation records the judge model and any usage in the evaluation payload, but
  it writes no `usage_event` and does not affect the dashboard.
- **PDF reports use one main-process template.** `pdfkit` generates single and comparison
  reports under the app's `userData/reports` directory, with consistent typography, objective
  metrics, score breakdowns, judge label, rationale when present, and generated-test excerpts.
- **Macro-loop is semi-automatic.** Planner proposals are meta calls and do not write
  `usage_event`; the user must approve or edit each executor prompt before it is sent through
  the existing bridge path. Terminal output is not auto-interpreted yet — the user pastes or
  summarizes the executor result before continuing.
- **Phase 9.1 UI state is local and conservative.** Sidebar collapse, planner width/collapse,
  terminal split, terminal role labels, and display name are renderer `localStorage`; projects are
  SQLite rows, and new sessions can store nullable `project_id`.
- **Terminal display names are presentation only.** `t2` is Olympus and `t1` is Atlantis in the UI;
  internal IDs and IPC stay unchanged. Moving terminals to a selected project folder is an explicit
  user action that sends a safely quoted `cd` through `window.api.bridge.send`, preserving
  `bridgeSend()` → `PtyManager.write()`.
- **No autopilot in Phase 9.1.** Akorith does not auto-parse terminal output, auto-answer
  permission prompts, or type `yes`, `1`, or similar into terminals.
- A session belongs to **one** provider; switching provider starts a new session context.

## Rule: keep the docs current

At the **end of every phase**, update **both** `AGENTS.md` and this `codex.md` — flip the
checklist above, record the new state and any new invariants — then commit + push.
