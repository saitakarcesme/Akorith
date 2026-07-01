# 028 — Companion: cross-session memory recall (Athena)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions long-memory
- **New session:** e8b8ef41 (preferences were seeded in a *different* session, 270ac7e4)

## Action
Opened a brand-new Athena session and asked: *"Based on what you know about me, how should I run
my next development phase? Reference my actual preferences."*

## Actual — PASS (recall across session boundary)
- `contextInfo`: **recentMessageCount 0** (fresh session, no in-session history) but
  **usedMemories: 1 — "Development Workflow"** (the commit-heavy memory seeded in session 270ac7e4).
- Athena's reply explicitly recalled the preference and reasoned from it:
  > "I recall your stated preference for a commit-heavy development workflow… Break work into the
  > smallest logical changes possible… Frequent commits provide immediate rollback points…"

This proves the memory layer spans sessions: a preference stated in one chat is retrieved and used
in a completely separate later chat. Retrieval is relevance-ranked (the commit-heavy memory was the
top match for a "development phase" question).

## Persistent artifacts
New session e8b8ef41 + its 2 message rows; the recall is reproducible from the persisted memories.

## Pass/fail
**PASS** — genuine cross-session long-memory recall with attributed memory usage.
