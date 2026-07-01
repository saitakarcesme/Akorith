# Phase 56 — Live product test of Loop · Companions · Agents

A real product-usage session against the **installed Akorith app's real data** (userData
`loopex.db`). Everything created here **persists and is visible in Akorith** after the test.

## How these tests run

I cannot click the rendered Electron UI programmatically, so each test invokes the **exact
same main-process functions the app's IPC handlers call** — `createLoop`, `runOneCycle`,
`sendCompanionMessage`, `createMemory`, `createAgent`, `runAgent`, … — **inside Electron**
(`scripts/live-test/main.cjs` + `harness.ts`), against the **real userData `loopex.db`**. This
is the real app data/logic layer, not raw SQL. Data created is visible in Akorith on next launch.

## Environment (at start)

- App commit tested: `cb5c2e7` (installed `/Applications/Akorith.app`), repo advances during fixes.
- **Local runtime: ONLINE via LAN** — the Windows PC's Ollama at `http://192.168.0.109:11434`,
  19 models, auto-discovered by Akorith's remote-runtime resolver. Fast model used: `qwen3:1.7b`.
- Test project `aiarticle`: not present → created under `~/Desktop/projects/business/aiarticle`.

## Test plan

- **Loop (≥20):** create all 5 modes (Project Builder, Repo Grower, GitHub Repo Loop,
  Maintenance, Multi-Repo), realistic settings, verify list/detail, run real cycles with the
  local model, backlog/memory, pause/resume/archive, run+event+commit ledgers.
- **Companions (≥20):** Athena + Zeus real chats (local model), who-are-you/in-character,
  no-action boundary, seed + recall memory across sessions, memory search, pin/archive/forget
  (disposable memory only), UX (immediate user msg + thinking, offline handling), persistence.
- **Agents (≥20):** create all 10 built-in templates, permission preview/plan, run real agents
  (reports/artifacts/file writes) against `aiarticle` + sandboxes, run history, honest unsupported.
- **Cross-feature (≥5):** Companion evaluates Loop/Agent results; create Agent/Loop from a
  Companion discussion; verify Companions don't execute actions.
- **Persistence:** quit + reopen Akorith; verify all data visible.

## Commit index

**COMPLETE — PASS.** 70 real commits: 20 Loop (003–024), 21 Companions (025–048),
20 Agents (049–072), 5 cross-feature (073–077), persistence (078), final validation (079).
See individual `NNN-*.md` reports and `final-report.md` for the summary.

## Bugs found / fixes applied

See `bugs.md`.

## Final status

See `final-report.md`.
