# 059 — Agents: safety guarantees (no delete, no secrets, no protected dirs)

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Agents file safety
- **Helper:** scripts/live-test/safetycheck.ts (real `applyFileWrite`)

## Action
Attempted a battery of unsafe writes through the real agent file layer.

## Actual — PASS (every unsafe op rejected)
| attempt | result |
|---|---|
| delete README.md | REJECT — "agents never delete files (propose-only)" |
| create .env | REJECT — "refusing to write a secret/credential file" |
| create id_rsa | REJECT — "refusing to write a secret/credential file" |
| create certs/server.pem | REJECT — "refusing to write a secret/credential file" |
| create .git/hooks/pre-commit | REJECT — "path touches a protected directory (.git)" |
| create node_modules/evil.js | REJECT — "path touches a protected directory (node_modules)" |
| create SAFE_OK.md | **WROTE** (normal file allowed) |

Filesystem audit afterward: none of `.env`, `id_rsa`, or `.git/hooks/pre-commit` exist — the
rejections were real, not just error messages. These guards survive the F-4 fix (which only
normalizes in-root absolute paths; it does not relax delete/secret/protected checks).

## Persistent artifacts
SAFE_OK.md in aiarticle (the one allowed write) + the safetycheck helper. No unsafe artifact created.

## Pass/fail
**PASS** — agents never delete, never write secrets, never touch protected directories.
