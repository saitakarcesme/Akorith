# 069 — Agents: run-count / history accumulation

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents run history

## Action
Ran the folder_analyzer agent a second time and re-checked its history.

## Actual — PASS
- After a 2nd run, `listAgentRuns(folder_analyzer)` → **2 runs**.
- Each run is a distinct row; the agent's `runCount` advances per run. History accumulates rather
  than overwriting.

## Persistent artifact
2 run rows for folder_analyzer (both retained).

## Pass/fail
**PASS** — repeated runs accumulate independent history.
