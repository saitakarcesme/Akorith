# Loopex / Akorith — Codex continuation guide

This is the hand-off doc so the **Codex CLI** can continue Loopex if Claude Code is
unavailable. `AGENTS.md` is the deep architecture/spec reference; this file is the shorter
"how we work + where we are" companion. **Keep both in sync** (see the rule at the bottom).

## What Loopex / Akorith is

Loopex is the current repo/package name. **Akorith** is the visible product name introduced in
Phase 9.1; full package identity cleanup remains Phase 10. It is an Electron + TypeScript + React
desktop workspace that orchestrates coding agents **without any API keys**. The center planning
chat talks to the user's own **Claude** / **ChatGPT**
subscriptions via their installed CLIs (`claude`, `codex`) or a local **Ollama** server; the
right execution area hosts two real PTY terminals; the left sidebar holds projects and session
history. Built with
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
      terminal display names, layout controls, terminal split resize, and polished macro-loop
      presentation.
- [x] **Phase 9.1.1** — project-first workspace flow. Workspace is now sidebar / center
      planning-chat / right execution terminals; execution area opens or creates a project first,
      then starts Olympus as `codex` and Atlantis as `claude` in that project folder through the
      PTY session manager, with shell fallback when a CLI is missing. Recent chats are compacted,
      Macro loop collapse no longer hides normal chat, and the composer shows subtle
      provider/model/context/target info.
- [x] **Phase 9.1.2** — workspace polish + app identity. Terminal split opens equal (50/50) by
      `flex-grow` (still drag-resizable, still persisted); center chat surface lifted via new
      `--bg-chat` / `--bg-chat-bubble` / `--bg-composer` tokens (terminals stay darker); the
      sidebar *All projects* `+` opens an **Open Project / Create Project** menu; Create Project
      uses a centered modal with project name + parent-folder picker (new `projects:pickDirectory`
      IPC, extended `projects:createFolder` accepting a pre-picked `parentPath`); `app.setName`,
      window title, and a raster `assets/akorith-logo.png` dock/window icon replace the Electron
      identity in dev/runtime. Native `.icns`/`.ico` + `package.json` rename stay Phase 10.
- [x] **Phase 9.1.3** — app identity + sidebar defaults. `package.json` `name`→`akorith`,
      `productName`→`Akorith`, Akorith `description`; main process adds
      `app.setAboutPanelOptions({ applicationName:'Akorith' })` alongside the existing
      `app.setName('Akorith')` + dock icon, so window title, About panel, and About/Hide/Quit menu
      roles say Akorith. Sidebar provider folders (Claude/ChatGPT/Local) now **default collapsed**,
      persisted in `localStorage` `akorith.providerCollapsed`. The broken hand-drawn settings gear
      is replaced with a clean stroked gear and the profile button pins its icons with
      `flex:0 0 auto`. **Documented limitation:** in dev the macOS menu-bar app name + dock tooltip
      stay "Electron" (read from Electron.app's `Info.plist` `CFBundleName`; only a packaged build
      with `productName` fixes them — Phase 10).
- [x] **Phase 10** — electron-builder packaging + macOS app identity. `electron-builder` 25.x
      devDep; config in the `package.json` `build` field; scripts `pack`/`pack:mac` (`--dir`),
      `dist`/`dist:mac` (dmg+zip), `dist:win` (NSIS config). `appId=com.akorith.app`,
      `productName=Akorith` → packaged `Info.plist` `CFBundleName`/`CFBundleDisplayName`=Akorith,
      so the **packaged** app shows Akorith in menu bar/Dock/Finder/title (the dev-only "Electron"
      limitation is now resolved for the built app). Icons in `build/`: `icon.icns` (sips+iconutil),
      `icon.ico` (256² PNG-backed, no ImageMagick), `icon.png` (1024²). Native modules:
      `npmRebuild:false` (so electron-builder doesn't rebuild node-pty and fail — postinstall already
      did better-sqlite3 for Electron ABI; node-pty uses N-API prebuilds) +
      `asarUnpack` for node-pty/better-sqlite3 (`.node` + executable `spawn-helper` land in
      `app.asar.unpacked`). `main/index.ts` `ensureCliPath()` prepends Homebrew/user bin dirs to
      `PATH` so Finder-launched GUI apps resolve `claude`/`codex`/`ollama` (no shell eval; missing
      CLI still degrades to shell + message). Smoke-tested: `dist/mac-arm64/Akorith.app` launches,
      identity correct, `loopex.db` created (better-sqlite3 loads). README rewritten for humans;
      `docs/release-checklist.md` added. Remaining: code signing/notarization + a built Windows
      installer (config ready).
- [x] **Phase 11** — agentic loop + product polish. Polish: inline `<AkorithMark>` SVG logo
      (fixes packaged broken-box from absolute `/` path), terminal-split root-cause fix
      (`storageNumber` null→fallback + 30–70 `sanitizeSplit`), lighter chat surface, light
      borderless chat bubbles, soft translucent glass sidebar, larger global radii. Agentic:
      `src/main/agentic-core.ts` (electron-free: snapshot bounding, permission detection,
      summarizer parse/heuristic, Auto policy + stop gates) verified by
      `scripts/verify-agentic-loop.ts`; read-only bounded `ptyManager.snapshot` + `pty:snapshot`
      IPC; `macro.ts` gains `mode` (approval default | auto), `summarizeTurn` (meta call + heuristic
      fallback, no `usage_event`), `respondPermission` (one-time token via bridge), and an
      abortable `runAutoLoop`. Additive macro DB columns. Approval Mode unchanged + default.

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
- **Macro-loop: Approval Mode is the default and is unchanged.** Planner proposals are meta
  calls and do not write `usage_event`; the user approves or edits each executor prompt before
  it is sent through the bridge path.
- **Auto Mode (Phase 11) is opt-in and cautious — do not loosen its gates.** It may auto-send
  the planner's prompt and auto-answer ONLY low-risk, one-time, high-confidence (≥0.6)
  confirmations (`agentic-core.decidePermissionPolicy`). Medium/high-risk, low-confidence,
  destructive, "always allow", or ambiguous prompts always pause for the user. It never
  auto-selects a permanent allow. Planner risk `high` pauses. Summarizer calls are meta calls
  (no `usage_event`). Every auto-action is logged to `macro_sessions.auto_actions`. Stop aborts
  the loop at every await. Permission responses and proposals both go through the single
  `bridgeSend → PtyManager.write()` path — never a second write path.
- **Terminal snapshots are read-only + bounded.** `ptyManager.snapshot` / `pty:snapshot` expose
  only a capped tail of recent output; no filesystem, no exec, no write. Keep `agentic-core.ts`
  electron-free so `scripts/verify-agentic-loop.ts` stays headless.
- **Phase 9.1 UI state is local and conservative.** Sidebar collapse, planning-tool collapse,
  right execution width, terminal split, and display name are renderer `localStorage`; projects are
  SQLite rows, and new sessions can store nullable `project_id`.
- **Terminal display names are presentation only; command startup is explicit.** `t2` is Olympus and
  `t1` is Atlantis in the UI; internal IDs and IPC stay unchanged.
- **Project-first agents (Phase 9.1.1):** Open/Create Project uses validated main-process dialogs
  and persists `projects` rows. Selecting a project with a valid path starts Olympus (`t2`) as
  `codex` and Atlantis (`t1`) as `claude` in that cwd via the existing PTY manager. Missing CLI
  binaries fall back to a shell with a visible message. This is terminal lifecycle, not a second
  programmatic write path.
- **No autopilot in Phase 9.1.1.** Akorith does not auto-parse terminal output, auto-answer
  permission prompts, or type `yes`, `1`, or similar into terminals.
- **Project create/open is main-process only (Phase 9.1.2).** The sidebar `+` menu and the
  Create Project modal call validated preload APIs (`projects:openFolder`,
  `projects:pickDirectory`, `projects:createFolder`); the renderer never touches the filesystem,
  name validation + path-traversal guards live in main, and selecting a project with a valid path
  starts Olympus/Atlantis through the existing PTY lifecycle — not a new write path.
- **App identity is runtime + packaged (9.1.2/9.1.3 + 10).** Runtime: `app.setName('Akorith')`,
  `app.setAboutPanelOptions`, window `title`, dock icon. Packaged (Phase 10): electron-builder
  `productName=Akorith`/`appId=com.akorith.app` → the bundle `Info.plist` `CFBundleName` shows
  Akorith in the menu bar/Dock/Finder. In **dev** the menu-bar/Dock name still reads "Electron"
  (Electron.app's own `Info.plist`); that is expected and only the packaged build fixes it.
- **Packaging invariants (Phase 10) — do not break.** electron-builder config lives in
  `package.json` `build`. Keep `npmRebuild:false` (electron-builder must NOT rebuild node-pty —
  it would fail; postinstall handles better-sqlite3, node-pty uses N-API prebuilds). Keep
  `asarUnpack` for node-pty + better-sqlite3 (their `.node` and node-pty's `spawn-helper` must be
  on disk and executable). Keep `assets/**` in `build.files`. `dist/` is git-ignored; never commit
  packaged artifacts. Icons live in `build/` (`icon.icns`/`icon.ico`/`icon.png`).
- **Packaged GUI PATH.** `ensureCliPath()` in `main/index.ts` prepends static well-known bin dirs
  (Homebrew/user) to `process.env.PATH` so Finder-launched apps resolve `claude`/`codex`/`ollama`.
  Static dirs only — never spawn a shell or eval to discover PATH.
- **Sidebar local UI state (9.1.3).** Provider folders default collapsed and persist in
  `localStorage` `akorith.providerCollapsed` (absent = collapsed); join the existing
  `akorith.*` localStorage keys (sidebar collapse, terminal split, etc.). Provider groups must stay
  visible-but-collapsed — never removed.
- A session belongs to **one** provider; switching provider starts a new session context.

## Rule: keep the docs current

At the **end of every phase**, update **both** `AGENTS.md` and this `codex.md` — flip the
checklist above, record the new state and any new invariants — then commit + push.
