# 039 — Companion: memory list filters (pinnedOnly / includeArchived)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions memory filters

## Action
Exercised `listMemories` filters on Athena's store.

## Actual — PASS
- `filters.pinnedOnly: true` → **1** memory: "Prefers commit-heavy development" (the one pinned in
  test 031). Confirms the pin filter.
- `filters.includeArchived: true` → **7** rows, and the archived "banana marker 456" memory **is
  present** — confirming archive is a soft, reversible flag (`archived_at`), not a delete. Default
  list (no filter) showed 6; the difference is exactly the archived banana.

## Harness note
Extended the harness `listMemories` op to forward a `filters` object. Harness-only.

## Persistent artifact
Reproducible filtered views over the persistent memory store.

## Pass/fail
**PASS** — pinnedOnly and includeArchived filters both behave correctly.
