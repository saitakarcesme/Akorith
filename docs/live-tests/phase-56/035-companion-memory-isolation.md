# 035 — Companion: per-companion memory isolation

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions memory

## Action
Verified Athena's and Zeus's memories are separate stores.

## Actual — PASS
- Athena: **6** memories (commit-heavy, git-history, dislikes fake tests, local-first, black-heavy
  UI, "Ibrahim Im, 21").
- Zeus: **3** memories (Akorith 1.0 launch goal, tight-deadlines preference, project context).
- `searchMemories(athena, "August launch deadline")` → **0** hits for Zeus's launch memory — Athena
  cannot see Zeus's memories.

Memory rows are keyed by `companion_id`; every query filters on it, so the two companions maintain
independent long-memory.

## Persistent artifact
Two disjoint memory sets in loopex.db.

## Pass/fail
**PASS** — companions do not share memory.
