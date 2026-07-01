# 038 — Companion: sessions list per companion

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions sessions

## Action
Listed sessions for Athena and Zeus after the chat tests.

## Actual — PASS
- **Athena: 4 sessions** — incl. "…failure path" (0 msgs, from test 037), the recall session (2),
  the intro/who-are-you session (6), plus a pre-existing "hello" session (10).
- **Zeus: 4 sessions** — recall (2), intro (6), a "New conversation" (0), plus pre-existing "hello".

Each session reports a message count. Pre-existing user sessions ("hello") were left untouched.

## Observation (minor) — first message overwrites an explicit session title
`touchSession` sets the title to the first user message when the session has no prior messages,
so a title passed to `createSession` (e.g. "Phase 56 — getting to know Athena") is replaced by the
first prompt text ("Who are you, and how are you…"). Common auto-title UX, but it discards an
explicitly-provided title. Low severity; noted, not filed as a defect.

## Persistent artifacts
8 companion sessions across the two companions (all retained; none deleted).

## Pass/fail
**PASS** — session listing + counts correct; existing sessions preserved.
