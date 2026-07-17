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
local CLIs run headlessly behind the conversation; the left sidebar holds projects and session
history. Built with electron-vite in strict numbered phases; currently through **Phase 70:
Research Presentation, Unified Usage & Sidebar Alignment**.

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
- **Local executor invariant:** Ollama/local loop executors never receive raw shell control.
  They return strict JSON patch attempts; Akorith validates paths, applies changes inside the
  workspace, runs allowlisted validation commands, scores the attempt, and commits only
  meaningful successful changes.
- **Usage is one additive canonical ledger.** Normal Chat writes one `usage_event` per assistant
  send at the `chat:send` choke point. Each Research job writes one visible request, while its
  plan/cycle/synthesis calls write token-only rows with stable source identities; unrelated meta
  calls (for example the router classifier) still write none.
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
- [x] **Phase 12** — full product validation. Built/tested/AI-reviewed 3 local sample projects
      (`~/Desktop/akorith-validation/`) using the real `claude`/`codex` CLI paths; report in
      `docs/validation/full-product-validation.md`. No blocker bugs. Recommendation: ready for
      private demo, close to public soft launch.
- [x] **Phase 13** — Codex-quality light UI + persistent history. Token-first redesign in
      `styles.css`: light/neutral workspace (`--bg` #f4f4f3, chat #fafafa, white panels, dark text,
      muted-indigo `--accent` #6257c9, black-alpha borders/hover, `--on-accent`). **Light/white
      sidebar** via scoped `--sidebar-*` tokens. The right execution column (`.terminal-column`),
      `.chat-code`, and `.test-terminal-col` keep **scoped dark token overrides** so terminals/code
      stay dark. Old lavender accent unified to indigo. Light chat bubbles, filled Send button,
      light window `backgroundColor`. Persistent history: `App.tsx` restores last active project
      from `localStorage` (`akorith.lastActiveProjectId`) via existing safe PTY startup; sidebar
      empty-state CTAs. Verified by launch + screenshot (`docs/validation/phase13-ui.png`).
- [x] **Phase 13.1** — chat-first Codex-style workspace (structural). Layout is now
      `Sidebar | ChatPanel` (full-width chat-first) + an `AgentDrawer` overlay; `TerminalColumn`
      is no longer rendered (right onboarding removed; project open/create is sidebar-first, center
      hero routes back via `onOpenProject`/`onCreateProject`). `:root` flipped to a **dark** Codex
      workspace with a **near-monochrome accent (no purple)**; the sidebar keeps its light scope
      (now also overriding surface tokens + inverting the accent). New `AgentDrawer.tsx` hosts the
      Olympus/Atlantis terminals, **always mounted while a project is active** (toggle = CSS
      transform, so closing never kills agents); `TerminalPane.onStatus` bubbles agent readiness to
      a header status chip. ChatPanel: hero empty states + centered conversation column + large
      integrated dark composer (route/Repo/Auto-Enter/Suggest/Show agents/Send). `MacroLoopPanel`
      engine unchanged but rendered inside the composer, collapsed by default, compact.
      Screenshot: `docs/validation/phase13-1-ui.png`.
- [x] **Phase 13.2** — chat workflow polish + agent output feedback. **Agent→chat summaries:**
      new sessionless `agent:summarize` IPC (`macro.ts` `summarizeAgentOutput`) reads a read-only
      terminal snapshot + summarizes via `sendMetaPrompt` (meta, **no `usage_event`**) with
      heuristic fallback and a "no meaningful output" signal; `window.api.agent.summarize` exposed.
      ChatPanel auto-summarizes once 6s after a bridge send (deduped by `signature`) + a manual
      "Summarize output" chip; result appended as a `.is-summary` card (source = Olympus/Codex or
      Atlantis/Claude). **Drawer:** width-resizable (`akorith.drawerWidth`) + independent
      Olympus/Atlantis collapse (`TerminalPane.collapsed`/`onToggleCollapse`, host hidden so PTY
      survives). **Composer focus** = subtle border + bg lift (no ring). **Dashboard colors** by
      identity (Claude orange / Codex blue / Local purple); **heatmap** = GitHub-style 11px squares
      + green ramp. **Chat spacing** = centered max-720 column with padding. **Sidebar brand** =
      text only (logo removed). **New icon** from `~/Downloads/newakorithlogo.png` → `assets/`
      + regenerated `build/icon.{icns,ico,png}`. Screenshot: `docs/validation/phase13-2-ui.png`.
- [x] **Phase 13.3** — usability fixes. **Per-project agent sessions:** PTY keyed
      `t1::<projectId>`/`t2::<projectId>`; `pty.setActiveProject` maps the logical bridge targets;
      `PtyManager.create` reuses live sessions for the same cwd/command (no kill+respawn),
      `TerminalPane` detaches (not kill) on unmount and replays the snapshot on re-attach; bounded
      to 3 recent projects; single write path unchanged. **Terminal restore bar** for collapsed
      Olympus/Atlantis. **Test Lab simple mode**: project/repo selector + test-type dropdown,
      Local/Ollama generation, auto-detected runner details collapsed, and Claude/ChatGPT scoring
      as the explicit ISAScore step. **Macro loop**:
      "Repo context" + help line, advanced settings collapsed, "Plan with loop" / "Start Auto
      loop", Stop visible. **Small UI**: recent-chat dots removed, collapsed profile centered.
- [x] **Phase 14** — project/chat separation and activity fixes. **Navigation:** `Workspace`
      is project-scoped orchestration; new `Chat` route is general provider chat with
      `project_id = NULL`, no project header, no agent controls, and `includeDigest: false` so repo
      context cannot leak into general chats. **Project switching:** selecting a project opens
      Workspace and restores its newest project session, or a clean project workspace if none
      exists; Recent Chats restores either Workspace+project or General Chat correctly. **Activity
      drawer:** Olympus/Codex and Atlantis/Claude are always represented for active projects, with
      independent collapse/restore bars and clear Starting/Live/Exited states. **Sidebar IA:**
      Projects → provider folders (general chats) → scrollable Recent Chats → fixed profile.
      **PDF export:** evaluation reports save to Downloads as `akorith-...pdf`, show exact path,
      and expose Reveal/Open for current and past evaluations.
- [x] **Phase 14.1** — chat workflow + Test Lab reliability fixes. **Sidebar:** the separate `Chat`
      nav item is removed; a **New chat** action sits above `Workspace` (order: New chat · Workspace ·
      Dashboard · Test) and always opens a *fresh* general chat with the default provider.
      **Model switcher:** provider/model selects wrapped in a labeled pill in the top bar (more
      visible). **Scroll:** conversation auto-scrolls only when the user is near the bottom
      (`nearBottomRef`); reading history is never interrupted. **Readability:** 15px chat text,
      polished code/prompt blocks; workspace dark surfaces and the Test sandbox output lifted a notch
      lighter. **Permission card:** read-only `agent:detectPermission` IPC + a 4s poll surface a
      terminal confirmation prompt as answer buttons in chat; answers go through the existing
      `bridge.send → PtyManager.write()` (no second write path); permanent "always allow" is never
      auto-selected. **Agent summary:** auto-summary now polls the terminal until output stabilizes
      (≤45s) before summarizing once into the active chat (meta call, no usage_events). **Test Lab:**
      new `test:context` (`buildRepoContext`) feeds a real source-file tree + sample files into the
      generation prompt with framework-specific rules; a **Repair & rerun** button fixes a failing
      test and reruns once; pytest detection now requires real Python evidence (no more mis-detecting
      a JS repo with a `tests/` dir). **Validation:** `scripts/testlab-validation.ts` →
      `docs/validation/testlab-10-run-validation.md` (12 real runs: 10 pass, 2 brittle→repaired,
      across pytest/vitest/jest). **PDF export unchanged.**

- [x] **Phase 14.2** — conversation memory + context reliability. **Root cause:** `chat:send`
      sent only the current prompt to `provider.send()`; prior session messages (persisted per
      session) were never read back, so single-shot CLIs had no memory and the model claimed
      "first message." **Fix:** new electron-free `src/main/conversation.ts` assembles the
      session transcript; `chat:send` loads `getSessionMessages` (strictly `WHERE session_id = ?`)
      before persisting the new turn and frames it as an ongoing conversation. **Bounded policy:**
      recent turns verbatim (≤24 msgs / ≤48k chars, always keep newest); older turns compressed
      into a cached `sessions.context_summary` via `sendMetaPrompt` (meta call, no usage_event),
      regenerated only when the older window grows. **Indicator:** `chat:contextInfo` powers a
      `Memory: N msgs · summarized K · Repo on` chip under the composer + a two-click **Reset
      context** (`history:clearMessages`, current session only). **Agent summaries:**
      `agent:summarize` takes the active `sessionId` and persists the summary into that session's
      memory (still a meta call). **Separation:** memory is keyed only by `session_id` → no
      cross-chat/cross-project leakage; New Chat = fresh session; restore reloads real memory.
      **Validation:** `scripts/verify-conversation-context.ts` + `scripts/memory-behavioral-check.ts`
      (4/4 against the real `claude` CLI) → `docs/validation/conversation-memory-validation.md`.

- [x] **Phase 14.3** — sidebar cleanup + bridge auto-enter fix. **Auto-Enter:** `Send to
      Atlantis/Olympus` previously appended `\r` to the same chunk as the bracketed paste; the
      claude/codex TUIs swallow that `\r`, so the prompt pasted but never submitted. Encoding now
      lives in electron-free `src/main/bridge-core.ts` (`encodeForPty`, `planBridgeWrites`,
      `SUBMIT_KEY`); `bridgeSend` writes the paste, then writes the Enter as a **separate** keystroke
      after `SUBMIT_DELAY_MS` (90ms) — still only through `PtyManager.write()` (no second write path).
      Auto-Enter OFF writes the paste only (manual Enter preserved). Covers message-level send,
      composer send-to-agent, macro-loop approval send, and permission-answer send.
      **Projects:** each project row has a `⋯` overflow menu (Rename · **Remove from Akorith**).
      `projects:delete` → `deleteProject(id)` removes the project row + its workspace chats from the
      DB **only** (folder on disk untouched); a confirmation modal states this. Removing the active
      project falls back to a clean no-project Workspace. **Recent chats:** each entry has a
      two-click **Delete** (`history:delete`, messages cascade); deleting the active chat opens a
      clean state. **Projects list:** the `All projects` row is removed — the list shows only real
      projects; the folder header, `+` menu, and empty-state Open/Create remain.
      **Collapsed sidebar:** the bottom profile icon was being shoved right by `margin-left:auto`
      (it is the lone `svg:last-child`) and dimmed; collapsed-mode CSS now re-centers it and matches
      the nav-item sizing. **Verification:** `scripts/verify-bridge-autoenter.ts`.

- [x] **Phase 14.4** — chat scroll reliability + sidebar project polish. **Chat scroll (root
      cause):** two stacked rules made `.chat-messages` a `flex-direction: column` +
      `justify-content: center` scroll container; when content was taller than the viewport (a large
      code/prompt block) vertical centering pushed the **top out of the scrollable range**, so older
      messages above the block were unreachable. Fix: `.chat-messages` is now `display: block`
      (the inner column self-centers with `margin: 0 auto`), `overflow-anchor: none`, extra bottom
      padding so the last turn clears the docked composer, and code blocks are bounded
      (`max-width: 100%`, `overflow-x: auto`/`overflow-y: hidden`) so a long line never blocks
      vertical scroll. Restore still lands at the bottom and scrolls fully up. **Project menu:** the
      `⋯` menu was clipped by the list's `overflow-y: auto`; it now renders **fixed-position**
      anchored to the button rect (`getBoundingClientRect`), closes on backdrop click / **Escape**,
      and adds **Reveal in Finder** (new read-only `projects:reveal` → `shell.showItemInFolder`) next
      to Rename · Remove from Akorith. **Project list visual:** rows are a clean folder list now —
      `FolderIcon` + name + muted path, no avatar/letter card; active = subtle gray, hover subtle,
      `.project-row`. **UI scale:** `webContents.setZoomFactor(1.1)` on `did-finish-load` enlarges the
      whole UI ~10% uniformly (layout reflows, nothing clipped) — one central knob instead of
      per-component font bumps. **Validation:** `docs/validation/chat-scroll-validation.md`.

- [x] **Phase 14.5** - UI changes + Windows icon / local-provider fixes. Windows packaged builds
      now include `build/icon.ico`, prefer it for the BrowserWindow icon, and the runnable unpacked
      exe/shortcuts can be stamped to show the Akorith icon. Local/Ollama availability now falls
      back from `localhost` to `127.0.0.1`; the user config can point directly at loopback. Claude
      dashboard usage no longer counts `cache_read_input_tokens` as fresh prompt tokens, preventing
      tiny messages from showing huge token totals. Select dropdown options are readable on Windows
      native popups, and the app font/readability pass slightly enlarges chat, controls, sidebar,
      code, and terminal text. **Validation:** `npm run typecheck`.

- [x] **Phase 14.6** - sidebar + chat polish. Recent chat and provider-folder row actions now
      overlay the row instead of entering layout on hover, so rows underneath no longer shift. The
      fresh general-chat empty state greets the local display name (`Welcome back, Ibrahim`). The
      collapsed sidebar shows the Akorith mark instead of a plain `A`. Assistant messages render
      lightweight Markdown-style prose (`**bold**`, inline code, ordered/unordered lists) so model
      output looks cleaner without changing provider behavior. **Validation:** `npm run typecheck`.

- [x] **Phase 14.7** - logo, sidebar scroll, and copyable output polish. The collapsed sidebar now
      uses the current PNG Akorith app icon (`src/renderer/public/akorith-logo.png`) instead of the
      older inline mark. The lower sidebar scroll region now starts at Projects and includes provider
      folders plus Recent Chats as one continuous scroll area above the fixed profile. Fenced
      assistant blocks always show a **Copy** action in both General Chat and Workspace; Workspace
      still keeps its Send-to-agent action. Copyable/code blocks are lighter and larger for better
      readability. **Validation:** `npm run typecheck`.
- [x] **Phase 15** - theme toggle. Persisted Light/Dark selector in Sidebar Settings via
      `akorith.theme`, `data-theme` on `.app`, and token-first `--sidebar-*` / workspace colors.
      Terminals and agent activity remain intentionally dark-scoped.
- [x] **Phase 15.1** - local-provider/workspace-context reliability. Local/Ollama auto-start +
      optional LAN bind, main-trusted session project context for Workspace prompts/digest,
      medium-risk Codex workspace-trust detection, safer permission-card fallback actions, Test Lab
      preset/ISAScore polish, and Windows-safe verifier updates. **Validation:** `npm run
      typecheck`, `npm run build`, `scripts/verify-{bridge-autoenter,agentic-loop,conversation-context,testlab}.ts`.
- [x] **Phase 16** - GitHub Test Lab, LAN Ollama discovery, and image chat attachments. Test Lab
      accepts GitHub repo URLs and clones them into a managed cache; fallback Vitest writes a
      sandbox alias config for `@/` imports; Local/Ollama can scan the private LAN for a host PC's
      exposed models; chat supports image attachments, with real pixels sent to Ollama multimodal
      models. **Validation:** `npm run typecheck`, `npm run build`, `scripts/verify-testlab.ts`.
- [x] **Phase 17** - Ollama startup. Local/Ollama can auto-start `ollama serve` for loopback
      configs, with conservative PATH/executable discovery and graceful unavailable-provider UI.
- [x] **Phase 18** - MacBook + PC integration. Akorith supports a stronger PC hosting Ollama while
      a MacBook points Settings -> Ollama endpoint at a reachable LAN/VPN/Tailscale endpoint.
- [x] **Phase 18.1-18.3** - friendlier connection settings and errors. Settings shows shareable
      local/LAN/VPN endpoints, and off-network LAN failures explain the same-Wi-Fi vs Tailscale
      fix instead of surfacing raw fetch errors.
- [x] **Phase 19** - closed-loop critic/verifier. After each executor summary, a critic grades
      actual progress against the goal and feeds gaps into the next plan.
- [x] **Phase 20** - autonomous workspace loop. Loops scaffold their own git working folder,
      auto-commit each change as `Phase N: <change>`, and track a meta-call token budget.
- [x] **Phase 20.1-20.2** - one-click loop setup and SWC renderer transform. The create/open/start
      sequence was streamlined, and `@vitejs/plugin-react-swc` replaced the renderer transform.
- [x] **Phase 21** - dedicated Loop section. Autonomous loops moved out of the chat composer into a
      top-level, card-based, non-technical Loop page.
- [x] **Phase 22** - fully automatic loop with steering. The loop keeps running instead of
      dead-pausing on soft signals, exposes three steering chips, and records the user's chosen
      direction for the next planner turn.
- [x] **Phase 22.1** - no permission stalls for headless loops. The hidden loop executor uses
      `claude-auto` / `codex-auto` command kinds in its own generated workspace, while user-facing
      workspace agents stay interactive.
- [x] **Phase 23** - general-purpose task loops. The user's prompt is the goal, so loops can do
      research, monitoring, or building; planner prompts are task-agnostic and tell the executor to
      maintain a results/artifact file.
- [x] **Phase 23.1** - Fully Active/Passive Loop Switch. The Loop section has a Fully loop
      Active/Passive control; Active starts/keeps Auto Mode running, while Passive leaves the loop
      idle until the user resumes it.
- [x] **Phase 23.2** - Loop Operations Center. Loop is now the product home for autonomous
      workflows: templates, natural-language creation, targets, schedules, autonomy levels,
      stop limits, commit/push/report controls, safety settings, model/executor choice, detailed
      run timelines, audit trail, reports, archive/remove actions, and persistent Loop-native
      storage (`loop_targets`, `loop_runs`, `loop_events`, `loop_templates`, `loop_artifacts`,
      `loop_reports`) layered onto `macro_sessions`.
- [x] **Phase 24** - Loop Completion. Loop workspaces live under `~/Documents/AkorithLoop`, use
      `https://github.com/saitakarcesme/AkorithLoop.git`, force `push_enabled=true` for
      commit-producing loops, show GitHub sync health in Loop detail, expose manual Sync to
      AkorithLoop, and render persisted `loop_runs` / `loop_events` as Run ledger and Event log.
      `npm run verify:workspace-loop` validates Phase-N commit numbering and workspace inspection.
- [x] **Phase 25** - Test Lab Rebuild. Test Lab is a guided source -> Local test writer ->
      selectable subject -> Local/Claude/ChatGPT judge -> run-and-PDF flow. Folder picker and
      GitHub URL sources share read-only sandboxing; generated tests auto-run, auto-score, and
      auto-export an Akorith Test Report PDF. Runner details remain collapsed for detection misses.
- [x] **Phase 26** - Settings Center. The sidebar profile opens a tabbed settings surface for
      Profile, Providers/Ollama, Workflow, Test Lab, and Data; writes still go through validated
      main-process IPC (`settings`, `ollama`, `bridge`, `digest`, `test:setSettings`).
- [x] **Phase 27** - Local Executor Loop. Loop can use a Local/Ollama model as a structured
      workspace-patch executor instead of a Claude/Codex PTY. Local attempts are parsed,
      path-validated, applied with rollback, validated by allowlisted commands, scored, and only
      then committed as the next phase. Attempts, validated changes, and commits are separate.
- [x] **Phase 57** - Durable Goal Cycle + Chat Isolation. Goal completion is evidence-based across
      Understand/Plan/Execute/Analyze/Replan; Loop UI is a quiet concurrent diagram; General Chat
      and Workspace activity are separate; active request/Stop state is scoped by session.
- [x] **Phase 58** - Codex-Parity Chat + Durable Attachments. General Chat and Workspace render
      rich Markdown and durable files; Workspace adds Plan, Queue, project-file mentions, real
      Changes, task search/pins, and per-session streaming/navigation continuity.
- [x] **Phase 69** - Autonomous Research. A first-class Research sidebar surface runs concurrent,
      unattended CLI-model investigations across four depth modes, persists evidence/checkpoints,
      and publishes validated PDF, Markdown, DOCX, XLSX, or PowerPoint artifacts with A4 Library covers.
- [x] **Phase 70** - Research Presentation, Unified Usage & Sidebar Alignment. Research adds native,
      editable PowerPoint output; Dashboard accounting includes idempotent Research requests and
      model tokens; and the sidebar brand shares the navigation icon/text columns.
- [x] **Phase 23 validation** - biggest test step. `docs/validation/phase23-biggest-test-step.md`
      records the full product combination matrix, passing automated checks, blocked Local/Ollama
      live cases while the home PC is off, remote model connection steps, and the build-freshness
      findings.

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
- **Test Lab Rebuild (Phase 25):** keep the primary flow English and selection-based. The user
  chooses source, Local/Ollama writer model, fixed test subject preset, and Local/Claude/ChatGPT
  judge; one main action runs, evaluates, and exports PDF. The source repo remains read-only, and
  generated tests write only to the temporary sandbox. Do not reintroduce a mandatory free-form
  test-topic field.
- **Settings Center (Phase 26):** the renderer may present many controls, but each write stays
  behind its existing validated IPC owner. Do not add direct renderer filesystem writes, provider
  sends, terminal writes, or secret storage from Settings. Test Lab defaults are persisted only via
  `test:setSettings`, whose main-process setter clamps values before writing config.
- **Macro-loop: Approval Mode is the default and is unchanged.** Planner proposals are meta
  calls and do not write `usage_event`; the user approves or edits each executor prompt before
  it is sent through the bridge path.
- **Loop Operations Center (Phase 23.2):** `macro_sessions` is still the compatibility spine, but
  Loop metadata now records type, target, schedule, stop limits, commit/push/report behavior,
  safety level, latest result, run count, next run, and archives. Automatic actions mirror into
  `loop_events`; each Auto cycle records a `loop_runs` row with summary, changed files, commands,
  validation result, commit messages, next step, and errors. Remove deletes the Loop record only,
  never the workspace folder. Existing local-project targets are bound conservatively with no
  scaffold/write on bind; fresh Loop projects still scaffold under Akorith Projects.
- **Loop completion (Phase 24):** all loop output is GitHub-auditable under AkorithLoop.
  `workspace.ts` owns `inspectLoopWorkspace()` and `syncAndPushLoopWorkspace()`; renderer calls
  only validated macro IPC (`macro:inspectWorkspace`, `macro:syncWorkspace`, `macro:listRuns`,
  `macro:listEvents`). The main process normalizes commit-producing loops to `push_enabled=true`
  and pushes Phase 0 plus every later `Phase N: ...` commit. Manual sync repairs the origin URL,
  pulls/rebases with autostash, pushes to `main`, and records a loop event.
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
  packaged artifacts. Icons live in `build/` (`icon.icns`/`icon.ico`/`icon.png`). The macOS-native
  rounded look (rounded-square body, ~100px padding, transparent corners, subtle contact shadow) is
  composed from the source logo by a Swift/CoreGraphics step, and that same rounded 1024² master is
  written to `assets/akorith-logo.png` (the runtime dock icon — `app.dock.setIcon` overrides the
  bundle icon while running, so it must be rounded too) before `sips`/`iconutil` generate the full
  iconset → `.icns` and a dependency-free Node packer writes the multi-size `.ico`. The text-only
  sidebar/header brand mark and the SVG favicon are intentionally separate and left as-is.
- **Packaged GUI PATH.** `ensureCliPath()` in `main/index.ts` prepends static well-known bin dirs
  (Homebrew/user) to `process.env.PATH` so Finder-launched apps resolve `claude`/`codex`/`ollama`.
  Static dirs only — never spawn a shell or eval to discover PATH.
- **Sidebar local UI state (9.1.3).** Provider folders default collapsed and persist in
  `localStorage` `akorith.providerCollapsed` (absent = collapsed); join the existing
  `akorith.*` localStorage keys (sidebar collapse, terminal split, etc.). Provider groups must stay
  visible-but-collapsed — never removed.
- **Theme is token-first (Phase 13.1).** Change colors via the `:root` tokens, not per-component
  literals. The app is now a **dark Codex-style workspace** with a **light/white sidebar**
  (`.sidebar` overrides text + surface + accent tokens so nothing dark leaks in). Accent is
  **near-monochrome (no purple/indigo)**; keep it restrained. Provider colors are tiny dots/chips
  only — no color blocks. The agent drawer / `.chat-code` / `.test-terminal-col` are dark surfaces.
- **Chat-first layout (Phase 13.1 + 14).** `Sidebar | ChatPanel` + `AgentDrawer` overlay.
  `Workspace` is project-scoped orchestration; `Chat` is general model chat with no project context.
  Terminals are hidden by default in the drawer, which is **always mounted while a project is
  active** (toggle = CSS transform) — never unmount it or agents die. Project open/create is
  **sidebar-first**; do not reintroduce a right-side onboarding/terminal column.
- **Workspace continuity (Phase 13).** Last active project id is persisted to
  `localStorage` `akorith.lastActiveProjectId` and restored on launch; restoring re-starts agents
  **only** via the existing safe PTY startup (logged-in CLI in the project cwd, never destructive),
  visibly. No new auto-run of arbitrary commands on restore.
- A session belongs to **one** provider; switching provider starts a new session context.

## Phase 15 - Theme Toggle

`App.tsx` owns `akorith.theme` (`dark` or `light`) in `localStorage` and applies it as
`data-theme` on `.app`; Sidebar Settings exposes the segmented Light/Dark control. Light mode keeps
the navigation white and uses lifted grays for the workspace. Dark mode makes the former white
navigation dark gray and pushes workspace gray surfaces toward black while preserving readable text
and controls.

Keep future theme changes token-first through `--bg-*`, `--text-*`, `--sidebar-*`, and code-block
variables. Terminals and agent activity scopes remain intentionally dark unless a later Phase 15.x
changes that.

## Phase 15.1 - Local Provider + Workspace Context Reliability

Local/Ollama can auto-start `ollama serve` for loopback configs (`autoStart`, default true).
`exposeLan` binds auto-started Ollama to `0.0.0.0:11434`, while remote `baseUrl`s are only probed.
Config values are sanitized, `localhost` still falls back to `127.0.0.1`, and Windows common
install paths such as `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` are checked when Electron's PATH
cannot see `ollama`.

Workspace provider prompts now include project scope from the persisted session's stored project,
not from renderer-supplied path data. `chat:send` derives this with `getSessionProjectContext()`;
repo digest for Workspace chats uses that validated project path, preserving General Chat
separation and preventing spoofed IPC from digesting arbitrary folders.

Codex-style trust-folder/workspace prompts are detected as medium-risk access prompts in
`agentic-core.ts` and require review. Do not answer them in PTY startup; any response must go
through the permission UI / Auto Mode policy and the existing `bridgeSend -> PtyManager.write()`
path.

Test Lab is intentionally narrow: choose repo, choose test type, generate tests with Local/Ollama,
then score selected runs with Claude or ChatGPT to produce ISAScore. Repo input accepts local paths
or GitHub repo URLs; GitHub URLs clone into the managed `testlab-github-repos` cache and then use
the same read-only snapshot/sandbox path. JS/TS repos with `package.json` but no runner fall back
to `npx --yes vitest run` instead of blocking as unknown. Runner details stay in a collapsed escape
hatch; multi-model comparison and quality toggles are out of the primary flow. The Test Lab
verifier is Windows-safe (`node -e` timeout fixture, `execFileSync` git status, `readdirSync`
prune count).

Claude visible token usage uses direct `input_tokens` only; cache creation/read counters stay in
the raw provider payload, but no longer inflate the UI badge. Recent chats are title-only,
assistant responses have a whole-message copy action while streaming/done, chat scrolling avoids
per-scroll React state churn, and startup shows a small Akorith splash over the purple/green
marbled background.

## Phase 16 - GitHub Test Lab + LAN Ollama + Image Chat

The screenshot failure was an import-resolution failure, not a failed assertion: fallback Vitest
had no alias config for `@/lib/slugs`, so no tests executed. Fallback JS/TS detection now uses
`npx --yes vitest run --config akorith.vitest.config.mjs`, and `runTests()` writes that config into
the sandbox with `@`/`~` mapped to the repo root.

Test Lab repo input accepts local paths or GitHub repo URLs (`https://github.com/owner/repo`,
`github.com/owner/repo`, `git@github.com:owner/repo.git`). Main validates GitHub-only refs, clones
with `git clone --depth 1` into `userData/testlab-github-repos`, then uses the existing read-only
snapshot/sandbox flow.

Local/Ollama defaults now enable LAN binding and discovery. Host Akorith auto-starts Ollama with
`OLLAMA_HOST=0.0.0.0:11434`; client Akorith instances scan private IPv4 `/24` LANs for `/api/tags`
when localhost is unavailable. If the host Ollama was already running localhost-only, restart
Ollama/Akorith once so it can bind to LAN.

Chat composer image attachments support up to four PNG/JPEG/WebP/GIF files. Local/Ollama receives
base64 image bytes for multimodal models; Claude/Codex CLI providers receive only attachment-name
text because their current provider bridge is stdin text.

## Phase 25 - Test Lab Rebuild

Phase 25 supersedes the older narrow Test Lab wording: Test Lab is now a guided, selection-based
flow designed for non-technical users. The happy path is source selection -> Local/Ollama test
writer -> fixed test subject preset -> Local/Claude/ChatGPT judge -> run and PDF export. Sources
can be saved Akorith projects, folder picker selections, or GitHub repository URLs. Test subjects
are buttons/dropdowns, including General coverage, API/logic, UI/interaction, regression/smoke, and
edge cases; a user should not need to type a test topic to get useful coverage.

The source repo remains read-only. Akorith copies local folders and GitHub clones into its temporary
sandbox before writing generated tests, installing dependencies, or running a command. Auto-detected
runner details stay collapsed for detection misses and advanced overrides. The primary action keeps
the UI running through generation, execution, scoring, and PDF export so the report path appears as
part of the same flow.

The PDF template is now intentionally readable and branded as an Akorith Test Report. It contains a
dark report header, verdict and ISAScore, source/judge/generated metadata, objective metrics, run
evidence, score breakdown, judge rationale, generated test code excerpts, and bounded sandbox output
excerpts. Historical runs can still be re-scored and exported from Review and PDF.

## Phase 26 - Settings Center

The old profile popover is now a Settings Center mounted from the sidebar footer. It has Profile,
Providers, Workflow, Test Lab, and Data tabs. Profile owns display name and theme; Providers shows
registry availability and the full Ollama endpoint/LAN/VPN controls; Workflow owns bridge
Auto-Enter, repo-context enablement/path, and read-only AkorithLoop remote/folder status; Test Lab
owns default source, install-deps, timeout, retained sandboxes, and report identity; Data documents
the local storage and sandbox boundaries.

The implementation intentionally centralizes UI without centralizing unsafe authority. Theme still
uses `settings:*`; Ollama still uses `ollama:*`; bridge Auto-Enter still uses `bridge:*`; repo
context still uses `digest:*`; and Test Lab defaults now use `test:setSettings`. The main-process
`setTestSettings()` clamps timeout, retained sandboxes, source length, and provider id before
writing `loopex.config.json`. Folder pickers still go through `projects:pickDirectory`.

## Phase 27 - Local Executor Loop

Phase 27 makes Local/Ollama models first-class loop executors without giving them raw shell
control. A local executor returns strict `workspace_patch` JSON. `src/main/local-executor.ts`
parses it, blocks absolute/path-traversal/protected paths, applies full-file changes inside the
workspace with rollback data, runs only allowlisted validation commands with timeouts, strips ANSI
from evidence, and produces a deterministic score for valid JSON, patch application, validation,
meaningfulness, goal alignment, scope, and spam/churn.

`macro_sessions` now records `executor_type`, `executor_provider`, `executor_model`, and the last
attempt/validation/commit summaries. `runAutoLoop()` branches by executor type: `pty` keeps the
Claude/Codex terminal path; `local` asks the selected Ollama model for a structured patch, records
an attempt in `macro_turns`/`loop_runs`, rolls back failed or low-value attempts, commits only
successful meaningful validated changes via path-scoped `commitPhase()`, never pushes
automatically, and pauses after repeated local failures. The Loop UI now shows executor mode,
local model, attempts, validated changes, commits, last validation, and last commit separately.

## Phase 57 - Durable Goal Cycle + Chat Isolation

- Loop owns a task-agnostic Goal contract and repeats **Understand -> Plan -> Execute -> Analyze ->
  Replan** until every acceptance criterion has concrete evidence. One commit is progress, not
  completion. Blockers and three stalled cycles enter `needs_review`.
- Multiple Goals remain concurrent through the existing per-loop AbortControllers and separate
  SQLite runs/events/backlogs. The renderer shows compact Goal tabs, a low-color flow diagram,
  current phase, definition of done, and four recent evidence checkpoints.
- The selected folder is the only work boundary and can contain code, research sources, PDFs,
  DOCX/Markdown, or other generated artifacts. Local commits checkpoint work; automatic push stays
  disabled.
- General Chat never renders Workspace activity. Request/Stop state and in-flight message buffers
  are session-scoped, so switching chats/projects cannot carry a Stop icon into the wrong view.
- Workspace running labels animate with their icons; stable explanatory paragraphs are longer and
  readable. The fixed Step chip reveals all six steps on hover/focus. Code blocks are theme-aware.
- Verification: `npm run verify:goal-cycle`, `npm run verify:project-loop`, `npm run typecheck`,
  `npm run build`, plus Electron CDP checks for General Chat separation and Stop-state switching.

## Phase 58 - Codex-Parity Chat + Durable Attachments

- General Chat is a clean ChatGPT-style surface; Workspace is the project-scoped Codex-style
  surface. Raw terminal output stays hidden and the selected CLI runs headlessly.
- Message attachments are copied to an Akorith-owned userData directory, capped at 8 files,
  16 MB each, and 40 MB per turn. Metadata persists with history, original files are never
  modified, and session deletion/reset removes only the managed copy. Raw HTML is not enabled in
  Markdown rendering.
- Active requests, streaming buffers, message caches, Stop state, and follow-up queues are keyed by
  session. Navigation can never transfer a running control or hidden Plan intent to another task.
- Workspace provides five explicit Codex-parity capabilities: queued follow-ups, bounded `@`
  project-file search, read-only Plan mode, project-scoped Changes with Stage/Unstage, and task
  search/pinning. Changes may act on one validated project-relative path; it never reverts,
  commits, pushes, or edits file content.
- `resolveCliExecutable()` prioritizes normal user CLI install paths before Electron's bundled
  runtime path, preventing a stale embedded executable from shadowing the signed-in CLI.
- `product-polish.css` is imported last and owns the final shared dark/light/responsive product
  layer. Keep surfaces, controls, code, attachments, and narrow layouts consistent there.
- Verification includes typecheck/build, all repository verification scripts, production audit,
  Electron CDP navigation/streaming checks, Plan no-write, Queue order, `@` mentions, real Changes,
  search/pin, Markdown/GFM, PDF/image attachments, light/dark themes, and 1100 px responsive pages.

## Phase 59 - Live Profile, Completion Receipts, and Local Tool Plugins

- Dashboard identity is the handwritten display name over a translucent gray copy of live CPU
  history. Do not restore the profile avatar or colorize this backdrop. The existing lower Compute
  chart stays intact.
- The 53-week token grid, month labels, Token activity heading, and Daily label share one full-width
  content measure. Keep all 371 cells and edge-safe tooltips.
- Completed replies persist their receipt metadata in the additive `messages.metadata` column.
  General Chat shows model/token/time; Workspace can additionally show bounded Git-derived file and
  line deltas captured around the turn.
- Git completion telemetry is read-only and accepts only a stored, managed project path. It never
  stages, reverts, commits, pushes, or grants new filesystem authority.
- Fifteen audited CLI manifests extend Plugins: Git, ripgrep, jq, SQLite, FFmpeg, Pandoc, Poppler,
  ImageMagick, Tesseract, Graphviz, Python, Node.js, Git LFS, ShellCheck, and yt-dlp. Static version
  diagnostics are the only automatic process calls; Akorith never auto-installs tools.
- Only enabled manifests with a successful diagnostic and an audited capability hint enter
  Workspace/Goal prompts. Missing, planned, unavailable, and disabled plugins remain UI-only.
- Verification requires typecheck/build, Workspace/OpenCode/update verifiers, release check, and
  Electron CDP checks for Dashboard geometry, completion receipts, 24 plugin rows, status counts,
  broken images, and overflow.

## Phase 60 - Restored Profile + Authentic Plugin Identity

- Phase 60 supersedes the Phase 59 Dashboard identity presentation: the stored profile photo is
  visible again, the username uses the standard product type, and `@local · Akorith` is restored.
- Token activity uses the previous compact 820 px measure and fixed calendar cells. The lower
  Compute usage graph remains; there is no second CPU graph behind the username.
- Each of the 15 local CLI additions maps to its own authentic upstream product asset. Do not use
  generated initials, the Akorith mark, or a generic repository placeholder for these tools.
- Logo provenance lives beside the assets in `plugin-logos/SOURCES.md`. Build and live verification
  must assert all 24 rows have images and no image has failed to decode.
- Verify typecheck/build, plugin diagnostics, Dashboard structure and computed geometry, Plugins
  images, release metadata, and the packaged Electron app before shipping.

## Phase 61 - Quiet Loop Surface + Visual Workspace Flow

- Keep concurrent Goal tabs and New tab. The active Loop uses one flat five-phase stepper and one
  current-phase explanation; progress and definition of done share a disclosure instead of nested
  permanent cards. The composer remains the stable bottom action surface.
- Chat titles and their controls never overlap. Project and general chat rows reserve a 64 px
  icon-action column for pin, rename, and two-click delete; project overflow is also an SVG icon.
  Every icon-only action needs an accessible label and tooltip.
- Workspace diagrams are contextual receipts derived from actual activity. Show a flow only after
  three distinct stages emerge; keep short responses as natural prose and never infer execution
  authority from the renderer diagram.
- Verify typecheck/build, Workspace/Goal/Project Loop scripts, wide and 891 px Electron CDP views,
  icon action geometry, and absence of horizontal overflow.

## Phase 62 - Aligned Profile Telemetry + True Loop Topology

- Keep the profile photo and identity line. The username uses macOS SignPainter with local script
  fallbacks to evoke the Apple welcome hand without shipping or downloading a font.
- The stat frame, Token activity heading, Daily edge, 53-column grid, and month row share one exact
  633 px measure. Responsive overflow belongs to the calendar shell, never the whole page.
- Loop is a directed diagram with six SVG connector paths, explicit review/return branches, and a
  separate Complete outcome. The phase state still comes from the durable Goal engine.
- Benchmark uses deliberate type hierarchy: important content is more legible while technical
  metadata stays compact. Avoid indiscriminate global font scaling.
- Verify typecheck/build, Workspace/Goal/Project Loop and update-version scripts, wide/narrow CDP
  geometry, local font loading, six diagram paths, and no page-level horizontal overflow.

## Phase 63 - Fluid Loop Topology + Current Website

- Loop's 700-unit SVG coordinate system scales into the available content width. Phase and outcome
  nodes use the same proportional geometry, so connectors remain aligned without a local scrollbar.
- Narrow containers compact the node chrome and ellipsize labels; neither the diagram nor the page
  may gain horizontal overflow.
- AkorithWeb keeps its established design system while presenting the current Workspace, durable
  concurrent Loops, Dashboard, Benchmark, Plugins, Settings, download, and update capabilities.
- Retired desktop Agents/Companions surfaces are not exposed as current product navigation. The
  separate website must pass lint/build plus desktop/mobile route and interaction verification.
- Verify the desktop app with typecheck/build and Loop scripts, then verify AkorithWeb at 390 px and
  desktop widths, including Workspace completion receipts and responsive Loop topology.

## Phase 64 - Table Benchmark + Verified GitHub Loops

- Benchmark uses one compact active-comparison table and one saved-library table. The challenge
  selector stays at the upper-right and selected models remain pills; do not restore the matrix or
  oversized picker cards.
- Loop shows six connected state dots above a chat transcript and composer. These dots are a quiet
  view of the durable Goal state, not an execution source; the old SVG topology is retired.
- `Choose repository` accepts a clean GitHub URL and clones with authenticated `gh` into managed
  app data. Never persist credentials or accept GitHub branch/file URLs as repositories.
- Remote sync is opt-in per Loop and verifies that stored owner/repository equals `origin`. Pull
  with rebase before each cycle, commit locally, then normal-push with one rebase retry. Never force
  push; preserve a local commit and enter `needs_review` when push fails.
- Central `saitakarcesme/AkorithLoop` work is restricted to a unique named folder for each Goal.
- Verify typecheck/build, Goal/Project Loop/update scripts, wide/narrow Electron CDP layouts, and a
  real clone→commit→push smoke run without page-level horizontal overflow.

## Phase 65 - Narrated Loop Progress + Unified Activity

- Loop's transcript turns durable events into numbered Steps with concise titles and bounded
  explanatory paragraphs. Parse useful evidence from stored event detail, but never expose raw
  JSON as user-facing narration. Keep the six phase dots and bottom composer unchanged.
- A hidden sidebar must not make Loop content span the whole monitor; the header, tabs, surface,
  and detail transcript stay centered in a calm reading measure.
- Dashboard is opened from the footer identity and is removed from primary sidebar navigation.
  The adjacent gear independently opens Settings.
- Sidebar resize uses direct CSS variable painting inside one animation frame and one React state
  commit on pointer-up. Do not restore mousemove-driven full-app rerenders.
- Dashboard stacks local Token activity and public `saitakarcesme` GitHub activity on the same
  53-week measure. Main-process public GitHub HTML fetches are validated, cached, timeout-bounded,
  and non-fatal; the renderer has no GitHub credential or unrestricted network access.
- AkorithWeb's live replica mirrors the footer navigation, narrated Loop steps, and paired activity
  maps without replacing the site's established visual design.
- Verify app typecheck/build, GitHub load/fallback, Electron wide/collapsed geometry and sidebar
  drag, then web lint/build and desktop/mobile interaction plus horizontal-overflow checks.

## Phase 66 - Current Activity + Quiet General Chat

- The 53-week activity window ends on the Saturday containing today, so the current local date is
  always visible and the remaining cells in that final week are explicitly future cells. Token and
  GitHub maps reuse the same date array.
- Resolve the installed macOS `SignPainter-HouseScript` face by exact local names for the Dashboard
  username. Do not copy Setup Assistant/Hello vector resources or ship an unlicensed font file.
- General Chat renders assistant prose plus an icon-only copy affordance; completion receipts and
  diagnostic metrics remain Workspace-only.
- Every copy action uses the shared copy SVG with `aria-label` and `title`; copied state changes
  color/accessible text rather than changing button width.
- Loop detail, transcript, outcome, and composer share a single 700 px reading measure regardless
  of sidebar visibility. Verify equal geometry and no horizontal overflow.

## Phase 67 - Unified Profile Typography

- Dashboard identity uses the shared `--font-ui` stack rather than a dedicated handwriting face.
- Preserve the larger profile photo and display-name scale, but keep its weight and tracking aligned
  with Akorith's Avenir-led interface typography.
- Verify the production build and computed Electron font family after installation.

## Phase 68 - Permissioned Project Computer Use

- Workspace and Loop mount the same compact Computer Use surface for the active project, without
  changing General Chat. Users may reveal the directory, start an allowlisted declared web script,
  open the loopback URL, watch a live frame, move/click the pointer, type into a focused field, and
  stop the process.
- `src/main/project-preview.ts` owns all trust decisions: canonical project paths, declared-script
  inspection, loopback port allocation, `shell:false` process spawning, bounded logs, sandboxed
  offscreen rendering, loopback-only navigation, session-scoped input, and process-group cleanup.
- Renderer code must not receive a generic shell primitive or unrestricted browser target. Only
  `dev`, `start`, `serve`, and `preview` scripts are launchable, and external opening is restricted
  to the session's verified localhost URL.
- The Browser Computer Use reference was exercised against
  `~/Desktop/Projects/AkorithComputerUseLab`; the Akorith Electron smoke test then launched that
  project, streamed it in Workspace, typed into the real page, stopped it, verified its port was
  closed, and confirmed the same control appears in Loop.

## Phase 69 - Autonomous Research

- Research is independent from Chat, Workspace, and Loop. Its tabs keep concurrent investigations
  open; the Research/Library switch exposes active progress and the persistent book-style shelf.
- The composer takes one autonomous request, an explicit CLI provider/model, Quick (~10 minutes),
  Research (~1 hour), Deep (10+ hours), or Continuous depth, and PDF/Markdown/DOCX/XLSX output.
  Continuous jobs run until paused; bounded jobs follow plan -> research -> verify -> synthesize ->
  export and complete without asking follow-up questions.
- `src/main/research/` owns the durable state machine. Eight additive SQLite tables retain jobs,
  cycles, checkpoints, events, sources, claims, evidence links, and versioned artifacts. The
  scheduler caps concurrency at three, renews leases by heartbeat, recovers interrupted work after
  restart, and uses per-job cancellation for pause/resume/shutdown.
- Only public HTTP(S) evidence is fetched. SSRF guards reject credentials, unusual ports, and
  private/reserved addresses on initial and redirected URLs; acquisition also bounds redirects,
  time, host rate, bytes, and extracted text. Canonical URL/content deduplication, untrusted-source
  containment, explicit citations, and unsupported/conflicted claim states prevent invented proof.
- Renderer IPC accepts managed job/source/artifact IDs rather than filesystem paths. Each export
  receives a 794 x 1123 A4 cover and must pass format-specific structure, citation/package/sheet,
  formula-safety, size, and SHA-256 checks before Open/Reveal becomes available.
- Verification: `npm run typecheck`, `npm run build`, `npm run verify:research`, and
  `npm run verify:research-live:check`. Run `npm run verify:research-live -- --provider all --continuous`
  only for an intentional signed-in provider smoke test; add `--persist` only to retain those jobs
  in the real Library.

## Phase 70 - Research Presentation, Unified Usage & Sidebar Alignment

- The sidebar Akorith icon aligns with the Workspace icon column and its label aligns with the
  Workspace text column. Keep the brand centered on those columns in wide and narrow Electron
  layouts.
- `usage_events` remains an additive schema and now records cache read/write, reasoning,
  provider-canonical total tokens, `request_count`, and optional source identity. Every Research
  job contributes exactly one visible request; plan, cycle, and synthesis usage is included with
  `request_count=0`. Stable source IDs make live retries and historical backfill idempotent.
- PowerPoint (`.pptx`) is Research's fifth output. Production export uses JSZip/Open XML only and
  emits editable native 16:9 shapes, text, tables, and bar graphics with Unicode-safe content, a
  finding-led narrative, and a source appendix. Format validation checks package structure,
  relationships, slide content, and MIME before publication.
- `@oai/artifact-tool` is strictly an internal render/inspection tool for QA. Never make it an app
  dependency, vendor its private implementation, or distribute it in a release.
- The fixture matrix is 4 depths × 2 provider families × 5 formats = 40. Verification includes
  typecheck/build, Research/OpenCode/persistence suites, artifact-tool rendering,
  `slides_test.py`, and wide/narrow Electron checks for brand alignment and Research UI geometry.

## Rule: keep the docs current

At the **end of every phase**, update **both** `AGENTS.md` and this `codex.md` — flip the
checklist above, record the new state and any new invariants — then commit + push.
