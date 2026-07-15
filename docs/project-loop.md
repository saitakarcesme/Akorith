# Loop — durable local Goal cycle

> Give Akorith one complete outcome. It understands the Goal, plans one verifiable action,
> executes locally, analyzes evidence, and replans until the whole outcome is complete.

## Modes

- **Project Builder** — start from an idea; scaffold a real project and improve it in phases.
- **Repo Grower** — an existing local repo; add useful features, commit repeatedly.
- **GitHub Repo Loop** — a cloned/linked GitHub repo; improve and commit locally (push is opt-in).
- **Maintenance** — docs, tests, refactor, polish.
- **Multi-Repo Loop** — coordinate broader repository health checks and reports.

## Create-loop UX

Create project loop opens a centered command modal. It includes the project idea/direction,
mode selector, target selector, schedule, autonomy, local/PTY executor choice, safety,
commit/push controls, validation commands, and a compact summary of what will run. The body
scrolls inside the modal on smaller windows, Escape closes it when safe, and successful
creation selects the new loop detail view.

## How the Goal cycle works (`runGoalToCompletion`)

1. **Understand** the whole outcome as deliverables, acceptance criteria, constraints, and a first
   objective.
2. **Plan** one bounded, inspectable action using the current workspace and prior evidence.
3. **Execute** with the selected installed CLI or the guarded local structured executor.
4. **Analyze** the entire Goal contract against files, commands, artifacts, and validation results.
5. When evidence is incomplete, **Replan** the largest remaining gap and return to Plan. When every
   criterion is satisfied, emit `goal_completed` and stop.

A commit, successful command, or partial artifact is never sufficient by itself. Three consecutive
cycles without material progress pause for review instead of looping forever.

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

`npm run verify:goal-cycle` (Goal parsing + evidence completion gates),
`npm run verify:project-loop` (real git in a temp repo + read-only inspection; no Ollama needed)
and `npm run verify:local-runtime` (JSON + safety primitives).
