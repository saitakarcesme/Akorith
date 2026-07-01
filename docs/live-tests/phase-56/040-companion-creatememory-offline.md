# 040 — Companion: manual createMemory (offline-capable) + ordering + count

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions memory

## Action
Created a memory manually (no model involved): type technical_context, "Primary stack — Akorith is
Electron + React + better-sqlite3…", importance 9. Then checked ordering, retrieval, and count.

## Actual — PASS
- **Offline-capable:** `createMemory` is a pure DB write (no model) — unlike chat, it works even
  when the runtime is offline. Row created immediately.
- **Importance is a 1–5 scale (clamped):** I passed 9; it stored **5** via
  `Math.max(1, Math.min(5, importance))`. Correct defensive clamping, not a bug.
- **Ordering** (`listMemories` = pinned DESC, importance DESC, updated_at DESC): pinned
  commit-heavy first; then importance-5 group; then importance-4 (local-first); then importance-3
  (black-heavy UI). Order is exactly as specified.
- **Immediate retrieval:** `searchMemories("electron sqlite stack")` surfaced the new memory at
  top (plus the always-on pinned memory). No model needed for search either.
- **Count:** memoryCount → Athena 7, Zeus 3 (archived banana not counted; deleted pineapple gone).

## Persistent artifact
New Athena memory b524879f (Primary stack) — visible in the memory panel.

## Pass/fail
**PASS** — manual memory creation, clamped importance, ordering, offline retrieval, and counts all correct.
