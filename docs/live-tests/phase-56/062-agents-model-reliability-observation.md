# 062 — Agents: local-model reliability observation (F-5, honest, not an app bug)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents planning/action

## Observation
Across the agent runs, the structured plan/action step sometimes fails to parse with small local
models, surfaced honestly by the app:

| agent (model) | outcome |
|---|---|
| folder_analyzer (qwen3:1.7b) | OK (preview) |
| pdf_summarizer (qwen3:1.7b) | OK (preview) |
| desktop_organizer / benchmark (qwen3:1.7b) | OK (preview) |
| commit_assistant (qwen3:1.7b) | OK (file_written + command_run) |
| demo_script (qwen3:1.7b) | **failed** "Planning failed" ×2 |
| readme_builder (qwen3:1.7b) | **failed** "Planning failed" |
| changelog_maker (qwen3:1.7b) | **failed** "Planning failed" |
| demo_script (qwen2.5-coder:7b) | OK — wrote DEMO_SCRIPT.md (after F-4 fix) |
| readme_builder (qwen2.5-coder:7b) | plan OK, **action** "did not return valid" |
| changelog_maker (qwen2.5-coder:7b) | OK (report artifact) |

## Assessment
- This is **local-model reliability**, not an Akorith defect. The app behaves correctly on failure:
  it records a `failed` run with a clear reason ("Planning failed" / "Action generation failed —
  Local model did not return valid…") and makes **no** changes. No crash, no partial write.
- Larger/coding models (qwen2.5-coder:7b) succeed materially more often for structured file/command
  actions, which matches expectations.
- Honest takeaway for the product: agent success rate depends on the chosen local model; the app's
  failure handling is safe and transparent.

## Why not "fixed"
Nothing to fix in Akorith — the failures are the model's malformed JSON, and the app already
degrades safely. (Contrast F-4, which WAS an app-side path bug and was fixed.)

## Pass/fail
**PASS (as honest finding)** — failures are surfaced clearly and safely; documented as a model
property, not masked.
