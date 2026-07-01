# 022 — Loop: archived loop refuses to run

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Loop guard
- **Loop id:** a056e5b2 (sample-notes-cli, archived in test 013)

## Action
Attempted `runOneCycle` on the archived loop.

## Expected
The runner should refuse (archived loops are not runnable) without touching the repo.

## Actual — PASS
`ok: false`, `error: "loop is archived"`. No run row created, no model call, no repo change.
(Matches runner.ts guard: `if (loop.status === 'archived') return { … error: 'loop is archived' }`.)

## Persistent artifact
No new artifact by design — the guard prevents side effects. The archived loop remains in the
list (not deleted).

## Pass/fail
**PASS** — archived loops are safely inert.
