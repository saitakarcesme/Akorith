# 051 — Agents: run folder_analyzer (preview mode, real read)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents run (preview)
- **Agent:** folder_analyzer (3a96ae86) · root: agent-desktop-organizer-sandbox · model qwen3:1.7b

## Action
Ran real `runAgent` with "Analyze this folder and summarize what's in it."

## Actual — PASS (real read, preview-safe)
- Run status **completed**, `previewOnly: true`, filesChanged 0, commandsRun 0.
- The summary reflects the **actual** sandbox contents:
  > "Folder contains data.csv (CSV), draft.md (markdown), image-placeholder.png (image),
  > invoice.pdf (PDF), notes.txt (text), screen-2026-07-01.png (screenshot)… folder organized by
  > content type."
  (These are the real files placed in the sandbox — the agent genuinely inspected them.)
- Events: `plan_generated` → `completed` ("Preview complete (no changes made — preview permission).")
- Artifact: a `plan` artifact capturing the analysis.

Preview permission means the agent analyzes and reports but performs no writes/commands — the run
ledger + a plan artifact are produced, nothing on disk changes.

## Persistent artifacts
Agent run 06462652 + its events + plan artifact (visible in the agent's run history).

## Pass/fail
**PASS** — preview-mode run reads real data, produces a real report, and makes zero changes.
