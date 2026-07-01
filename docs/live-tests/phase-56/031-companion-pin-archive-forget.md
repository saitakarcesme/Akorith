# 031 — Companion: pin / archive / forget

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions memory ops

## Action
- Created a disposable memory: "Temporary forget-test memory: pineapple marker 123".
- Created a disposable memory: "Temporary archive-test memory: banana marker 456".
- **Pinned** the "Prefers commit-heavy development" memory.
- **Archived** the banana memory.
- **Forgot** (deleted) the pineapple memory.

## Actual — PASS
- Pin: `pinMemory(commit-heavy, true)` → `pinned: true`; it now sorts first in `listMemories`
  (pinned DESC).
- Archive: `archiveMemory(banana)` set `archived_at`; banana no longer appears in the default
  `listMemories` (which filters `archived_at IS NULL`) — but the row still exists (reversible,
  not a delete).
- Forget: `forgetMemory(pineapple)` issued a real `DELETE`; the row is gone. `memoryCount` = **6**
  (down from 8 after the two disposables), and `listMemories` shows 6 active memories with neither
  pineapple nor banana present.

## Investigated & cleared a false alarm (honest)
`searchMemories("pineapple")` returned 1 hit — I initially suspected forget had failed. On
inspection the hit was the **pinned** commit-heavy memory, not the pineapple one:
`searchMemories` intentionally surfaces pinned memories in every query (`overlap > 0 || pinned`).
The pineapple/banana content is NOT returned. So forget/archive both worked; no bug.

### Minor observation (not filed as a bug)
Pinned memories appear in explicit search results even with zero query overlap. That's by design
(pinned = always in context) but is mildly surprising in a search box. Left as-is.

## Persistent artifacts
- Athena memory set: 6 active (commit-heavy now pinned), banana archived (recoverable), pineapple
  permanently forgotten. Memory event log rows for pinned/archived/forgotten.

## Pass/fail
**PASS** — pin, archive (reversible), and forget (hard delete) all behave correctly and durably.
