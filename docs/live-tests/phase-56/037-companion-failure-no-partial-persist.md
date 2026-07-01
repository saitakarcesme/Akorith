# 037 — Companion: model-failure path persists nothing (no orphan turns)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions chat robustness
- **Session:** 37324d87

## Action
Sent a message forcing a model failure (model = `this-model-does-not-exist-xyz`) to exercise the
same code path that runs when the local runtime is offline.

## Expected
`sendCompanionMessage` returns early on `!res.ok` BEFORE persisting, so neither the user turn nor
an assistant turn is written (both-turns-only-on-success). No orphaned user message.

## Actual — PASS
- Result: `ok: false`, error `Ollama /api/chat failed: HTTP 404`.
- `listMessages(session)` → **0 messages**. Nothing persisted — not even the user turn.

This matches the design: an offline/failed model leaves the session clean rather than stranding a
user message with no reply. (Contrast: manual `createMemory` works offline — test 038.)

## Harness note
Added a `model` passthrough to the harness `sendCompanion` op so a failing model could be forced
deterministically while the LAN runtime is online. Harness-only; app code unchanged.

## Persistent artifact
The (empty) session 37324d87 — proof the failed exchange left no messages.

## Pass/fail
**PASS** — failure/offline path is atomic; no partial persistence.
