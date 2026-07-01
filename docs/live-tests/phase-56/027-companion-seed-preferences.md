# 027 — Companion: seed preferences → auto memory extraction (Athena)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions memory
- **Session:** 270ac7e4 · **Model:** LAN Ollama

## Action
Told Athena my real working preferences in chat, then ran `extractMemoriesFromSession`:
> "…I prefer commit-heavy development. I care about seeing progress through git history. I want
> local-first AI that runs on my own machines. I strongly dislike fake or invisible tests. And I
> want a serious, black-heavy UI. Please remember these."

## Actual — PASS (all 5 preferences extracted as structured memories)
`extractMemories` created memories (real model-driven extraction, with type/title/importance/confidence):
| type | content |
|---|---|
| preference | Prefers commit-heavy development. |
| technical_context | Prioritizes seeing progress through git history. |
| preference | Strongly dislikes fake or invisible tests. |
| preference | Prefers local-first AI running on personal machines. |
| preference | Prefers a serious, black-heavy user interface. |

`listMemories(athena)` now returns **6** memories (the 5 above + a prior "Ibrahim Im, 21").
Each new memory has importance 5, confidence 0.7, and `sourceSessionId` = 270ac7e4 (traceable to
the conversation it came from).

## Persistent artifacts
6 Athena memory rows in loopex.db (visible in the Companion memory panel), each linked to its
source session.

## Pass/fail
**PASS** — stated preferences were captured verbatim-in-meaning into persistent, attributed memory.
