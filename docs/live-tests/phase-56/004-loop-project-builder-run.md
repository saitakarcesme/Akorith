# 004 — Loop: run Project Builder first cycle (real local model)

- **Date/time:** 2026-07-01
- **App commit tested:** cb5c2e7
- **Surface:** Loop run (project_builder), model `qwen3:1.7b` via LAN Ollama

## Action
Ran one cycle via the real `projectLoop.runOnce` (the "Run one cycle" button path).

## Expected
Inspect → plan → local model patch → validate → commit (or honest no_change), with a full
event log + run-ledger entry.

## Actual — PASS (real model ran end to end)
- `ok: true`, `committed: false`, run status **no_change**, filesChanged 2.
- Event log (persisted, visible in the Loop detail Event log):
  - run_started → inspected (0 entries, empty folder) → planned (objective: "Scaffold the
    initial project for this idea…") → patch_proposed (**local model produced a workspace_patch**)
    → patch_validated (**Score 86, verdict no_commit**) → run_succeeded (No commit-worthy change).
- Run ledger row #1 persisted: status no_change, files=2, validation=no_commit.

## Persistent artifact
Run-ledger row + 6 event rows for this loop (visible in the Loop detail Run timeline + Event log).

## Observation (not a crash)
The local model produced a valid scaffold patch (score 86) but the shared local-executor
scorer returned **no_commit** for a brand-new empty project, so nothing was committed on the
first cycle. This is the existing local-executor scoring behavior (a fresh scaffold with no
runnable validation commands isn't judged commit-worthy). Repo-grower/maintenance runs on an
existing repo (with package scripts) are more likely to reach a commit — tested next.

## Pass/fail
**PASS** — the run executed fully with the real local model and produced a complete, persistent
event/run ledger. Honest no_change outcome recorded (not faked as a commit).
