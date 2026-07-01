# 016 — Loop: Project Builder additional cycles + first-commit root cause

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Loop run (project_builder)
- **Model:** qwen3:1.7b · **Loop id:** d0b5f9b2 (MD Article Planner)

## Action
Ran 4 more Project Builder cycles (5 total incl. test 004) and traced WHY it never commits.

## Actual — PASS (real cycles) + root cause identified
| cycle | status | summary |
|---|---|---|
| 1 | rejected | No valid patch produced |
| 2 | rejected | No valid patch produced |
| 3 | no_change | Scaffolded initial project with package.json and README.md |
| 4 | no_change | Scaffolded initial project with package.json, main.js, and README.md |

The scorer's stored reason on every no_change cycle: **`npm run typecheck failed`**.

### Root cause (traced through src/main/local-executor.ts scoreAttempt)
The commit gate `shouldCommit` requires ALL 7 checks, including `validationPassed` = every
validation command allowed & passed. The model's scaffold creates a `package.json` whose
`typecheck` script the executor then runs — and it **fails** in a fresh directory (no deps
installed / no tsc). So the scaffold fails its own validation, so the executor rolls it back.
Score 86 = 6/7 checks pass; the single failing check is `validationPassed`.

### Is it a bug? No — conservative-by-design (documented as F-2, NOT patched)
Akorith is correctly refusing to commit code that fails its own validation command. "Fixing"
this by letting the loop commit despite a failing `typecheck` would weaken the core safety
guarantee for ALL modes (repo_grower/maintenance/github) and could commit broken code. The
correct user paths are: scaffold with a validation script that passes without install, or use
repo_grower on an already-scaffolded repo (which reached real commits: 368f2f7, bd82926, 190797d).

## Persistent artifacts
Run/event ledger rows for the PB loop (5 runs). Working dir remains an initialized-but-empty git
repo (all scaffolds rolled back) — an honest reflection of the conservative gate.

## Pass/fail
**PASS** — the mode runs the full real pipeline; the no-commit outcome is correct safety behavior
with a documented root cause, not a silent failure.
