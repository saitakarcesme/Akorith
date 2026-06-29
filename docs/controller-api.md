# Akorith Controller API (Phase 35)

An **optional**, local HTTP API so Akorith can be inspected programmatically by local
scripts, CLIs, plugins, and (on a trusted private network) other devices and future
companion apps. Akorith stays local-first and API-key-free for its providers — this API
is a separate, opt-in surface.

## Default posture (safe by default)

- **Disabled by default.** Nothing listens until you enable it in Settings → API.
- **Loopback-only.** Host defaults to `127.0.0.1`. The server **never binds `0.0.0.0`
  implicitly** — a non-loopback host requires the explicit **Allow LAN access** toggle,
  and the UI warns about it. (This mirrors Local Studio's loopback-default + key-for-LAN model.)
- **Token-protected.** A bearer token is generated locally on first enable. Every
  endpoint except `GET /health` requires `Authorization: Bearer <token>`.
- **Read-only in Phase 35.** No command execution, no terminal/file/git writes, no
  prompt-send, no mission execution. The only `POST` is `/v1/controller/refresh`, which
  just re-runs read-only snapshots.
- **Restrictive CORS.** Only loopback or explicitly-allowed origins are echoed.
- The token is stored in **local config** (`loopex.config.json`), not an OS keychain, and
  is **never written to logs**. It is shown in Settings (reveal + copy) for your own use.

## Lifecycle

Starts on app launch only if you previously enabled it; stops on quit. Start/stop/restart
and token regeneration are available in Settings → API. Port conflicts (`EADDRINUSE`) are
reported as `lastError` and never crash the app.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | no | Liveness: `{ ok, app, version, time }` |
| GET | `/v1/status` | yes | App + controller + in-memory summaries (projects/chats/agents/missions/plugins) |
| GET | `/v1/agents` | yes | Agent adapter metadata |
| GET | `/v1/runtime` | yes | Runtime observation snapshot (no prompts/terminal output) |
| GET | `/v1/projects` | yes | Managed projects (metadata only) |
| GET | `/v1/chats` | yes | Chat/session **summaries** (titles + metadata, never message bodies) |
| GET | `/v1/missions` | yes | Preview/draft missions (no execution) |
| GET | `/v1/plugins` | yes | Plugin registry metadata + diagnostics |
| GET | `/v1/gpu` | yes | GPU/local-runtime telemetry (honest unavailable) |
| GET | `/v1/ollama` | yes | Configured Ollama endpoint/source (no secrets) |
| GET | `/v1/events` | yes | SSE stream: `controller_started/stopped`, `runtime_snapshot`, `plugin_status`, `heartbeat` |
| GET | `/v1/docs` | yes | This endpoint catalogue |
| POST | `/v1/controller/refresh` | yes | Re-run read-only snapshots; emits `runtime_snapshot` (no execution) |

## Examples

```bash
# Health (no auth)
curl http://127.0.0.1:47832/health

# Status (token required)
curl -H "Authorization: Bearer <token>" http://127.0.0.1:47832/v1/status

# SSE event stream
curl -N -H "Authorization: Bearer <token>" http://127.0.0.1:47832/v1/events
```

## SSE events

Events carry only shape/counts — never prompts, terminal output, or secrets. A gentle
heartbeat ticks only while at least one client is connected.

## Implementation

- `src/main/controller/` — `types.ts`, `policy.ts` (loopback/LAN/CORS rules), `auth.ts`
  (token gen, mask, constant-time compare), `events.ts` (SSE hub), `routes.ts` (pure,
  injected read-only data providers), `server.ts` (pure Node `http` factory — no electron/
  config imports, so it is unit-testable), `index.ts` (electron bootstrap + IPC + lifecycle).
- Verified by `npm run verify:controller` (boots on an ephemeral loopback port, checks
  auth + read endpoints, shuts down).

## Not in Phase 35 (deliberately)

No execution/write tier, no OpenAI-compatible proxy, no model lifecycle, no CLI/TUI yet.
A future Akorith CLI talking to this controller is the recommended next step.
