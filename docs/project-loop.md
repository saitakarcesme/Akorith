# Loop — autonomous local project builder

> **Build with Loop.** Give Akorith a project idea, a local repo, or a GitHub URL, and local
> models grow it over time with safe, validated commits.

## Modes

- **Project Builder** — start from an idea; scaffold a real project and improve it in phases.
- **Repo Grower** — an existing local repo; add useful features, commit repeatedly.
- **GitHub Repo Loop** — a cloned/linked GitHub repo; improve and commit locally (push is opt-in).
- **Maintenance** — docs, tests, refactor, polish.

## How one cycle works (`runOneCycle`)

1. **Inspect** the project (read-only, bounded file tree + key files).
2. **Plan** the next objective — an open backlog item, else the idea, else the local model.
3. **Patch** — the local model returns a structured `workspace_patch` (files + validation commands).
4. **Validate + apply** via the existing local-executor: paths are contained to the project root,
   commands run only from an allowlist, the change is scored, and non-commit-worthy attempts are
   rolled back.
5. **Commit** the meaningful change locally (never pushes).
6. **Record** a run-ledger row, an event-log trail, and a commit-ledger row; advance the backlog.

## Local-first

The planner and executor default to the **local provider** (Ollama / resolved runtime). Set a
per-loop model, or leave it on Auto. Claude/Codex remain available for chat/workspace but are not
the Loop default.

## Safety

Deterministic, in-code guardrails (never the model decides):

- writes are contained to the selected project root — no absolute paths, no `..` escape,
  no `.git`/`node_modules`/secrets/`.env`;
- commands run only from a validation allowlist (typecheck/build/test/lint) — no `rm -rf`,
  installs, `sudo`, `curl|wget`, chaining;
- **push is disabled by default** and never forced; force-push / `reset --hard` / `clean -fd`
  are always denied;
- size/file-count caps; rollback on failed or low-value attempts; every action logged.

## Data

New additive SQLite tables: `project_loops`, `project_loop_runs`, `project_loop_events`,
`project_loop_commits`, `project_loop_backlog_items`, `project_loop_memories`. Old macro/loop
tables are left readable.

## Verify

`npm run verify:project-loop` (real git in a temp repo + read-only inspection; no Ollama needed)
and `npm run verify:local-runtime` (JSON + safety primitives).
