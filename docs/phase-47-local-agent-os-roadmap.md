# Phase 47 — Local-First Agent OS Roadmap (Loop · Companions · Agents)

> **Akorith becomes a local-first Agent OS.**
> **Think with Companions. Act with Agents. Build with Loop.**

This document is the implementation journal for the multi-phase build that turns Akorith's
three nav pillars into real product surfaces, all sharing a local-first runtime, local SQLite
persistence, event logs, safety gates, and one UI language.

## Product vision

- **Companions** — long-memory local personalities (Athena, Zeus). Talk and remember. **No actions.**
- **Agents** — reusable local action shortcuts (organize Desktop, repo health, README, …). **Bounded actions, permissioned.**
- **Loop** — autonomous local project builder across many repos. **Grows real projects over time.**

Local models (Ollama / local-runtime resolution) are the **default and primary** runtime for
all three. Claude/Codex/OpenCode CLIs stay for existing chat/workspace compatibility but are
not the default for the new features.

## Current state (audit)

- **Electron + React + better-sqlite3**, main-process-only FS/SQLite, typed preload bridge.
- **DB** (`loopex.db`): `projects, sessions, messages, usage_events, test_runs, evaluations,
  macro_sessions, macro_turns, loop_targets, loop_runs, loop_events, loop_templates,
  loop_artifacts, loop_reports`. Pattern: `CREATE TABLE IF NOT EXISTS` + additive
  `ensureColumn()`; access via `must()`/`ready()`.
- **Existing Loop** is the macro/agentic loop (`src/main/loops/*`, `macro_sessions` columns for
  loop_type/target/schedule/safety/executor). The current `LoopsPage.tsx` is the generic
  operations center. It will be **superseded** by a new project-focused Loop; old tables/data
  stay readable (additive only).
- **Local executor** (`src/main/local-executor.ts`): a strong structured-patch concept already
  exists — `workspace_patch` with `files[]` (create/modify/delete), `commands[]`, an allowlist,
  validation, scoring, rollback. This is the basis for the new Loop + Agents executors.
- **Local runtime resolution** (`src/main/ollama-connection.ts`): `autoConnectOllama`,
  `RuntimeStatus`, Tailscale/Controller candidates (Phase 42). No shared `local-runtime/` module yet.
- **Pages**: `LoopsPage` (real), `CompanionsPage` / `AgentsPage` (Phase 43 "Soon!" placeholders).
- **Nav** (`App.tsx` `AppView`): general, workspace, dashboard, test, loops, plugins, companions, agents.
- **Verify scripts**: local-executor, workspace-loop, controller, startup-hydration (+ others under `scripts/`).

## What will be replaced / preserved

**Replaced/superseded:** the `CompanionsPage`/`AgentsPage` placeholders (become real); the
generic Loop UI mental model (becomes project-focused). Old Loop **data** is preserved.

**Preserved (must not break):** Workspace chat, General chat, project sidebar, recent chats,
provider/model picker, Agent Activity drawer, Bottom Workbench, Test Lab, Dashboard, Settings,
Remote Ollama setup, Update system, packaging, the `loopex.db` filename, all existing tables,
PTY manager, provider registry, controller security.

## Safety boundaries (hard rules)

- **Companions take no actions** — no files, commands, terminal input, commits, settings, agent/loop calls. Chat + memory only.
- **Agents/Loop** operate only inside an explicitly selected root; deterministic validation in code (not the model): allowlisted commands, path containment (no absolute writes, no `..` escape, no secret/.env writes, no Akorith-repo writes unless explicitly chosen), size caps, no `rm -rf`/`reset --hard`/`clean -fd`/`chmod`/`sudo`/`curl|wget` installers, no force-push, **no push unless explicitly enabled**, rollback on failure, every action logged.
- Default permission mode is **Preview/Ask-before-write**. Destructive ops never silent.

## Database plan (additive)

New tables (created in `initDb()` alongside existing ones):
- **Loop:** `project_loops, project_loop_targets, project_loop_runs, project_loop_events,
  project_loop_commits, project_loop_backlog_items, project_loop_memories,
  project_loop_artifacts, project_loop_reports, project_loop_settings`.
- **Companions:** `companions, companion_sessions, companion_messages, companion_memories,
  companion_memory_events, companion_profiles`.
- **Agents:** `action_agents, action_agent_runs, action_agent_events, action_agent_artifacts`.
All additive; existing data untouched.

## IPC plan

New preload namespaces, all typed in `index.d.ts`:
- `window.api.localRuntime` — list models, status, send, sendStructured.
- `window.api.projectLoop` — CRUD loops/targets, run one cycle, lists (runs/events/commits/backlog), settings.
- `window.api.companion` — companions, sessions, messages, sendMessage, memories (list/search/create/update/archive/forget/pin), extract, contextInfo.
- `window.api.actionAgent` — agents, templates, runs, plan/preview, run, artifacts, events.

## UI plan

- Replace `LoopsPage` with a project operations center (list · detail · runs · commits · events · backlog · roadmap · multi-repo dashboard · wizard).
- Replace `CompanionsPage` with Athena/Zeus cards · chat · memory panel.
- Replace `AgentsPage` with agent library · templates · create wizard · run form · permission preview · run timeline · artifacts · history.
- Shared UI primitives: local-runtime status pill, event-log list, safety badges, run timeline.

## Local model runtime plan

New `src/main/local-runtime/` wraps the existing local provider + `ollama-connection` resolution:
`models.ts` (list), `status.ts` (RuntimeStatus passthrough), `send.ts` (text), `structured.ts`
(JSON parse + one repair retry), `types.ts`. Used by Loop planner/executor, Companion
chat/memory, Agent planner/executor. A `mock` path lets verify scripts run without a live Ollama.

## Verification plan

New: `verify-project-loop-*`, `verify-companion-*`, `verify-action-agent-*` (+ package scripts
`verify:project-loop[:safety|:store]`, `verify:companions`, `verify:agents`). Plus the existing
`typecheck`, `build`, `verify:local-executor`, `verify:workspace-loop`, `verify:controller`,
`verify:startup-hydration`. Verify scripts use a mock local model so they don't need Ollama.

## Commit plan

Hundreds of tiny atomic commits, numbered `Phase 47.NNN` (foundation), `48.NNN`/`49.NNN` (Loop
backend/UI), `50.NNN`/`51.NNN` (Companions), `52.NNN`/`53.NNN` (Agents), `54.NNN` (polish). One
coherent change per commit (a type, a migration, an IPC method, a component, a guard, a test, a
doc). ≥100 each for Loop / Companions / Agents.

## Risk list

- **Scope** — very large; mitigated by atomic commits and additive DB.
- **iCloud-synced repo** — node_modules relocated off iCloud (Phase 39); builds slow but work.
- **No live Ollama in CI/verify** — mock local-runtime path.
- **DB growth** — additive tables only; old data readable.
- **Safety regressions** — deterministic validators + verify-safety scripts; default preview mode.
- **Not breaking existing surfaces** — new code is additive; existing pages/IPC untouched until UI swap, which keeps the same `AppView` slots.
