# 003 — Loop: create Project Builder loop

- **Date/time:** 2026-07-01
- **App commit tested:** cb5c2e7
- **Surface:** Loop (mode: project_builder)

## Action
Created a loop via the real `projectLoop.create` (same call the "Create project loop"
modal makes): title "MD Article Planner (Builder)", mode project_builder, folder
`~/Desktop/projects/business/loop-md-planner`, idea "Build a small local markdown article
planner for AI writers…", model `qwen3:1.7b`, autonomy assisted, safety standard,
daily commit target 3, push **disabled**.

## Settings used
Exact: see JSON. Local runtime online via LAN PC (192.168.0.109:11434).

## Expected
Loop persists, appears in Loop list, status=active.

## Actual
Created — id `d0b5f9b2-7c0d-4b59-96c4-07983589e11e`. Appears in listLoops: YES
count: 1.
```json
{
  "id": "d0b5f9b2-7c0d-4b59-96c4-07983589e11e",
  "title": "MD Article Planner (Builder)",
  "mode": "project_builder",
  "status": "active",
  "localPath": "/Users/ibrahimsaitakarcesme/Desktop/projects/business/loop-md-planner",
  "idea": "Build a small local markdown article planner for AI writers with outline, draft tracking, and export.",
  "autonomy": "assisted",
  "safety": "standard",
  "scheduleKind": "manual",
  "scheduleMinutes": 0,
  "dailyCommitTarget": 3,
  "minCommitsPerRun": 0,
  "maxCommitsPerRun": 1,
  "localModelProvider": "local",
  "localModel": "qwen3:1.7b",
  "pushEnabled": false,
  "createdAt": 1782916926008,
  "updatedAt": 1782916926008,
  "runCount": 0,
  "commitCount": 0
}
```

## Persistent artifact
Loop row in `project_loops` (visible on the Loop page) + working folder
`~/Desktop/projects/business/loop-md-planner`.

## Pass/fail
**PASS** — created and listed.
