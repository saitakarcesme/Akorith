# 014 — Loop: run / event / commit ledger inspection

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Loop ledgers
- **Loop id:** 966a153f (aiarticle Repo Grower)

## Action
Inspected the three persistent ledgers the Loop detail view reads: runs, events, commits.

## Actual — PASS (all three ledgers coherent + cross-linked)
- **Runs** (2):
  - #1 rejected, files=0, validation=undefined (patch unparseable)
  - #2 success, files=1, validation=commit
- **Events** (13 total) — full per-cycle lifecycle recorded (run_started, inspected, planned,
  patch_proposed, patch_validated/rejected, run_succeeded).
- **Commits** (1): 368f2f7 "Add Markdown export feature to planner.js", files=1, linked to run #2.

## Cross-consistency
Commit ledger sha 368f2f7 == real git HEAD-1 of aiarticle; run #2 (val=commit) is the run that
produced it; run #1 (rejected) produced no commit. Counters (runCount 2 / commitCount 1) match.
Ledgers, git history, and loop stats all agree — no drift.

## Persistent artifacts
2 run rows + 13 event rows + 1 commit row (all visible in Loop detail). Durable in loopex.db.

## Pass/fail
**PASS** — the ledger trio is internally consistent and matches real git history.
