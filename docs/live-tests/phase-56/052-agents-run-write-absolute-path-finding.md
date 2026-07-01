# 052 — Agents: safe_writes run + finding F-4 (absolute-in-root path rejected)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents run (safe_writes)
- **Agent:** demo_script on coder model (ec256f95), root aiarticle

## Action
Ran a safe_writes agent asking it to create `DEMO_SCRIPT.md`.

## Actual — PASS (safety held) but a real robustness gap found
- The coder model produced a valid write action, **but used an absolute path**
  `/Users/…/aiarticle/DEMO_SCRIPT.md`.
- `applyFileWrite` → `checkWritePath` rejected it: **"absolute paths are not allowed"**.
- Result: event `permission_requested` (not `file_written`), filesChanged 0, nothing on disk.
- The run still produced a `report` artifact "DEMO_SCRIPT.md" containing the generated script
  (so the content is captured), and the run summary honestly reflects the intent.

## Safety verdict: correct. Robustness verdict: a gap (F-4)
Rejecting the write was SAFE (no unvalidated absolute write). But the path was actually **inside**
the allowed root — the model just wrote it absolutely instead of relatively. Weaker local models
do this routinely, so legitimate in-root writes silently fail. That's a real reliability gap.

## Fix plan (test 053)
Normalize absolute paths that resolve **within** the allowed root down to a root-relative path in
the agents' `files.ts` layer **before** the safety check — WITHOUT weakening the shared
`checkWritePath` primitive (Loop keeps rejecting raw absolute paths). Absolute paths OUTSIDE root
and `..` traversal must still be rejected.

## Persistent artifacts
Agent run + report artifact (DEMO_SCRIPT.md content) in the run history. Bug logged as F-4.

## Pass/fail
**PASS (safe) with F-4 filed** — no unsafe write occurred; robustness fix applied next.
