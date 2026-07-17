# Akorith

**Akorith — a local-first Agent OS.**
**Think with Companions. Act with Agents. Build with Loop.**

Akorith is a cross-platform Electron desktop app with three first-class, local-first pillars:

- **Loop** — an autonomous local project builder. Give it an idea, a local repo, or a GitHub
  URL, and **local models** grow it over time with safe, validated commits.
- **Companions** — long-memory local personalities (**Athena**, **Zeus**). They talk and
  remember across every conversation. They **never take actions**.
- **Agents** — reusable local action shortcuts (organize a folder, repo health report,
  README/changelog, commit messages, …). Create once, run again, behind a permission policy.

Your existing Claude, Codex, OpenCode, and optional Ollama installations power the app through
their local CLIs. Akorith stores no provider API keys. Conversations, attachments, usage,
projects, and Goal state stay in local SQLite and the app's managed data directory.

```
┌────────────┬─────────────────────────────────────────────┐
│  Sidebar   │  General Chat: focused model conversation   │
│ projects   │  Workspace: Codex-style direct project work │
│ tasks      │  Loop · Dashboard · Benchmark · Plugins     │
└────────────┴─────────────────────────────────────────────┘
```

## What it supports

- **Claude** — via the `claude` CLI (your Claude subscription/login).
- **Codex / ChatGPT** — via the `codex` CLI (your ChatGPT login).
- **OpenCode** — via the `opencode` CLI (`opencode auth login`).
- **Local models** — via a local **Ollama** server when one is running (optional).

The same composer talks to whichever tools are installed and logged in. **General Chat** is a
clean, project-free conversation. **Workspace** runs the selected CLI headlessly inside one
project and streams its meaningful progress, commands, file changes, result, and elapsed time
into the conversation. Raw terminal output and Agent Activity are not part of the normal UI.

## Workspace vs Chat

- **New chat** starts a fresh ChatGPT-style conversation with no project context.
- **Workspace** is project-scoped. Pick a folder, choose one model, then inspect and change the
  project from the same Codex-style chat. Progress remains attached to the correct task while you
  navigate elsewhere.
- **Plan** makes a Workspace turn read-only and returns an ordered implementation plan.
- Type **`@`** in Workspace to search and insert a project file into the prompt.
- While a response is running, **Queue** stores a follow-up and runs it in the same task next.
- **Changes** shows real file-by-file diffs and explicit Stage/Unstage controls.
- **Search (`Cmd/Ctrl+K`)** and task pinning keep large project/chat histories manageable.

## Major surfaces

- **General Chat** — rich Markdown, tables, code blocks, images, and arbitrary local file
  attachments with durable history.
- **Workspace** — direct project editing, activity explanations, fixed Step progress, Plan mode,
  queued follow-ups, project-file mentions, diff review, and permissioned live project preview.
- **Loop** — concurrent long-running Goals with an Understand → Plan → Execute → Analyze → Replan
  evidence cycle that stops only when the Goal is reached or needs review.
- **Dashboard** — profile identity, compact 53-week token activity, local CPU/GPU telemetry,
  and connected-computer telemetry.
- **Plugins** — audited local-tool registry, original tool identity assets, and diagnostics.
  Fifteen optional free CLIs cover
  search, Git, JSON/data, documents/PDF/OCR, media, diagrams, runtimes, and shell validation;
  only installed + enabled capabilities enter Workspace/Loop context.
- **Controller API** — optional loopback-only, token-protected, read-only HTTP+SSE surface
  for companions/CLIs (Settings → API; see `docs/controller-api.md`).
- **Test Lab** — generate + run tests in a sandbox and export scored PDF reports.
- **Bottom workbench** — a real Git Changes review surface.
- **Settings → Update** — update source checkouts safely from GitHub `main`, or download and
  install the latest packaged release on macOS and Windows.

## Install

Three ways to run Akorith (full details in [`docs/install.md`](docs/install.md)):

1. **Download a release** — grab the artifact for your OS from the **Releases** page:
   - macOS: `Akorith-<version>-mac-<arch>.dmg` (or `.zip`) → drag **Akorith.app** to Applications.
   - Windows: `Akorith-Setup-<version>-x64.exe` (installer) or `Akorith-<version>-portable-x64.exe`.

   Builds are currently **unsigned** — on macOS right-click → **Open** the first time; on
   Windows choose **More info → Run anyway**. Signing/notarization is planned.

2. **Build from source (macOS):**

   ```bash
   git clone https://github.com/saitakarcesme/Akorith.git
   cd Akorith
   npm install
   npm run dist:mac      # build dmg + zip
   npm run refresh:mac   # back up old copies + install + open Akorith.app
   ```

3. **Build from source (Windows):**

   ```powershell
   git clone https://github.com/saitakarcesme/Akorith.git
   cd Akorith
   npm install
   npm run dist:win      # build installer + portable app
   npm run refresh:win   # clean stale shortcuts, install, launch
   ```

   Use the generated installer for normal use. If Windows still shows an Electron
   icon, uninstall old Akorith/Electron entries that belong to Akorith, delete stale
   shortcuts/taskbar pins, reinstall the latest `Akorith-Setup-<version>-x64.exe`,
   then restart Explorer or clear the Windows icon cache.

4. **Run in development:**

   ```bash
   npm run setup        # check toolchain, install deps, print exact auth steps
   npm run dev          # launch the desktop app
   ```
   Dev mode is for development and may expose Electron runtime identity in OS shell
   surfaces. The **packaged** app should show Akorith branding/icons everywhere.

   Existing projects and chats are loaded from the local Akorith userData folder
   on launch. If a packaged app ever opens to an empty-looking sidebar, fully quit
   and reopen packaged Akorith first; do not delete `loopex.db`, which stores local
   project/chat history. See [`docs/phase-42-startup-data-hydration.md`](docs/phase-42-startup-data-hydration.md).

One-command setup works on macOS/Linux (`scripts/setup-akorith.sh`) and Windows
(`scripts/setup-akorith.ps1`); `npm run doctor` runs a check-only pass. It never collects or
stores secrets — it only prints the sign-in commands for the tools you use. See
[`docs/setup.md`](docs/setup.md).

Maintainers cut releases via the GitHub Actions **release** workflow
(`workflow_dispatch` or pushing a `v*` tag). The active workflow lives at
`.github/workflows/release.yml` (changing it via GitHub CLI requires a `workflow`-scoped token or
the GitHub web UI) — see [`docs/packaging.md`](docs/packaging.md).

## Keeping machines current (in-app updates)

Tired of manually replacing the app? Open **Settings → Update**: packaged Macs download,
verify, install, and relaunch the latest stable GitHub Release. Source installs check GitHub
`main` and **fast-forward safely** (`git fetch` → `git switch main` → `git merge --ff-only`).
The updater keeps a rollback copy and never resets or discards local source changes. See
[`docs/update-system.md`](docs/update-system.md).

## Managing projects and chats

- **Project menu:** hover a project in the sidebar and open its `⋯` menu → **Rename**, **Reveal in
  Finder** (opens the project's folder), or **Remove from Akorith**. Removing a project takes it —
  and its workspace chats — out of Akorith's list. **It does not delete the folder or any files on
  disk;** re-add it any time with **Open Project**. If you remove the project you're currently in,
  Akorith returns to a clean no-project Workspace. The menu closes on Escape or an outside click.
- **Delete a chat:** hover an entry under **Recent Chats** and click **Delete** (click again to
  confirm). This removes that conversation; deleting the chat you're in opens a clean new chat.

## Files, plans, and project context

The composer accepts images, source files, Markdown/text, PDF, DOCX, spreadsheets,
presentations, archives, and other local files (up to 8 files, 16 MB each, 40 MB total per turn).
Files are copied into Akorith's managed data directory, persisted with the message, and passed to
the selected CLI by real local path; image-capable Codex receives images through its native image
argument. The original attachment is never modified. Workspace also supports `@` project-file
mentions, a read-only Plan turn, and queued follow-ups while the current turn is running.

## Conversation memory

Each chat is a real, continuous conversation: when you send a message, Akorith sends the
model this session's previous turns, so it remembers what you said earlier in the same chat.
A compact **memory indicator** under the text box shows how much is included (e.g.
`Memory: 14 msgs`, plus `Repo on` in a Workspace, or `summarized` for very long chats), with
a tooltip explaining what the model sees. Long chats are kept within a sensible window —
recent turns are sent in full, and older ones are compressed into a short running summary so
the chat still remembers without sending unbounded history. A **Reset context** button
(two-click) clears the memory for the current chat only — it never touches your other chats.
Memory is strictly per-chat: a new chat starts fresh, separate chats don't see each other's
history, and each project workspace keeps its own conversation.

## Workspace progress and task isolation

Workspace renders a bounded activity story instead of raw JSON or terminal logs. Each meaningful
command, file operation, planning event, and completion event has a plain-language explanation.
The fixed Step chip opens the six-stage project workflow. Every in-flight request, token buffer,
Stop control, and follow-up queue is keyed by session, so switching to another project or chat
never carries the wrong running state with it. A small global indicator still shows how many tasks
are working in the background.

## Computer Use for projects

Workspace and Loop include a compact **Computer Use** control for the selected project. Akorith
inspects the project's declared package scripts and may launch only `dev`, `start`, `serve`, or
`preview`, on a reserved loopback port. The running app can be opened in the system browser or
viewed as a live, interactive stream directly above the composer; pointer movement, clicks, and
focused-field typing are forwarded to an isolated offscreen browser. The stream never navigates
outside `localhost`, uses no shell command strings, and stops its process group when requested or
when Akorith exits. Finder reveal remains available for projects that do not expose a web preview.

## Connect your subscriptions

> **Install Claude CLI and Codex CLI, log into both in your terminal, then open Akorith and
> select a project.**

In more detail:

1. **Claude** — install the `claude` CLI and run it once to log in (uses your Claude
   subscription).
2. **Codex** — install the `codex` CLI and log in with your ChatGPT account.
3. **OpenCode** — `npm i -g opencode-ai`, then `opencode auth login`.
4. **Ollama (optional)** — install [Ollama](https://ollama.com), start it
   (`http://localhost:11434`), and pull at least one model for local/offline use.
5. **GitHub CLI (optional)** — `gh auth login` for repo operations.

Akorith detects whichever tools are present; any subset works, and a missing tool simply
shows as unavailable instead of breaking the app.

Akorith also tries to auto-start `ollama serve` when the default local provider
(`http://localhost:11434`) is down. By default it starts Ollama with LAN binding
(`OLLAMA_HOST=0.0.0.0:11434`) and, on another machine such as a MacBook, scans the
private LAN for a reachable Ollama `/api/tags` endpoint when localhost is unavailable.
That lets a MacBook use the models exposed from a running Windows host PC. If Ollama was
already running localhost-only on the host, restart Ollama/Akorith once so it can bind to LAN.

**Away from home (Tailscale/VPN/Controller):** a LAN IP only works on the same network.
Akorith auto-resolves the best endpoint — local Mac Ollama → saved profiles → Akorith
Controller host → online Tailscale peers — and the Dashboard **Local model runtime** card
shows the active source + a presentation-readiness verdict. Setup:
[`docs/remote-runtime-sync.md`](docs/remote-runtime-sync.md) and
[`docs/mac-to-pc-ollama.md`](docs/mac-to-pc-ollama.md).

## Run in development

```bash
npm install      # also rebuilds better-sqlite3 for Electron + fixes the macOS spawn-helper
npm run dev       # electron-vite dev server + Electron window
npm run typecheck # tsc over main, preload, and renderer
```

> Node.js 22+ recommended (20+ works). macOS (Apple Silicon) and Windows 10 1809+ are
> supported; Linux is untested.

## Build / package the desktop app

Akorith packages with **electron-builder**; identity (name, icon, bundle id) and targets are
configured under the `build` field in `package.json`. Full guide: [`docs/packaging.md`](docs/packaging.md).

```bash
npm run release:check   # read-only preflight (identity, icons, targets, git, tag)
npm run pack:mac        # fast unpacked .app  → dist/mac*/Akorith.app
npm run dist:mac        # installers (.dmg + .zip) → dist/
npm run dist:win        # Windows nsis + portable (build on Windows or via CI)
npm run refresh:mac     # back up old copies + install the new Akorith.app + open it
```

The packaged app is named **Akorith** in Finder, the Dock, and the menu bar (verified:
`CFBundleName`/`CFBundleDisplayName`/`CFBundleExecutable` = Akorith). In **dev**, the menu
bar may still read "Electron" — electron-vite launches the Electron binary directly, so macOS
takes the app name from the running executable, which `app.setName` and the Info.plist patch
(`scripts/fix-dev-app-name.js`, best-effort) can't reliably override. The packaged app is the
one users run. A macOS host can't reliably cross-build the Windows installer; use the GitHub
Actions **release** workflow for Windows artifacts. Builds are **unsigned** until signing
certs are configured (never faked).

## Privacy & security

- **Akorith stores no provider API keys and no AI-provider credentials.** It relies entirely
  on the logins already held by your `claude` / `codex` CLIs (and your local Ollama).
- App data is kept **locally** in SQLite (`loopex.db`) and a small JSON config
  (`loopex.config.json`) in your OS user-data directory — chat history, usage stats, project
  metadata, and settings only.
- **Terminal commands run locally** in the project folder you select, on your machine.
- Electron is locked down: context isolation on, sandbox on, Node integration off, a frozen
  preload bridge, a strict CSP, and prompts passed to CLIs over **stdin (never as shell
  arguments)**. There is a single programmatic path that can type into a terminal.

## Macro-loop: Approval & Auto modes

The macro-loop drives a planner → executor cycle toward a goal you set.

- **Approval Mode (default)** — the planner proposes one step; you approve or edit it before
  anything is sent. You stay in control of every send.
- **Auto Mode (opt-in)** — Akorith can continue the cycle with less manual copying: it sends the
  planner's prompt, reads a **read-only snapshot** of the terminal to summarize the result, and
  continues. It is deliberately cautious — it auto-answers only **low-risk, one-time**
  confirmations, **pauses** for anything medium/high-risk, destructive, low-confidence, or
  ambiguous, **never** selects "always allow", and **Stop** always interrupts it.

## Test Lab and PDF reports

The Test route is intentionally simple: pick a local repo or paste a GitHub repo URL, pick the kind
of test you want (debug, security, core unit logic, edge cases, or UI behavior), let Local/Ollama
generate and run tests in an isolated sandbox, then score selected runs with Claude or ChatGPT to
produce ISAScore. GitHub URLs are cloned into Akorith's local managed cache before testing.
Exported PDFs are saved to your **Downloads** folder with an `akorith-...pdf` filename; Akorith
shows the exact saved path and provides **Reveal** and **Open** actions.

To make generated tests more likely to actually run and pass, Akorith reads a bounded, read-only
snapshot of your repo's source structure and a few sample files and feeds them to the local model, with
framework-specific rules (import the real modules, correct pytest/vitest/jest syntax, no
empty/"0 tests"). If a generated test still fails, a **Repair & rerun** button sends the failing
file plus the sandbox output back to the local model for a corrected version and reruns it once — your
source repo is never modified. A 12-run validation across pytest, vitest, and jest on real
projects is recorded in `docs/validation/testlab-10-run-validation.md`. For JS/TS repos without an
existing runner, Akorith uses a temporary Vitest fallback and writes a sandbox-only config that
resolves `@/` imports to the repo root.

## Image and document chat

The same attachment control accepts images and arbitrary documents. Codex receives PNG, JPEG,
WebP, and GIF files through its native `--image` path; Claude and OpenCode receive managed file
directories/paths through their CLI integrations; local text and code files are safely inlined for
Ollama. Binary files remain available by managed local path. Attachment metadata survives history
reloads, while image previews are restored from Akorith's private attachment store.

## Current limitations

- **Auto Mode is cautious, not unlimited autonomous coding** — it pauses for you on anything
  risky and stops on repeated failures or low confidence.
- **No permanent "always allow"** auto-selection — only one-time approvals.
- **No automatic approval of risky permission prompts** — Akorith never auto-answers
  destructive or medium/high-risk prompts.
- **Ollama is optional** and may be absent; local-model features degrade gracefully.
- Packaged builds are not yet code-signed/notarized for public distribution (Gatekeeper may
  warn on first open on other machines).

## Design

Akorith is **chat-first**, in the spirit of Codex and ChatGPT: a calm workspace with a persistent
project/task sidebar, one focused conversation, a bottom composer, and restrained green/purple
status accents. CLI models run headlessly behind the conversation. Workspace shows meaningful
activity with explanations; Loop uses a distinct evidence-cycle diagram; Dashboard, Benchmark,
Plugins, Settings, and Changes share the same typography, spacing, radii, dark theme, and readable
light theme.

## Screenshots

Historical screenshots live under [`docs/screenshots/`](docs/screenshots/). The current product no
longer exposes the old Agent Activity terminal drawer in the normal Workspace flow.

### Workspace

![Akorith live workspace with a project chat](docs/screenshots/workspace.png)

### Composer tools

![Akorith composer More menu](docs/screenshots/composer-more.png)

### Dashboard

![Akorith dashboard command surface](docs/screenshots/dashboard.png)

### Plugins

![Akorith plugins registry](docs/screenshots/plugins.png)

### Test Lab

![Akorith Model Test Lab](docs/screenshots/testlab.png)

### Settings Update

![Akorith Settings Update panel](docs/screenshots/settings-update.png)

## Roadmap

- **Now:** durable ChatGPT-style General Chat, Codex-style project work, concurrent evidence-based
  Goals, file attachments, task queues/search/pins, real diff review, and in-app updates.
- **Next:** signed/notarized release artifacts and deeper provider-native tool rendering.

## More

- [docs/setup.md](docs/setup.md) — one-command setup + tool auth checklist.
- [docs/update-system.md](docs/update-system.md) — how the in-app source updater works.
- [AGENTS.md](AGENTS.md) — architecture, provider contract, packaging notes (AI/agent handoff).
- [codex.md](codex.md) — shorter "how we work + where we are" companion.
- [docs/release-checklist.md](docs/release-checklist.md) — build / launch / publish checklist.
