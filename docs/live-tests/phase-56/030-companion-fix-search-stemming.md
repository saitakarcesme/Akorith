# 030 — Fix Companions: memory search stemming (F-3)

- **Date/time:** 2026-07-01 · **Surface:** Companions memory search
- **File:** `src/main/companions/memories.ts` (`searchMemories` + new `partialMatch`)

## Fix
Added conservative shared-stem partial matching to `searchMemories`:
- Two tokens partial-match when they share a common prefix that is **≥ 4 chars AND covers all but
  ~2 chars of the shorter token**. Partial hits score 0.5 (exact hits still score 1.0, so exact
  matches rank higher). Tokens < 4 chars still require exact match.
- This fixes F-3 ("testing" ≠ "tests") without a heavyweight stemmer.

## Iteration honesty
My first attempt used a plain 4-char shared prefix — but that produced a **false positive**
("integrity" ↔ "interfaces", both prefix "inte"), which live-testing caught. I tightened the rule
to require the common prefix to cover the shorter token's stem, eliminating the false positive.

## Retest — PASS
| query | before fix | after fix |
|---|---|---|
| "testing" | 0 hits | ✅ dislikes-tests memory |
| "commits" | 0 hits | ✅ commit-heavy memory |
| "interfaces" | (n/a) | ✅ UI memory only — no false positive |
| "integrity" | – | ✅ dislikes-tests memory (title match) |
| "car" | – | ✅ 0 hits (no "care" false positive) |

- `npm run typecheck` ✅ clean.
- `npm run verify:companions` ✅ all checks pass (no regression).

## Persistent artifact
Committed code fix + this report. Verified live against the real memory store.

## Pass/fail
**PASS** — F-3 fixed, retested live, no regressions.
