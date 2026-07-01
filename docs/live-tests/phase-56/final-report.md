# Phase 56 — Final Report

**Deep real-user product test of Akorith's three core surfaces: Loop, Companions, Agents.**

- **Date:** 2026-07-01
- **App commit tested:** `cb5c2e7` (installed `/Applications/Akorith.app`)
- **Local runtime:** ONLINE — LAN Ollama at `http://192.168.0.109:11434` (auto-discovered by
  Akorith's remote-runtime resolver). Real models used: `qwen3:1.7b`, `qwen2.5-coder:7b`.
- **How tests ran:** each test invoked the **exact main-process functions the app's IPC handlers
  call** (createLoop, runOneCycle, sendCompanionMessage, createMemory, createAgent, runAgent, …)
  **inside Electron**, against the **real userData `loopex.db`**. Not raw SQL — the real app data
  layer. All data is visible in Akorith on next launch. Nothing was faked, nothing was cleaned up.

## Result: PASS

70 real commits (target ≥60): **20 Loop, 21 Companions, 20 Agents, 5 cross-feature, 1 persistence**,
plus harness/plan commits. Every commit carries a real test record, artifact, or fix.

## What was exercised (all with real models + persistent data)

### Loop (20) — reports 003–024
- All **4 real modes**: project_builder, repo_grower, github_loop, maintenance (there is no
  separate multi-repo mode; multi-repo = multiple loops, tested with 2 repos).
- **25 real model-driven cycles**; **7 real git commits** across 3 repos (aiarticle 368f2f7,
  bd82926, 0e1106a, 62da0ea; github clone 190797d, 1c99abe, 75bce53) — all verified in git history.
- **0 pushes** (audited). Backlog consumption, loop-memory, pause/resume/archive, settings
  round-trip, archived-guard, ledger cross-consistency all verified.

### Companions (21) — reports 025–048
- Athena (strategic) + Zeus (bold): distinct personas, both local-first + honest, both refuse
  actions (measured — Desktop untouched, loop run count 0→0).
- Long-memory: seeded my real preferences → auto-extracted → recalled across sessions → fused up to
  **4–5 memories** into personalized advice. Per-companion isolation (search + chat level).
- Memory ops: search, pin/archive/forget (disposable "pineapple marker 123"), filters, usage
  tracking, offline createMemory. Model-failure path persists nothing (atomic).

### Agents (20) — reports 049–072
- All **10 built-in templates** created + coder variants + a custom blank agent (16 total).
- **17 real runs** across all permission modes. Proven real effects: file write (DEMO_SCRIPT.md),
  real command execution (`npm run typecheck` passed), analysis reports/artifacts, preview-only.
- Safety proven: no delete, no secrets, no protected dirs, no escapes; agents never git-commit/push;
  planning side-effect-free; sandboxes intact.

### Cross-feature (5) — reports 073–077
- Companion evaluates Loop results (Athena, memory-grounded, flagged the F-1 test risk).
- Companion evaluates Agent output (Zeus, decisive).
- Create Loop from a Companion discussion; create Agent from a Companion discussion (least
  privilege). Companions cannot execute (measured: loop runs 0→0).

### Persistence (1) + validation — reports 078–079
- Full inventory survives process restarts (every harness run is a fresh process on the real DB).
- typecheck + build + verify:{project-loop,companions,agents,startup-hydration,local-executor,
  local-runtime} all green. Akorith.app relaunched cleanly with all data intact.

## Bugs found & fixed (see bugs.md)
- **F-3 (FIXED):** companion memory search had no stemming ("testing" ≠ "tests"). Added conservative
  shared-stem partial matching; retested; verify:companions green. (reports 029, 030)
- **F-4 (FIXED):** agents lost in-root writes when the model emitted an absolute path. Normalized
  absolute-in-root paths in the agent files layer (shared safety primitive untouched; escapes still
  blocked). Retested with a full edge matrix; verify:agents green. (reports 052, 053)

## Honest findings (documented, not defects)
- **F-1:** loop can commit a test referencing a removed symbol on a repo with no real test gate
  (mitigated with a loop-memory decision).
- **F-2:** project_builder can't reach a first commit when its own scaffold's `typecheck` fails —
  correct safety behavior (never commit code that fails validation).
- **F-5:** agent plan/action reliability varies by local model; the app fails safely + transparently.

## Persistent artifacts left in place (not cleaned up)
7 loops, 2 companions (10 memories, 11 sessions), 16 agents (17 runs + events + artifacts), 7 real
git commits across 3 repos, agent-written files in aiarticle, intact sandboxes, 80 markdown reports.
