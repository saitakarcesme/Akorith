> **Superseded:** historical runtime notes; see `production-architecture.md` and `production-remote-node.md` for the current system.

# Shared local runtime

Loop, Companions, and Agents all send prompts through one **local-first** runtime
(`src/main/local-runtime/`), which wraps the existing local/Ollama provider + runtime
resolution (`ollama-connection.ts`) without changing the chat provider code.

## Surface

- `listLocalModels()` — models from the live resolved runtime, else the provider's list.
- `localRuntimeStatus()` / `isLocalRuntimeReady()` — the resolved source + readiness
  (Local / LAN / Tailscale / Controller), reused from Phase 42.
- `sendLocal(prompt, { system, model })` — a single completion against the `local` provider.
- `sendStructured(prompt, { validate })` — JSON output with tolerant extraction
  (`extractJson`) and **one repair retry**; the caller's validator narrows the type.

Preload: `window.api.localRuntime.{listModels,defaultModel,status}`.

## Local-first default

All three features default to the `local` provider (Ollama / resolved endpoint). Claude / Codex
/ OpenCode remain available for chat and Workspace, but are **not** the default for Loop,
Companions, or Agents.

## Testable without Ollama

`src/main/local-runtime/json.ts` (extraction) and `src/main/safety/*` (guards) are
electron-free and unit-tested by `npm run verify:local-runtime` — no live model required.
