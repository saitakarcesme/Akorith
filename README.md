# Akorith

**Akorith orchestrates your logged-in AI coding agents — it does not require API keys.**

Akorith is a cross-platform Electron desktop app that drives the coding agents you already
pay for, through their official command-line tools. You log into those CLIs once in your
terminal; Akorith runs them locally inside your chosen project. There are no API keys to
paste and no provider credentials stored by the app.

```
┌────────────┬───────────────────────────┬──────────────────────┐
│  Sidebar   │   Center planning / chat  │  Execution terminals │
│ projects   │   provider + macro-loop   │  Olympus  = Codex    │
│ history    │   chat → terminal bridge  │  Atlantis = Claude   │
└────────────┴───────────────────────────┴──────────────────────┘
```

## What it supports

- **Claude** — via the `claude` CLI (your Claude subscription/login).
- **Codex / ChatGPT** — via the `codex` CLI (your ChatGPT login).
- **Local models** — via a local **Ollama** server when one is running (optional).

The center chat talks to whichever of these are installed and logged in; the right side
hosts two real terminals (**Olympus** runs Codex, **Atlantis** runs Claude) inside the
project folder you pick.

## Connect your subscriptions

> **Install Claude CLI and Codex CLI, log into both in your terminal, then open Akorith and
> select a project.**

In more detail:

1. **Claude** — install the `claude` CLI and run it once to log in (uses your Claude
   subscription).
2. **Codex** — install the `codex` CLI and log in with your ChatGPT account.
3. **Ollama (optional)** — install [Ollama](https://ollama.com), start it
   (`http://localhost:11434`), and pull at least one model for local/offline use.

Akorith detects whichever tools are present; any subset works, and a missing tool simply
shows as unavailable instead of breaking the app.

## Run in development

```bash
npm install      # also rebuilds better-sqlite3 for Electron + fixes the macOS spawn-helper
npm run dev       # electron-vite dev server + Electron window
npm run typecheck # tsc over main, preload, and renderer
```

> Node.js 22+ recommended (20+ works). macOS (Apple Silicon) and Windows 10 1809+ are
> supported; Linux is untested.

## Build / package the desktop app

Akorith packages with **electron-builder**. The product identity (name, icon, bundle id)
is configured under the `build` field in `package.json`.

```bash
npm run pack:mac   # fast unpacked .app  → dist/mac-arm64/Akorith.app
npm run dist:mac   # installers (.dmg + .zip) → dist/
npm run dist:win   # Windows installer config (build on Windows)
```

The packaged macOS app is named **Akorith** in Finder, the Dock, and the menu bar, and uses
the Akorith icon. (In `npm run dev` the macOS menu/Dock still read "Electron" — that name
comes from the dev Electron bundle and only the packaged build can override it.)

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

## Current limitations

- **No full autopilot** — the macro-loop is semi-automatic: you approve or edit every step
  before it is sent to a terminal.
- **No automatic terminal-output parsing** — you paste or summarize executor results yourself.
- **No automatic permission-prompt approval** — Akorith never auto-answers `yes`/`1`/etc.
  in a terminal.
- **Ollama is optional** and may be absent; local-model features degrade gracefully.
- Packaged builds are not yet code-signed/notarized for public distribution (Gatekeeper may
  warn on first open on other machines).

## Screenshots / demo

_Placeholder — add Workspace, Dashboard, and Test-page screenshots / a short demo clip here
before publishing._

## More

- [AGENTS.md](AGENTS.md) — architecture, provider contract, packaging notes (AI/agent handoff).
- [codex.md](codex.md) — shorter "how we work + where we are" companion.
- [docs/release-checklist.md](docs/release-checklist.md) — build / launch / publish checklist.
