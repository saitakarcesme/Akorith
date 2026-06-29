# vLLM Studio / Local Studio — Gap Analysis

**Source inspected (read-only, public):** `0xSero/vllm-studio` issues a permanent redirect
to **`sybil-solutions/local-studio`** — _"Control panel for VLLM, Sglang, llama.cpp,
exllamav3"_, TypeScript, default branch `main`. Inspected via the public GitHub API
(repo metadata + README) on this machine with internet access. Findings below are from
that README; deeper module internals were not exhaustively read.

## A. Local Studio features (observed)

Local Studio is a **local-first LLM serving control panel** built from three modules that
share one **controller API**:

- **`controller/`** — Bun + Hono backend. Owns:
  - **Model lifecycle**: launch, evict, recipes/presets, downloads, runtime process coordination.
  - **OpenAI-compatible proxy**: `chat`, `models`, `tokenization`, `audio`.
  - **System state**: GPU metrics, logs, usage, settings, **SSE** event streams.
  - Controller integrations; SQLite data dir created automatically.
- **`frontend/`** — Next.js 16 + React 19 web UI **and** a macOS Electron desktop shell.
  Hosts `/agent` (a Pi coding-agent runtime), settings, usage, recipes, logs, proxy routes.
- **`cli/`** — Bun CLI to check/operate a controller from a terminal: **headless commands
  + an interactive TUI** (`LOCAL_STUDIO_URL`).

Other notable concepts:

- **Runtime backends via recipes**: `vllm`, `sglang`, `llamacpp`, `mlx` (Apple Silicon);
  runtime target discovery surfaced in Settings, selections persisted.
- **Preflight `doctor`** check (toolchain, ports, directories, network).
- **Local/remote controller split**: frontend points at a remote controller via
  `BACKEND_URL` / `NEXT_PUBLIC_API_URL`; CLI via `LOCAL_STUDIO_URL`.
- **Security default**: controller binds `127.0.0.1`; a non-loopback host
  (`LOCAL_STUDIO_HOST=0.0.0.0`) **requires `LOCAL_STUDIO_API_KEY`** (startup throws
  without it); `LOCAL_STUDIO_ALLOW_UNAUTHENTICATED=true` opt-out only on a trusted LAN.
- **Remote deploy/daemon**: `deploy-remote.sh` (sync/build/restart), `daemon-*.sh` helpers.
- **Setup wizard**: pick models dir, install engine, download + launch + benchmark a model.

## B. Current Akorith features

- Agent OS orchestrator: Claude/Codex PTYs + bridge, local Ollama provider, registry.
- Read-only runtime observation, Agent Hub, Mission Engine skeleton (preview only).
- Dashboard (usage heatmap, provider mix, daily tokens, GPU/local-runtime card),
  Test Lab, macro/workspace loops.
- Phase 33–34: black-heavy command surface, project-first sidebar, composer model picker,
  full-page Settings, remote-Ollama auto-connect, bottom workbench (read-only Changes via
  `git:status`), terminal docking, read-only `gpu:getStatus`, a **static** Plugins page.
- **No HTTP API / controller, no CLI, no SSE, no plugin runtime** before Phase 35.

## C. Missing in Akorith (relative to Local Studio)

| Capability | Akorith before P35 | Notes |
|---|---|---|
| Controller HTTP API | ✗ | Phase 35 adds it (read-only) |
| SSE event stream | ✗ | Phase 35 adds `/v1/events` |
| CLI / TUI | ✗ | Not in P35 (curl examples instead) |
| OpenAI-compatible proxy | ✗ | Out of scope — different identity |
| Model lifecycle (launch/evict/download) | ✗ | Out of scope — Akorith isn't a model server |
| Recipes/presets per backend | ✗ | Out of scope |
| Remote controller switching | partial | Akorith has remote-Ollama; not a full remote controller |
| Local/remote split | partial | Controller API is the first step |
| Plugin runtime | static only | Phase 35 adds permission-gated foundation |
| Preflight doctor | partial | Plugin diagnostics ≈ a focused doctor |
| Remote deploy/daemon | ✗ | Out of scope |
| Tokenization/audio endpoints | ✗ | Out of scope |

## D. Worth adopting (and where Phase 35 does)

1. **A controller API as the integration backbone** → **Adopted** (read-only, opt-in).
2. **Loopback-by-default + API key required for non-loopback** → **Adopted verbatim** as
   the security model (host `127.0.0.1`, `allowLan` gate, bearer token).
3. **SSE event stream for status/runtime** → **Adopted** (`/v1/events`, safe events only).
4. **A "doctor"/diagnostics concept** → **Adopted** as plugin diagnostics (CLI/tool checks).
5. **Local/remote controller split mindset** → **Partially adopted** — the API is the
   foundation a future remote controller / companion can build on.
6. **CLI/TUI to operate a controller** → **Roadmap** (curl-friendly endpoints + docs now).

## E. Not relevant to Akorith (intentionally not adopted)

- OpenAI-compatible inference proxy, model launch/evict/download lifecycle, per-backend
  recipes (vLLM/SGLang/llama.cpp/MLX), tokenization/audio endpoints, benchmark/setup
  wizard, remote GPU-host deploy scripts. Local Studio is a **model-serving control panel**;
  Akorith is an **Agent OS / coding-agent orchestrator**. These belong to its identity,
  not ours.

## F. Recommended roadmap

1. **Phase 35 (this):** read-only controller API (health/status/runtime/projects/chats/
   missions/plugins/gpu/ollama + SSE), permission-gated plugin foundation, diagnostics.
2. **Next:** an Akorith **CLI** that talks to the controller (status/plugins/gpu) — the
   single most valuable Local-Studio idea still missing.
3. **Then:** a **remote GPU telemetry companion** (secured endpoint) feeding the GPU card,
   reusing the controller's auth model — closes the remote-Ollama GPU gap.
4. **Later:** turn the plugin foundation into a sandboxed, permission-enforced runtime
   (OpenCode agent, GitHub workbench, Chroma memory, Browser automation).
5. **Carefully, if ever:** a guarded write/execution tier on the controller (mission run,
   bridge send) behind explicit per-capability tokens — deliberately **out of Phase 35**.
