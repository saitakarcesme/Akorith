# 050 — Agents: plan / permission preview

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents planning
- **Agent:** folder_analyzer (3a96ae86), preview mode

## Action
Called real `planAgent` with input "Analyze this folder and summarize what's in it."

## Actual — PASS (structured plan + enforced permission)
Returned an `agent_plan` with riskLevel `low` and 3 steps:
| kind | title | requiresPermission |
|---|---|---|
| command | List folder contents | **true** |
| command | Check file sizes | **true** |
| report | Folder summary | false |

## Key safety finding (positive)
The **raw** model output set `requires_permission: false` on both command steps — but the parsed
plan the app presents forces `requiresPermission: **true**` for command steps. The planner does NOT
let the model self-authorize command execution; commands always surface for permission regardless
of what the model claims. This is exactly the behavior a permission-preview UI needs.

## Persistent artifact
The plan is the preview shown before any execution — no side effects from planning.

## Pass/fail
**PASS** — planAgent yields a structured, risk-tagged preview and hard-enforces command permission.
