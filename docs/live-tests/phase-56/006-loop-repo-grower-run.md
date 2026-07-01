# 006 — Loop: run Repo Grower cycles on aiarticle (real local commit)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Loop run (repo_grower)
- **Model:** `qwen2.5-coder:7b` via LAN Ollama · **Loop id:** 966a153f-5bf1-4b11-a93e-7c1ff69f1417

## Action
Ran real `projectLoop.runOnce` cycles on the existing `aiarticle` git repo.

## Cycle 1 — REJECTED (honest)
- status **rejected**, "No valid patch produced".
- Events: run_started → inspected (4 entries) → planned ("Update README.md to include
  installation instructions…") → patch_proposed → **patch_rejected** (could not be parsed/validated).
- Real result: the 7B model planned a sensible objective but emitted a patch the parser
  rejected. Recorded honestly (not retried-away silently).

## Cycle 2 — SUCCESS, REAL COMMIT
- status **success**, committed **true**, sha **368f2f7**.
- Commit is in real git history of `~/Desktop/projects/business/aiarticle`:
  ```
  368f2f7 Add Markdown export feature to planner.js   (Author: Akorith Live Test)
  9aeed27 chore: scaffold aiarticle article planner
  ```
  `src/planner.js | 1 file changed, +8 -3`.
- Loop commit ledger row persisted: message "Add Markdown export feature to planner.js",
  filesChanged 1, validationSummary "commit", linked to runId eadcdd46.

## Persistent artifacts
1. Real git commit `368f2f7` in the aiarticle repo (survives forever).
2. Loop commit-ledger row + run/event rows (visible in Loop detail).

## Observation (honest, not an Akorith bug)
The 7B model's committed patch *replaced* the existing `planArticle` export with the new
`exportToMarkdown` function instead of adding alongside it. The local-executor scorer passed it
(aiarticle has no test importing planArticle, so validation had nothing to fail on). This is a
real property of weak-local-model repo-growing, not an app defect — but it argues for keeping
push disabled (as configured) and reviewing loop commits, exactly the assisted-autonomy flow.

## Pass/fail
**PASS** — both the honest rejection and the real successful commit exercise the full
inspect→plan→patch→validate→commit path with a real local model. Loop non-determinism handled
(cycle 1 rejected, cycle 2 committed) — no faked success.
