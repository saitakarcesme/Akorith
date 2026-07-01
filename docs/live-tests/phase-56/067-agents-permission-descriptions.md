# 067 — Agents: permission-mode descriptions (UI honesty)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents permissions

## Action
Dumped `describePermission` for all 5 permission modes (the text the UI shows users).

## Actual — PASS (clear, honest, non-empty for every mode)
| mode | description |
|---|---|
| preview | Preview only — plans and previews changes, writes nothing and runs nothing. |
| ask_write | Ask before write — proposes file changes; you approve before anything is written. |
| safe_writes | Allow safe writes — writes files inside the chosen folder only; no commands. |
| safe_commands | Allow safe commands — safe writes plus allowlisted validation commands. |
| manual_each | Manual approval every step — you approve each write and command. |

Each description accurately matches the actual `capabilitiesFor` behavior verified in tests
056 (write tiers) and 058 (safe_commands). No mode misrepresents its capability.

## Pass/fail
**PASS** — permission descriptions are present and truthful for all modes.
