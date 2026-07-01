# 021 — Loop: settings round-trip persistence

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Loop settings
- **Loop id:** 81f81490 (aiarticle GitHub Loop)

## Action
Re-read the github_loop via `getLoop` to confirm every setting supplied at create time was
persisted and round-trips intact.

## Actual — PASS
```json
{
  "title": "aiarticle (GitHub Loop)",
  "mode": "github_loop",
  "autonomy": "assisted",
  "safety": "standard",
  "pushEnabled": false,
  "githubOwner": "futurearchitect",
  "githubName": "aiarticle",
  "repoUrl": "https://github.com/futurearchitect/aiarticle.git",
  "localModel": "qwen3:1.7b",
  "scheduleKind": "manual"
}
```
All fields match the create input (test 007), including the GitHub owner/name/URL, push flag,
autonomy, safety, model, and schedule.

## Persistent artifact
The loop row in loopex.db (visible/editable in Akorith's Loop settings).

## Pass/fail
**PASS** — no field dropped or mutated on persist/reload.
