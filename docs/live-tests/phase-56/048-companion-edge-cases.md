# 048 — Companion: input edge cases (empty message, unknown companion)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions chat validation

## Action
Sent invalid requests to `sendCompanionMessage`.

## Actual — PASS (clean validation, no persistence)
- Whitespace-only prompt "   " → `ok: false, error: "empty message"` (guarded before any model call).
- Unknown companion "hermes" → `ok: false, error: "companion not found"`.
- After both invalid sends, `listMessages` → **0 messages**. Invalid input never persists.

These guards sit at the top of `sendCompanionMessage`, so bad input fails fast with a clear error
and no side effects.

## Persistent artifact
An empty edge-cases session (proof nothing was written on invalid input).

## Pass/fail
**PASS** — input validation is correct and side-effect-free.
