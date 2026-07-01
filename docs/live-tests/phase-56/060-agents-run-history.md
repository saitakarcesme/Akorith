# 060 — Agents: run history (listAgentRuns)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents run history

## Action
Listed runs for the commit_assistant agent (and confirmed each created agent accrues run rows).

## Actual — PASS
`listAgentRuns(commit_assistant)` → 1 run:
```
completed | files:1 cmds:1 | Suggested commit messages based on current changes
```
Each `runAgent` call persists a run row (status, filesChanged, commandsRun, summary, timestamps)
that the Agents UI shows as run history. Across the suite, folder_analyzer, repo_health,
pdf_summarizer, desktop_organizer, benchmark_helper, changelog_maker, demo_script, and
commit_assistant all produced run rows.

## Persistent artifact
Agent run rows in loopex.db (visible in each agent's run history).

## Pass/fail
**PASS** — run history is recorded and queryable per agent.
