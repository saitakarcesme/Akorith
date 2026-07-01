# 078 — Persistence: full inventory survives process restarts

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** All (persistence)

## Method
Every live-test harness invocation is a **separate Electron process** that opens the real userData
`loopex.db` fresh (`app.getPath('userData')`). So persistence across restarts has been exercised
continuously — each of the ~200 harness runs reopened the DB and saw all prior data. This final
read is one more cold-open confirming the complete inventory.

## Actual — PASS (all data durable)
Fresh-process read of the real DB:
- **Loops: 7** (project_builder, repo_grower×3, github_loop, maintenance×2 incl. the one created
  from the Athena discussion) — with their run/event/commit ledgers, backlog, and loop-memory.
- **Companions: 2** (Athena, Zeus).
  - Athena: **7 memories** (1 pinned, + 1 archived recoverable), **6 sessions**.
  - Zeus: **3 memories**, **5 sessions**.
- **Agents: 16** (10 built-in-template instances + coder variants + custom blank + repo_health from
  the Zeus discussion) — with run history, events, and artifacts.

Plus real on-disk artifacts: 7 Loop git commits across 3 repos; agent-written files
(DEMO_SCRIPT.md, SAFE_OK.md, PERMFLOW_TEST.md, …) in aiarticle; intact sandboxes.

## Pass/fail
**PASS** — all created data persists in the real userData DB and is readable by any fresh process
(i.e., visible in Akorith on next launch).
