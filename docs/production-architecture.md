# Production architecture and verification

This document describes the implemented Akorith desktop application at version 1.0.0. It is an operational map, not a phase roadmap.

## Stack

| Layer | Implementation |
| --- | --- |
| Desktop runtime | Electron 33 through electron-vite |
| Language | Strict TypeScript in main, preload, renderer, tests, and the node daemon |
| Renderer | React 18 with application-owned components and CSS tokens |
| Terminals | xterm.js in the renderer, `node-pty` in the main process |
| Persistence | `better-sqlite3`, WAL mode, foreign keys enabled; small JSON stores for configuration and bounded service profiles |
| Charts and visuals | Application-owned SVG/CSS visualizations; no fake chart seed data |
| Packaging | electron-builder: Windows NSIS + portable x64, macOS DMG + ZIP arm64, Linux AppImage configuration |
| Updates | `electron-updater` against GitHub Release metadata |
| Tests | Vitest node/jsdom projects, Electron native-module smoke through Playwright, typed verification scripts, Windows/macOS CI |

The renderer uses React component state and narrowly scoped `localStorage` for presentation preferences such as layout. Durable product state is owned by main-process services. There is no global renderer state framework and no third-party component library to bypass.

Renderer controls, cards, charts, icons, modals, and empty states are application-owned React/CSS rather than a component-kit abstraction. `src/renderer/src/styles.css` is the central theme contract: base/panel/raised/input/chat/composer surfaces; text/border/status colors; muted `--ak-purple` and `--ak-green` visualization accents; sidebar-only `--sidebar-gradient` plus `--sidebar-glass`; radii/easing; and separate body/navigation/display/label/metric/code font tokens. Terminal and source content continue to use the monospace stack. A `[data-theme='light']` override changes the shared tokens without changing service behavior. Layout CSS includes focus-visible and reduced-motion behavior rather than requiring each page to invent it.

## Process boundaries

```text
Renderer (React, sandboxed)
    |
    | frozen window.api; validated IPC messages only
    v
Preload (contextBridge, no business logic)
    |
    v
Electron main process
    |-- provider and executor adapters
    |-- autonomous Loop and Benchmark services
    |-- repository/Git service
    |-- plugin marketplace and remote-node client
    |-- PTY manager and single bridge write path
    |-- SQLite and bounded JSON stores
    |
    +-- installed CLIs / Git / nvidia-smi via fixed executable+argv
    +-- Ollama / paired Akorith Node through bounded HTTP protocols

Standalone Akorith Node (separate Node.js process)
    |-- authenticated inference protocol
    |-- Ollama / LM Studio / vLLM adapters on node loopback
    `-- nvidia-smi observation only
```

The BrowserWindow enables `contextIsolation`, `sandbox`, and disables `nodeIntegration`. The preload object is frozen and exposes named methods rather than Electron or Node primitives. Main-process IPC handlers validate identifiers, request shapes, URLs, paths, sizes, and cancellation handles before they call services.

Window navigation is denied except for the current development origin. External HTTP(S) links are opened through an allowlisted URL validator. The native title bar, sidebar, and content occupy one renderer grid; Windows title-bar overlay space and macOS traffic-light space are reserved rather than covered with page content.

Programmatic terminal text has one route:

```text
renderer -> bridge:send IPC -> bridgeSend() -> PtyManager.write()
```

Loop does not drive its autonomous executor through a second PTY path. CLI executors are child processes, and structured local/remote executors apply validated workspace patches through the local executor service.

## Storage

Electron selects the platform `userData` directory after `app.setName('Akorith')`. Important files under that directory are:

- `loopex.db`: chats, projects, compatibility usage rows, unified telemetry, autonomous Loop records/cycles/events/model calls/snapshots/leases, model catalog probes, and Benchmark suites/runs/evidence;
- `loopex.config.json`: provider, digest, bridge, theme, and related preferences;
- `loop-workspaces/`: Akorith-managed clones of existing GitHub repositories and repository lock files;
- `remote-nodes.json`: non-secret paired-node profiles;
- encrypted remote-node token storage managed through Electron `safeStorage`;
- `plugin-marketplace.json`: bundled plugin installation/lifecycle and health state.

New user-created Loop projects are direct children of the parent folder selected by the user. Existing GitHub projects are cloned beneath the managed Loop workspace root. Benchmark fixtures use isolated temporary directories under the OS temporary directory; the source fixture definition is treated as read-only and the workspace is disposed after the fixture.

SQLite migrations are additive and versioned by subsystem. Startup applies unified telemetry, autonomous Loop, model catalog, and Benchmark migrations without deleting legacy user tables. The compatibility `usage_events` table remains the visible-chat choke point while an idempotent backfill populates the unified telemetry ledger.

## Provider and execution model

All chat providers implement the `Provider` contract: identity, capability kinds, availability, model discovery, streaming send, cancellation, and explicit usage provenance. The registry is config-driven and re-evaluated on discovery.

| Provider | Transport | Usage evidence |
| --- | --- | --- |
| Claude | installed `claude` CLI, prompt on stdin | CLI-reported where available |
| Codex | installed `codex exec`, prompt on stdin | estimated when the CLI does not report counts |
| OpenCode | installed `opencode` CLI | estimated when the CLI does not report counts |
| Local | Ollama HTTP streaming | Ollama prompt/evaluation counters, zero inference price |
| Remote | paired Akorith Node NDJSON streaming | runtime-reported counters, otherwise explicitly estimated |

Chat availability and a model's Loop eligibility are different. The model catalog merges provider declarations, per-model declarations, availability, hardware metadata, and persisted capability probes. A Loop executor requires a fresh `code_execution` probe that confirms every mandatory capability. A planner needs confirmed reasoning but does not need editing tools.

CLI Loop execution is bounded and cancellable:

- Codex uses `codex exec --sandbox workspace-write --ephemeral` with a temporary result file.
- Claude uses print mode, JSON output, automatic permission mode, and no session persistence.
- OpenCode receives the complete task through a mode-0600 temporary file and a fixed command message.
- Local and remote models return a structured patch/action contract; patch paths and validation commands pass through the local executor's containment and command policy.

Prompts are not interpolated into a shell command. Child output is capped, terminal escape codes are stripped before operational summaries, temporary files are removed, and AbortSignals propagate through provider, Loop, Benchmark, and remote-node requests.

## Repository and Git boundary

`RepositoryService` is the only high-level Git boundary for autonomous workflows. Its command runner calls `execFile` with `shell: false`, a fixed executable allowlist (Git by default), absolute working directories, argument count/length limits, a 64 KiB stdin limit, timeouts, bounded output, `GIT_TERMINAL_PROMPT=0`, and `GCM_INTERACTIVE=Never`.

Repository paths are canonicalized, checked against their allowed root, and checked across symlinks and Windows case differences. GitHub URLs are parsed into a canonical owner/repository identity. Clones disable tags, recursive submodules, and LFS smudging and install no repository hooks. Akorith supplies an empty trusted hooks directory for autonomous commits.

Repository mutation safeguards include:

- cross-process file leases keyed by canonical repository path;
- explicit file pathspecs, limited to 256 paths, for commits and recovery;
- `git commit --only`, preserving unrelated staged work;
- a repository checkpoint before a cycle changes files;
- no broad reset/clean rollback; only enumerated changed paths are restored;
- conflict and in-progress merge/rebase/cherry-pick/revert/bisect detection;
- push as `HEAD:refs/heads/<validated branch>` without force syntax;
- preflight remote reachability, authentication, default branch, and dry-run push access.

The GitHub repository-creation seam accepts only a connected, authenticated GitHub marketplace adapter and validates that the returned repository exactly matches the requested canonical identity. The default adapter fails with an authentication-required error; it does not report false success.

## Packaging and runtime assets

The Electron application ID is `com.akorith.app`, product/executable name is Akorith, and version is semantic `1.0.0`. Native modules remain main-process-only and are unpacked from ASAR. `postinstall` rebuilds only ABI-specific `better-sqlite3`; `node-pty` is not rebuilt, and the macOS node-pty helper's execute bit is repaired defensively.

The standalone node is bundled by esbuild for Node 20 into `dist-node/akorith-node.cjs`, then included in desktop package resources at `node/akorith-node.cjs`. The desktop build runs `node:build` before electron-vite.

Release targets and update metadata are described in [Updates and releases](production-updates-releases.md).

## Verification model

The normal local gate is:

```powershell
npm run verify
npm run build
```

`npm run verify` runs TypeScript checks for node, web, and tests; all Vitest projects; a real Electron native-module smoke; and the subsystem verifier suite. The Vitest projects are:

- `unit`: pure policy, validation, aggregation, model gating, protocol, and component-independent logic;
- `component`: jsdom React behavior, accessibility-oriented control states, and IPC-adapter rendering;
- `integration`: service persistence, cancellation, recovery, Git isolation, and cross-module behavior.

`test:native` launches Electron with a new temporary `userData`, loads both `better-sqlite3` and `node-pty`, verifies the Electron ABI, and removes the temporary directory. It does not reuse or mutate normal Akorith data.

Focused production verifiers cover telemetry, GPU parsing/polling/retention, model catalog/probes/storage, repository Git safety, Loop core/engine/onboarding, Benchmark catalog/store/service, plugin manifests/service, remote protocol/HTTP/runtime/client, packaged updater, Dashboard aggregation, native identity, Workspace behavior, and the retained chat/terminal flows.

GitHub Actions CI runs the full verification and electron-vite build on both `windows-latest` and `macos-latest` with Node 22. Release packaging has a separate target-native workflow. Physical GPU behavior, Windows Authenticode trust, Apple notarization, and macOS Gatekeeper behavior require real machines or credentials and cannot be established by headless unit tests alone.
