# 056 — Agents: permission-tier write flow (preview / ask_write / safe_writes)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents permissions
- **Helper:** scripts/live-test/permflow.ts (real `capabilitiesFor` + files layer)

## Action
Deterministically exercised the same proposed write (`PERMFLOW_TEST.md`) under three permission
modes, routing through the exact executor logic (`canWriteFiles && !requiresStepApproval` →
applyFileWrite, else previewWrites).

## Actual — PASS
| mode | canWriteFiles | requiresStepApproval | outcome |
|---|---|---|---|
| preview | false | false | PREVIEW / permission_requested (no write) |
| ask_write | true | **true** | PREVIEW / permission_requested (no write until approved) |
| safe_writes | true | false | **APPLIED** (file written) |

Only `safe_writes` actually wrote `PERMFLOW_TEST.md`. `preview` and `ask_write` produced a
permission-request preview and left disk untouched — exactly the tiered gating the UI relies on.

## Persistent artifact
PERMFLOW_TEST.md in aiarticle (written once, by safe_writes) — kept as evidence.

## Pass/fail
**PASS** — the three write-permission tiers behave distinctly and safely.
