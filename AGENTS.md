# Loopex — agent guide

Loopex is an Electron + TypeScript + React desktop workspace that orchestrates coding
agents **without any API keys**: a planner chat on the right talks to the user's own
Claude / ChatGPT subscriptions (via their installed CLIs) or a local Ollama server; the
center hosts two real PTY terminals; the left sidebar will hold session history. Built
with electron-vite, in strict numbered phases — currently through Phase 4 (the MVP:
the chat→terminal bridge).

## Prerequisites

- **Node.js 22+** and npm (Node 20+ works; developed on 22).
- **Windows 10 1809+** is the primary target (ConPTY). Other platforms are untested.
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

Native-module note: node-pty 1.1.0 ships N-API prebuilds that load in Electron without a
rebuild, so a clean `npm install` just works. Do **not** add an electron-rebuild
postinstall — rebuilding node-pty from the npm tarball fails (missing winpty git
metadata). `npm run rebuild` exists as the escape hatch for future native modules.

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
channel (`window.api.bridge.send`); the Phase 8 loop will call `bridgeSend()` directly
with non-human prompts — design changes must keep it callable headlessly.

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

## Conventions

- Surgical edits; keep the security posture intact (CSP, sandbox, frozen bridge).
- Mark future integration points with `// TODO(phase N):` comments.
- Prompts and other untrusted text go to CLIs via **stdin**, never argv.
