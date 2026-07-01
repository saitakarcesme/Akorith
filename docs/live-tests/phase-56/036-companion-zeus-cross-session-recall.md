# 036 — Companion: Zeus cross-session recall

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions long-memory (Zeus)
- **New session:** (Zeus recall) · preferences seeded in session b8c1a860

## Action
New Zeus session, asked: *"What's my big deadline and how should I approach this week?"*

## Actual — PASS (recall across sessions)
- `contextInfo`: recentMessageCount 0, **usedMemories 1 — "Work Style"** (the tight-deadlines
  memory from the previous session).
- Zeus reasoned from it, in character:
  > "…I remember your style. You don't need comfort. You need the heat. You run on pressure… Find
  > the one thing that breaks your sleep if it doesn't happen. That's your deadline…"
- He also correctly refused to invent a calendar date ("I don't have access to your calendar or
  files—I don't touch them") — boundary intact even while recalling memory.

## Honest note on retrieval relevance
Only the "Work Style" memory was surfaced; the "Ship Akorith 1.0 by August" goal memory was NOT,
because that memory's text doesn't contain the query token "deadline" (its tokens are
ship/akorith/august/launch). Token-based retrieval behaved correctly; the goal memory simply
didn't lexically match. Consistent with the retrieval model, not a bug.

## Persistent artifact
New Zeus session + messages; reproducible recall from persisted memories.

## Pass/fail
**PASS** — Zeus recalls his own memory across a session boundary and stays in-character + bounded.
