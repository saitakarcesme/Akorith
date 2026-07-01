# 068 — Agents: run a custom (blank-template) agent

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents run (custom)
- **Agent:** Custom Notes Summarizer (fe51de36, templateId blank, preview)

## Action
Ran the user-defined agent from test 065: "Summarize the .txt notes in this folder."

## Actual — PASS
- Run completed, previewOnly true, summary "Summarize notes.txt into a report".
- A custom (non-template) agent runs through the exact same plan→preview pipeline as built-ins,
  honoring its preview permission (no changes).

## Persistent artifact
Run row + plan artifact for the custom agent.

## Pass/fail
**PASS** — custom agents are first-class and run safely.
