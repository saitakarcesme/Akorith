# Agents — reusable local action shortcuts

> **Act with Agents.** An Agent turns a repeatable computer/project task into a one-click
> shortcut, powered by local models and gated by an explicit permission policy.

## What an Agent is

Unlike **Companions** (which never act) and **Loop** (which grows one repo over time), an
**Agent** performs a bounded task inside a folder you choose — organize a Desktop, write a
repo health report, draft a README/changelog, suggest commit messages, analyze a folder, …

Create it once, then run it again with one click.

## Built-in templates

Desktop Organizer · Repo Health Checker · Test Writer · README Builder · Changelog Maker ·
PDF Summarizer¹ · Demo Video Script Writer · Local Model Benchmark Helper · Git Commit
Assistant · Folder Analyzer.

¹ PDF text extraction isn't wired yet — the template is honest about being unsupported for
full PDF parsing and produces a framework/report from available metadata.

## Permission modes (default: safest)

- **Preview only** — plans + previews; writes nothing, runs nothing. **(default)**
- **Ask before write** — proposes writes for your approval.
- **Allow safe writes** — writes files inside the chosen folder only; no commands.
- **Allow safe commands** — safe writes + allowlisted validation commands.
- **Manual approval every step** — you approve each write and command.

Every agent shows what it will read, write, and run, plus a risk level, before acting.

## How a run works

1. **Plan** — the local model returns an `agent_plan` (steps + risk) you review. The plan
   grants no permission by itself.
2. **Action** — for non-preview modes, the model returns an `agent_action` (files, commands,
   artifacts).
3. **Validate + apply** — deterministic, in-code: paths are contained to the chosen folder,
   **agents never delete files**, no secrets/.env/.git/node_modules, size caps; commands run
   only from the validation allowlist. Everything is logged (file_written, command_run, …).
4. **Artifacts** — reports/checklists/summaries are always saved for you to read.

## Safety (verified)

`npm run verify:agents` asserts: default permission is `preview`; capabilities per mode are
correct; the delete op is always rejected; path escapes and secret files are refused; preview
never writes. Deterministic guards live in `src/main/safety` and `src/main/action-agents/files.ts`.

## Data

New additive tables: `action_agents`, `action_agent_runs`, `action_agent_events`,
`action_agent_artifacts`.
