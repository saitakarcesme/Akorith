# 029 — Companion: memory search (+ finding F-3)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions memory search

## Action
Ran `searchMemories(athena, …)` across several queries against the 6 seeded memories.

## Actual — mostly PASS, one recall gap (F-3)
| query | hit |
|---|---|
| "user interface" | ✅ "Prefers a serious, black-heavy user interface." |
| "local AI" | ✅ "Prefers local-first AI running on personal machines." |
| "test" | ✅ "Strongly dislikes fake or invisible tests." |
| "tests" | ✅ same |
| "fake" | ✅ same |
| "invisible" | ✅ same |
| "commit" | ✅ "Prefers commit-heavy development." |
| **"testing"** | ❌ **0 hits** |

## Finding F-3 — no stemming: "testing" doesn't match "tests"
`searchMemories` scores by **exact token overlap** (`tokenize` = `/[a-z0-9]{3,}/g`, no stemming).
So the query token `testing` never equals the memory token `tests`, and the relevant memory is
missed — even though `test`/`tests` both match. A user typing the natural word "testing" gets no
result for their "dislikes fake/invisible tests" memory. Low severity (semantic recall in chat is
separate and worked in test 028), but a real search-quality gap worth fixing.

## Persistent artifact
This report + the reproducible query results. Fix applied in test 030.

## Pass/fail
**PASS with logged gap** — search works for exact-stem tokens; F-3 filed for the stemming miss.
