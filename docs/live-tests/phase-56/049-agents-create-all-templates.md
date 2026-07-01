# 049 — Agents: create all 10 built-in templates

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents

## Action
Instantiated one agent from each of the 10 built-in templates via real `createAgent`, each with a
local model (qwen3:1.7b) and an appropriate `allowedRoot`.

## Actual — PASS (10 agents, correct defaults)
| template | agent id | default permission | root |
|---|---|---|---|
| desktop_organizer | 5fc16d3a | preview | agent-desktop-organizer-sandbox |
| repo_health | 9aad165c | safe_writes | aiarticle |
| test_writer | f3231350 | ask_write | aiarticle |
| readme_builder | 705a37f2 | ask_write | aiarticle |
| changelog_maker | bdb3ceae | safe_commands | aiarticle |
| pdf_summarizer | a2e785d5 | preview | agent-pdf-summarizer-sandbox |
| demo_script | 5ca76c43 | safe_writes | aiarticle |
| benchmark_helper | 3af838d5 | preview | (none — needsRoot false) |
| commit_assistant | 200d4b76 | safe_commands | aiarticle |
| folder_analyzer | 3a96ae86 | preview | agent-desktop-organizer-sandbox |

`listAgents` → **10 agents**. Each carries the template's default permission mode (preview /
safe_writes / ask_write / safe_commands) — the permission model is preserved on instantiation.

## Roots (sandboxes, never deleted)
- aiarticle repo (repo agents), agent-desktop-organizer-sandbox (organizer/analyzer),
  agent-pdf-summarizer-sandbox (pdf). benchmark_helper needs no root.

## Persistent artifacts
10 agent rows in loopex.db (visible on the Agents page).

## Pass/fail
**PASS** — all 10 built-in templates instantiate with correct permission + root defaults.
