# Akorith Plugin System (Phase 35 foundation)

Phase 34 shipped a static Plugins page. Phase 35 turns it into a **real registry** with
permission metadata and **honest, read-only diagnostics** — but **not** an execution
runtime. No plugin code is loaded or run; enable/disable is config-only.

## Model

- `src/main/plugins/types.ts` — `PluginKind`, `PluginStatus`, `PluginPermission`,
  `PluginManifest`, `PluginDiagnostic`, and the runtime `PluginInfo` view.
- `src/main/plugins/permissions.ts` — human-readable permission labels + a sensitive set.
- `src/main/plugins/diagnostics.ts` — read-only availability checks (CLI `--version`,
  path detection). No execution of plugin logic.
- `src/main/plugins/builtin.ts` — static built-in manifests.
- `src/main/plugins/manager.ts` — combines manifests + config-only enable/disable +
  cached diagnostics; registers `plugins:*` IPC and feeds the controller `/v1/plugins`.

### Kinds
`agent`, `tool`, `workbench`, `automation`, `model_provider`, `integration`, `memory`,
`browser`, `telemetry`.

### Status
`built_in`, `available`, `unavailable`, `disabled`, `planned`, `error`. The
`effectiveStatus` applies disable + diagnostics over the manifest baseline.

### Permissions
`filesystem_read/write`, `terminal_read/write`, `network`, `git_read/write`, `browser`,
`memory_read/write`, `model_runtime`, `controller_api`, `secrets`. Sensitive permissions
(writes, browser, secrets) are highlighted in the UI. **No permission is granted or
exercised in Phase 35** — they describe what a future plugin runtime would request.

## Built-in plugins + diagnostics

| Plugin | Kind | Diagnostic (read-only) |
|---|---|---|
| OpenCode Agent (Gaia) | agent | `opencode --version` + safe `opencode auth list` sign-in status (Phase 37: runs as the Gaia terminal between Olympus and Atlantis) |
| GitHub Workbench | integration | `gh --version` |
| Remote Ollama Telemetry | telemetry | `ollama --version` + configured remote profiles |
| Hermes Memory / Skills | memory | planned (no check) |
| Chroma Memory | memory | `python3 -c "import chromadb"` + optional HTTP endpoint config |
| Browser / Chrome Automation | browser | Chrome/Chromium path detection (no profile data) |
| Test Lab Extensions | tool | built-in |
| Mission Engine Runners | automation | planned (no Run Mission) |
| API / Controller | integration | follows controller enabled/running |

## Chroma Memory (foundation only)

Diagnostics detect Python + `chromadb`. An optional Chroma HTTP endpoint can be saved in
the plugin details. **Phase 35 ingests nothing, stores no embeddings, indexes no files,
and never auto-starts Chroma.** Future use: mission memory, skill memory, project memory,
semantic search.

## Browser / Chrome (foundation only)

Detects Chrome/Chromium via standard install paths (`/Applications/...` on macOS, Program
Files on Windows, `google-chrome`/`chromium` on Linux). **No browser profile data
(cookies/history/passwords) is ever read, and no website is automated.** Future use:
browser-based research, web-app testing, screenshot-assisted debugging — always with
explicit permission.

## IPC

`plugins:list`, `plugins:check`, `plugins:checkAll`, `plugins:getDiagnostics`,
`plugins:enable`, `plugins:disable`, `plugins:getSettings`, `plugins:setChromaEndpoint`.
Enable/disable persist to `loopex.config.json` (`plugins.disabled[]`).

## Safety

No remote plugins, no arbitrary-folder plugin execution, no internet installs, no
marketplace, no new DB tables. Static metadata + config + read-only diagnostics only.
