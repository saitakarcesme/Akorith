# Loopex — Codex continuation guide

This is the hand-off doc so the **Codex CLI** can continue Loopex if Claude Code is
unavailable. `AGENTS.md` is the deep architecture/spec reference; this file is the shorter
"how we work + where we are" companion. **Keep both in sync** (see the rule at the bottom).

## What Loopex is

An Electron + TypeScript + React desktop workspace that orchestrates coding agents **without
any API keys**. A planner chat on the right talks to the user's own **Claude** / **ChatGPT**
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
- [ ] **Phase 7** — test page (scope: an in-app surface to exercise providers/PTY/bridge).
- [ ] **Phase 8** — evaluate / PDF / ISAScore (scope: scoring + report export).
- [ ] **Phase 9** — autonomous loop (scope: drive the CLIs headlessly via `bridgeSend()`,
      reusing `buildDigest()` for per-iteration context).
- [ ] **Phase 10** — packaging + `productName` fix (scope: distributable build, app name).

## Locked design decisions

- **No API keys, ever** — subscriptions via CLIs, or local Ollama. Never fabricate costs;
  `usage.estimated=true` when numbers are approximations.
- **Router suggests, the user decides.** No automatic provider switching. The classifier
  runs on a **local** model only, called directly (not via `chat:send`).
- **Limit warnings are based on Loopex's own recorded usage**, never an official plan limit,
  and must say so.
- **Repo digest is opt-in and hard-capped**, prepended only to what the provider sees, never
  persisted into history and never treated as instructions.
- A session belongs to **one** provider; switching provider starts a new session context.

## Rule: keep the docs current

At the **end of every phase**, update **both** `AGENTS.md` and this `codex.md` — flip the
checklist above, record the new state and any new invariants — then commit + push.
