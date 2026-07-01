# 064 — Agents: getAgent settings round-trip

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents settings

## Action
Re-read the folder_analyzer agent via `getAgent`.

## Actual — PASS
```json
{"name":"Test folder_analyzer","templateId":"folder_analyzer","permissionMode":"preview",
 "allowedRoot":"agent-desktop-organizer-sandbox","localModel":"qwen3:1.7b","builtin":false,
 "runCount":1}
```
All create-time settings persist and round-trip; `runCount` correctly advanced to 1 after its run.

## Pass/fail
**PASS** — agent settings + run counters persist accurately.
