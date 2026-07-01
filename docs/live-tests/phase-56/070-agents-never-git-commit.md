# 070 — Agents: never git-commit or push (boundary vs Loop)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents vs Loop boundary

## Action
After agents wrote files into the aiarticle repo (DEMO_SCRIPT.md, SAFE_OK.md, scripts/typecheck,
PERMFLOW_TEST.md, F4_* files), checked the repo's git state.

## Actual — PASS
- aiarticle HEAD is still **62da0ea** ("Add typecheck script…") — the last *Loop*-authored commit.
- All agent-written files remain as **uncommitted working-tree changes**:
  ```
   M scripts/typecheck
  ?? DEMO_SCRIPT.md, F4_INROOT_TEST.md, F4_RELATIVE_TEST.md, PERMFLOW_TEST.md, SAFE_OK.md
  ```
- Agents wrote files but made **zero git commits and zero pushes**. Committing is the Loop's job;
  agents leave changes for the user to review/commit. Clean separation of responsibilities.

## Persistent artifact
The uncommitted agent changes sit in the working tree as evidence.

## Pass/fail
**PASS** — agents write for review only; they never commit or push.
