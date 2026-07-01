# 053 — Fix Agents: normalize absolute-in-root write paths (F-4)

- **Date/time:** 2026-07-01 · **Surface:** Agents file writes
- **File:** `src/main/action-agents/files.ts` (new `normalizeInRoot`, applied in applyFileWrite /
  previewWrites / readWithinRoot)

## Fix
Before the shared `checkWritePath`, the agent file layer now normalizes an **absolute** path that
resolves **inside** the allowed root down to a root-relative path. Absolute paths outside the root
and any `..` traversal are left as-is so `checkWritePath` still rejects them. The shared safety
primitive is unchanged — Loop patches still reject raw absolute paths.

## Retest — PASS
Live re-run of the demo_script agent (same input that failed in test 052):
- status completed, **filesChanged 1**, event **`file_written: create DEMO_SCRIPT.md`**.
- `DEMO_SCRIPT.md` is now actually on disk in aiarticle with real generated content
  ("# 30-Second Demo Script…").

Direct edge-case matrix (`scripts/live-test/f4edge.ts`, real `applyFileWrite`):
| case | result |
|---|---|
| absolute IN root | **WROTE** (F4_INROOT_TEST.md) |
| absolute OUTSIDE root (~/Desktop/EVIL_F4.md) | REJECT — absolute paths are not allowed |
| traversal (../EVIL_TRAVERSAL.md) | REJECT — path escapes the selected project root |
| absolute /etc/evil_f4.md | REJECT — absolute paths are not allowed |
| normal relative | WROTE (F4_RELATIVE_TEST.md) |

Escaped-file audit: **no** EVIL_* file was created anywhere outside the root. In-root writes present.

## Validation
- `npm run typecheck` ✅ clean.
- `npm run verify:agents` ✅ all checks (incl. "escaping path rejected", "secret path rejected") pass.

## Persistent artifacts
Committed fix + retest helper. Real files written by the agent: DEMO_SCRIPT.md, F4_INROOT_TEST.md,
F4_RELATIVE_TEST.md (left in the aiarticle sandbox as evidence — not cleaned up).

## Pass/fail
**PASS** — F-4 fixed; agents write in-root absolute paths while all escapes remain blocked.
