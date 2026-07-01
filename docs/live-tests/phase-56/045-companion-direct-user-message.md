# 045 — Companion: direct user-message persistence (UX)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions chat UX

## Action
Called `addMessage(session, athena, 'user', …)` directly (the path the UI uses to show a user's
message immediately, before the model reply arrives).

## Actual — PASS
- The user message was persisted immediately: role `user`, content stored.
- `listMessages` → 1 message, role order `user`. It stands alone until an assistant reply is added,
  confirming the UI can render the user's turn instantly without waiting for the model.

This is the UX complement to test 037: `sendCompanionMessage` only persists BOTH turns on model
success, but the renderer can optimistically show the user's message via this direct path.

## Persistent artifact
Session with 1 user message.

## Pass/fail
**PASS** — direct user-message persistence works and preserves ordering.
