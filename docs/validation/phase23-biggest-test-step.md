# Phase 23: Biggest Test Step of Akorith

Date: 2026-06-21

This pass validates Akorith as a whole product surface: general chat, project workspace,
agent bridge, autonomous Loops, Test Lab, dashboard, packaging, settings, remote Ollama, and
the persistence/security invariants that hold those features together.

## Scope

The goal was to try the meaningful combinations Akorith supports, or mark them honestly when
they could not be exercised from this machine. The home PC that hosts local models was off, so
remote Local/Ollama model calls were not expected to pass live. The remote-connection path was
validated by code and documentation inspection instead.

## Result

Akorith's core source/build/test surface is healthy. The biggest product risk found is build
freshness: changing source code does not update an already installed packaged app. The user must
run a new build/package and launch or install that new artifact. In development, renderer edits
hot-reload, but `src/main` and `src/preload` edits require restarting `npm run dev`.

The macOS unpacked packaging smoke test did not complete during this pass: `npm run pack:mac`
compiled successfully, then electron-builder stayed silent for more than two minutes and produced
no `dist/mac-arm64/Akorith.app`; the attempt was stopped and recorded as a packaging reliability
follow-up.

## Automated Verification

| Check | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | Pass | Main, preload, and renderer type-check. |
| `npm run build` | Pass | Builds `out/main`, `out/preload`, and renderer assets. |
| `verify-macro-loop.ts` | Pass | Planner JSON parsing, iteration gates, steering prompt surface. |
| `verify-agentic-loop.ts` | Pass | Snapshot bounding, permission detection, summarizer fallback, auto gates. |
| `verify-critic-loop.ts` | Pass | Critic JSON parsing and heuristic fallback. |
| `verify-conversation-context.ts` | Pass | Session memory windowing and summary behavior. |
| `verify-bridge-autoenter.ts` | Pass | Paste and Enter are separate writes. |
| `verify-workspace-loop.ts` | Pass | Workspace git init and Phase-N auto-commit flow. |
| `verify-testlab.ts` | Pass, 25/25 | Includes parser/detection/snapshot/sandbox/timeout/abort/prune checks. |
| `npm run pack:mac` | Incomplete | Build step passed; electron-builder did not finish or emit `dist/`. |

Node prints `MODULE_TYPELESS_PACKAGE_JSON` warnings for the TypeScript verifier scripts. These are
runtime warnings, not failures.

## Combination Matrix

| Area | Combination Tested/Inspected | Status |
| --- | --- | --- |
| General Chat | New fresh general chat, no project context, provider/model switch, memory indicator | Code-inspected, type-checked |
| General Chat | Provider folders and recent-chat restore/delete/rename | Code-inspected, type-checked |
| Workspace Chat | Project-scoped session restore, repo-context toggle, memory reset | Code-inspected, type-checked |
| Workspace Agents | Olympus=`t2`/Codex and Atlantis=`t1`/Claude session keys per project | Code-inspected, type-checked |
| Bridge | Whole assistant message -> terminal | Verified by bridge core tests |
| Bridge | Code block -> terminal | Verified by bridge core tests and renderer path inspection |
| Bridge | Selected text -> terminal | Renderer path inspected |
| Bridge | Auto-Enter off/on | Verified; paste and submit are separate writes |
| Permission Cards | Read-only detection, answer buttons, dismiss, open Activity | Verified by agentic tests and renderer path inspection |
| Agent Summaries | Manual and auto terminal snapshot summaries into chat memory | Code-inspected, type-checked |
| Images | PNG/JPEG/WebP/GIF attachments, up to four, Local/Ollama pixels only | Code-inspected, type-checked |
| Router | Suggest-only local classifier with heuristic fallback | Code-inspected, type-checked |
| Dashboard | Usage reads `usage_events` only | Code-inspected, type-checked |
| Test Lab | Local path repo tests | Verified by `verify-testlab.ts` |
| Test Lab | GitHub URL clone into managed cache | Parser/IPC inspected and verified by `verify-testlab.ts` URL cases |
| Test Lab | Pytest, Jest, Vitest, JS/TS Vitest fallback | Verified by `verify-testlab.ts` detection cases |
| Test Lab | Timeout, abort, sandbox pruning | Verified by `verify-testlab.ts` |
| ISAScore/PDF | Objective scoring plus optional meta-call judge | Code-inspected, type-checked |
| Loops | Create task loop from user's prompt | Code-inspected, type-checked |
| Loops | Research/monitoring/building planner prompt | Verified by `macro-core` prompt inspection |
| Loops | Steering chips and detailed steps timeline | Renderer path inspected, type-checked |
| Loops | Hidden `claude-auto` executor in generated workspace | Code-inspected |
| Loops | Auto-commit as `Phase N: ...` | Verified by `verify-workspace-loop.ts` |
| Loops | Token budget accounting for planner/summarizer/critic meta calls | Code-inspected |
| Settings | Theme, display name, Ollama endpoint, LAN/VPN endpoint suggestions | Code-inspected, type-checked |
| Packaging | Production web/main/preload build | Pass |
| Packaging | macOS unpacked package | Incomplete/hung after compile |

## Remote Local Models

Because the home PC is off, Akorith cannot currently reach the local model server. When the PC is
on, the easiest remote path is:

1. Install and sign into Tailscale on both the PC and this Mac.
2. On the PC, run Ollama and allow it to listen beyond localhost:
   `OLLAMA_HOST=0.0.0.0:11434 ollama serve`.
3. In Akorith on the PC, Settings -> Ollama endpoint -> This machine should list a Tailscale-style
   endpoint like `http://100.x.y.z:11434`.
4. On the Mac, open Akorith Settings, paste that `http://100.x.y.z:11434` endpoint, click Test,
   then Save.
5. Do not expose raw port `11434` directly to the public internet; use Tailscale, WireGuard, or a
   protected tunnel.

This matches the implemented path: remote endpoints are probed by the main process, LAN addresses
produce friendly off-network guidance, and non-loopback endpoints are not auto-started locally.

## Problems Found

1. Build freshness is the main workflow trap. Source changes do not update an already installed
   app. The latest app requires `npm run build` and, for packaged usage, `npm run pack:mac` or
   `npm run dist:mac`, then launching/installing the newly built artifact.
2. `electron-vite dev` does not hot-rebuild `src/main` or `src/preload`; restart the dev server
   after changing those files.
3. `package.json` still reports version `0.1.0`, so multiple builds can look identical from a
   version-label perspective.
4. `npm run pack:mac` did not finish in this test window after a successful compile step. Packaging
   should be investigated before relying on a release artifact.
5. `codex.md` had fallen behind the actual phase history. It stopped at Phase 16 even though the
   code and `AGENTS.md` are at Phase 23.
6. The Settings popover still contained an old "Package identity cleanup remains Phase 10" note,
   even though Phase 10 is done.
7. Live Local/Ollama chat, local image understanding, local router model classification, and Test
   Lab generation could not be live-tested because the home PC/local models were unavailable.

## Feature Motivation In One Sentence

Akorith is a local-first orchestration cockpit that turns the user's existing Claude, Codex, and
Ollama tools into one persistent workspace for chatting, delegating terminal work, testing code,
and running autonomous task loops without storing API keys.
