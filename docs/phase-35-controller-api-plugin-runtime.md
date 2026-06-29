# Phase 35 — Controller API · Real Plugin Foundation · vLLM Studio Gap

Branched from `feature/phase-34-ui-refinement-gpu-plugins`. A major phase that adds an
**optional, loopback-only, token-protected, read-only** local controller HTTP API, turns
the static Phase 34 Plugins page into a real permission-gated plugin foundation (with
honest diagnostics), and records a gap analysis vs. Local Studio (the repo formerly at
`0xSero/vllm-studio`, now `sybil-solutions/local-studio`).

Akorith stays local-first and API-key-free for its providers. The controller API is a
separate, opt-in surface — disabled by default.

## Environment probe (informs diagnostics, not hardcoded)

`node` ✓, `python3` ✓ (no `python`), `gh` ✓, `claude` ✓, `codex` ✓, `ollama` ✗,
`opencode` ✗, Google Chrome present, `chromadb` not importable, internet reachable.
These are detected at runtime by the plugin diagnostics — never baked into config.

## Plan & commit split

- `35.1` Audit + plan (this doc).
- `35.2` vLLM Studio / Local Studio gap analysis (`docs/vllm-studio-gap-analysis.md`).
- `35.3` Controller config model + types + security policy (loopback/token/read-only).
- `35.4` Local controller HTTP server foundation (Node `http`, lifecycle, IPC).
- `35.5` Controller settings UI (Settings → API tab).
- `35.6` Health + `/v1/status` + docs endpoints.
- `35.7` `/v1/agents|runtime|projects|chats|missions|gpu|ollama` read endpoints.
- `35.8` SSE `/v1/events` foundation (safe events only).
- `35.9` Plugin manifest + registry types.
- `35.10` Permission-gated plugin manager (config-only enable/disable) + IPC.
- `35.11` Upgrade Plugins page to read the live registry + diagnostics.
- `35.12` Built-in OpenCode / GitHub / Ollama-telemetry / Controller plugin definitions.
- `35.13` Chroma memory plugin foundation + diagnostics (no ingestion/embeddings).
- `35.14` Browser/Chrome plugin foundation + safe detection (no profile data).
- `35.15` Plugin diagnostics + availability checks wired end to end.
- `35.16` Controller `/v1/plugins` + Dashboard controller/plugins cards.
- `35.17` Security hardening, loopback defaults, verify script, docs.
- `35.18` Final UI/validation polish.

## Security model (mirrors Local Studio's safe default)

- Disabled by default. Host defaults to `127.0.0.1`; never `0.0.0.0`.
- Binding a non-loopback host requires `allowLan: true` (explicit) — otherwise the
  server refuses to start and records `lastError`.
- Bearer token required on every endpoint except `GET /health`. Token generated on
  first enable; shown in Settings with a copy button; stored in `loopex.config.json`
  (local config, not an OS keychain — documented).
- Read-only in Phase 35: no command execution, no terminal/file/git writes, no
  prompt-send, no mission execution. The only POST is `/v1/controller/refresh`
  (token-gated, re-runs read-only snapshots).
- Restrictive CORS; no token in logs; chat content is summary/metadata only.

## Preservation contract

No change to provider runtime/prompts/returns, token accounting, usage logging,
`bridgeSend → PtyManager.write`, PTY command kinds, macro/workspace loops, Test Lab,
Agent Hub / Mission preview, `loopex.db`, `loopex.config.json` filename, or AkorithLoop.
Plugins never load/execute remote code; Chroma/Browser are diagnostics-only foundations.

## Validation

`npm run typecheck`, `npm run verify:local-executor`, `npm run verify:workspace-loop`,
a new `npm run verify:controller` (boots the server on an ephemeral loopback port,
checks auth + a couple of read endpoints, shuts down), `npm run build`,
`git diff --check`; then manual controller curl + `npm run dev` smoke, left open.
Finally the validated branch merges into `main`.
