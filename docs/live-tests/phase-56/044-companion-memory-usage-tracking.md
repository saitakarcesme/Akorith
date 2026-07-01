# 044 — Companion: memory usage tracking (lastUsedAt)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions memory

## Action
Checked whether memories record when they are used in a chat (`markMemoriesUsed`).

## Actual — PASS
The "Prefers commit-heavy development" memory has:
- `updatedAt`: 1782931640930
- `lastUsedAt`: **1782932816215** (later than updatedAt)

`markMemoriesUsed` runs `UPDATE companion_memories SET last_used_at = ?` for every memory returned
by `searchMemories` on a successful chat. So each time a memory informs a reply, its `lastUsedAt`
advances — enabling recency-aware memory management. The pinned commit-heavy memory (surfaced in
every query) shows the most recent lastUsedAt.

## Persistent artifact
Updated `last_used_at` timestamps on the memory rows.

## Pass/fail
**PASS** — memory usage is tracked per retrieval.
