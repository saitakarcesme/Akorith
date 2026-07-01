# 023 — Loop: full event sequence of a committing run

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Loop events (success path)
- **Loop id:** 81f81490 (GitHub Loop), run #3

## Action
Inspected the complete event sequence for a run that reached a commit (contrast with the
no_change/rejected sequences in tests 004/010/012).

## Actual — PASS (8-event success lifecycle)
```
run_started    : Run #3 started
inspected      : Inspected project (6 entries)
planned        : Objective (model): Add a function to generate an outline based on topic
patch_proposed : Local model proposed a patch
patch_validated: Score 100 (commit)          ← all 7 checks passed
patch_applied  : Applied 1 file(s)            ← only emitted on the commit path
committed      : Committed 75bce534: Add function to generate outline based on topic
run_succeeded  : Run #3 committed a change
```
The committing path emits two extra events (`patch_applied`, `committed`) that no_change/rejected
runs never emit — so the event log alone tells a user exactly which cycles produced commits.

## Persistent artifact
8 event rows for run #3 (visible in Loop detail Event log), tied to real commit 75bce53.

## Pass/fail
**PASS** — the success event lifecycle is complete, ordered, and distinguishable from non-commit runs.
