# 072 — Agents: final stats snapshot

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents overview

## Summary of Agent testing
- **15 agents** created: all 10 built-in templates + coder-model variants (demo_script,
  readme_builder, changelog_maker, repo_health) + 1 custom blank agent.
- **17 real runs** across all permission modes (preview 5, safe_writes 4, safe_commands 3,
  ask_write 3 agents represented).
- **Real effects proven:** file writes (DEMO_SCRIPT.md via safe_writes), real command execution
  (`npm run typecheck` passed via safe_commands), analysis reports (folder_analyzer, repo_health,
  pdf_summarizer, changelog_maker), preview-only agents (zero changes).
- **Permission model verified:** preview / ask_write / safe_writes / safe_commands behave
  distinctly (056); planner forces command permission (050); descriptions truthful (067).
- **Safety proven:** no delete, no secrets, no protected dirs, no escapes (059); F-4 absolute-path
  fix keeps escapes blocked (053); agents never git-commit/push (070); planning side-effect-free (071);
  sandboxes intact (063).
- **1 bug fixed (F-4)** + 1 honest reliability finding (F-5).

## Persistent artifacts (all in Akorith)
15 agent rows, 17 run rows with events + artifacts, real files written into aiarticle + sandboxes.

## Pass/fail
**PASS** — Agents surface fully exercised with real, persistent, honest data.
