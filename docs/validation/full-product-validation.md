# Akorith — Full Product Validation (Phase 12)

_Validation date: 2026-06-13 · Akorith commit at start: `51fbf91`_

## Method & honesty note

Akorith is an Electron **GUI** app. This validation could not script mouse clicks inside the
packaged window, so each area was validated by the **closest faithful equivalent** and that
level is stated explicitly throughout:

- **REAL** — actually executed: `typecheck`/`build`/all three verify scripts, `pack:mac`,
  launching the packaged `.app`, the real `claude` and `codex` CLI invocations Akorith uses,
  and three real sample projects (code + tests + git history + applied AI reviews).
- **CODE-VERIFIED** — the feature's IPC + preload + renderer wiring was inspected and confirmed
  present/correct, but the on-screen click-through was not automated.

Where something is CODE-VERIFIED rather than clicked, it says so. Nothing below is asserted as
"passed" on the basis of a typecheck alone.

---

## 1. Executive summary

**Recommendation: Ready for private demo** (see §9 for the nuance toward public soft launch).

**What worked well (REAL):**
- `typecheck`, `build`, and all three verify scripts pass; `pack:mac` produces a launchable,
  correctly-identified `Akorith.app`; the packaged app boots and initializes SQLite (native
  modules load in the packaged context).
- Both provider CLI paths Akorith depends on work for real: `claude -p --model haiku` and
  `codex exec --skip-git-repo-check --output-last-message <file>`.
- Three real projects were built, tested (26 passing tests total), git-committed in meaningful
  phases (16 commits total), and improved with **real Claude Haiku reviews** + **real Codex runs**.
- Security posture held up under a real Claude review: all three projects render user input via
  `textContent`/DOM APIs (no `innerHTML`), parse storage defensively, and avoid `eval`.

**What is still risky:**
- The packaged app is **ad-hoc signed only** — other Macs will hit Gatekeeper ("unidentified
  developer") until Developer-ID signing + notarization is done.
- With **Codex as planner/executor**, latency per turn is ~30–60s and ~12–14k tokens; Auto Mode
  works but feels slow. Claude/Haiku is much snappier.
- Auto Mode and the macro-loop GUI were CODE-VERIFIED (logic, IPC, safety gates, unit tests via
  `verify-agentic-loop.ts`) but not click-driven end-to-end in the packaged window.
- Ollama/local provider could not be exercised (not installed) — degrades gracefully by design.

---

## 2. Environment

| Item | Value |
|---|---|
| macOS | 26.6 |
| Node | v22.22.2 |
| npm | 10.9.7 |
| Akorith commit | `51fbf91` (Phase 11) at start |
| Packaged app | `dist/mac-arm64/Akorith.app` (arm64, ad-hoc signed) |
| Claude CLI | `2.1.177` — **available**, haiku confirmed working |
| Codex CLI | `codex-cli 0.139.0` — **available**, `exec` confirmed working |
| Ollama / local | **not installed** — not required for this validation |

---

## 3. Project creation results

All three live under `~/Desktop/akorith-validation/` with **local-only** git repos (no remotes,
nothing pushed). Each used the real executor + review CLIs Akorith orchestrates.

### Project 1 — Mini Docs Site
- **Path:** `~/Desktop/akorith-validation/mini-docs-site`
- **Purpose:** backend-free docs site (Home/Docs/Changelog/About) with client-side search.
- **Commits (5):** Init → Add docs layout and navigation → Add search and filtering → Add tests
  → Apply Claude review fixes.
- **Claude (Atlantis path):** real `claude --model haiku` review — flagged missing DOM null
  checks (HIGH) and stringified-`undefined` matches (MEDIUM); both **fixed**. Confirmed XSS-safe.
- **Codex (Olympus path):** real `codex exec` in the project cwd correctly read `package.json`
  and named an untested edge case, without mutating the repo.
- **Tests:** 7 (`node --test`) covering `filterDocs` + `splitHighlight`. All pass.
- **Limitations:** uses ES2022 `replaceChildren()`; demo corpus is hard-coded.

### Project 2 — Safe Task Tracker
- **Path:** `~/Desktop/akorith-validation/safe-task-tracker`
- **Purpose:** local-only task tracker (title/status/priority/tags/createdAt) with localStorage.
- **Commits (5):** Init → Add task CRUD → Add filters and persistence → Add tests → Apply
  security review fixes.
- **Claude review (real, haiku, security-focused):** "No exploitable vulnerabilities." Confirmed
  `textContent` rendering, defensive `JSON.parse` + `sanitizeLoaded`, no prototype-pollution
  surface. Applied a tag-normalization consistency fix.
- **Tests:** 8 covering sanitization, length cap, immutable CRUD, filters, corrupt-storage. Pass.
- **Limitations:** single-user; ids are timestamp+counter (fine for local use).

### Project 3 — Prompt Runbook Generator
- **Path:** `~/Desktop/akorith-validation/prompt-runbook-generator`
- **Purpose:** deterministic task→runbook (goal/assumptions/steps/risks/test-checklist/rollback).
- **Commits (6):** Init → Add runbook generation logic → Add UI and export → Add tests → Apply
  debug review fixes → Fix step cap in deriveSteps.
- **Claude review (real, haiku, debug-focused):** flagged **no input-size validation (HIGH)** and
  missing edge-case tests; **fixed** (5000-char cap, steps capped at 50, 3 new tests).
- **Codex (real):** `codex exec` in cwd named a missing risk category (PII/GDPR) — a genuine
  product idea, logged as a future enhancement.
- **Tests:** 11 covering determinism, all sections, risk detection, step splitting, markdown,
  and the new edge cases. All pass.
- **Limitations:** keyword-based risk detection; copy/download are no-ops before Generate.

**Totals: 16 commits, 26 passing tests across 3 projects.**

---

## 4. Feature matrix

Legend — Tested: **R** = real/executed, **C** = code-verified (wiring confirmed, not GUI-clicked).

| Feature | Tested | Result | Notes |
|---|---|---|---|
| **Sidebar** collapse/expand | C | Pass | `akorith.sidebarCollapsed` persisted |
| Workspace/Dashboard/Test nav | C/R | Pass | App mounts all three; Dashboard/Test routes present; packaged app booted to Workspace |
| Project list + switching | C | Pass | `projects:list`, active-project state |
| All-projects `+` menu | C | Pass | Open/Create popover wired |
| Open Project (folder dialog) | C | Pass | `projects:openFolder`, main-process dialog |
| Create Project modal | C | Pass | name + `projects:pickDirectory` + `createFolder` |
| Recent chats | C | Pass | backed by `sessions` |
| Provider folders collapsed by default | R(code) | Pass | `providerCollapsed[id] ?? true` confirmed in source |
| Provider folders expand/collapse + persist | C | Pass | `akorith.providerCollapsed` |
| Profile/settings + display name persist | C | Pass | `akorith.displayName` |
| **Chat** provider/model selector | C | Pass | from registry, not hard-coded |
| Normal chat send | C | Pass | `chat:send` (the only `usage_event` writer) |
| Repo-context toggle | C | Pass | `digest.setEnabled` |
| Suggest/router button (suggest-only) | C | Pass | `router.suggest`, never auto-switches |
| Send target + Olympus/Atlantis + auto-enter OFF/ON | C | Pass | `bridge.send` + `bridge.setAutoEnter` |
| Chat bubbles / composer metadata | C | Pass | light borderless bubbles (Phase 11) |
| Message→terminal bridge | R(path) | Pass | bridge → `PtyManager.write`; CLI paste path proven via CLIs |
| **Terminals** Olympus=Codex / Atlantis=Claude | R | Pass | mapping confirmed in source; both CLIs run for real in project cwds |
| Both start in active project cwd | R | Pass | Codex `exec` ran inside each project dir |
| Missing-CLI fallback | C | Pass | `commandSpec` falls back to shell + message |
| Terminal split default 50/50 | R(code) | Pass | Phase 11 `storageNumber` null-fix + 30–70 clamp confirmed |
| Terminal resize / collapse | C | Pass | pointer-drag + `localStorage` |
| Terminal snapshot read (bounded, read-only) | R | Pass | `verify-agentic-loop.ts` exercises bounding; `pty:snapshot` is read-only |
| No duplicate PTY write path | R | Pass | only `bridgeSend`→write (prog.) + `pty:input` (human); confirmed by grep |
| **Macro-loop** Approval default | R(code) | Pass | `mode` defaults `approval` |
| Propose / edit / approve / send | C | Pass | `macro:propose/approve` wired through bridge |
| Summarize from terminal | R(logic) | Pass | summarizer parse + heuristic fallback unit-tested |
| Good-enough threshold / max iterations | R | Pass | `evaluateAutoOutcome`/`maxIterationsReached` unit-tested |
| Manual Stop | R(logic) | Pass | aborts `activeProposals` + `activeLoops` |
| Auto Mode enable + safe step + pause | R(logic) | Pass | policy + stop gates unit-tested in `verify-agentic-loop.ts` |
| Permission detector | R | Pass | sample prompts (numbered/yes-no/enter/destructive/access) unit-tested |
| Auto-actions log / pause reason | C | Pass | `auto_actions` JSON + `pause_reason` columns + UI |
| **Dashboard** opens / charts render | C | Pass | recharts; reads only `usage_events` |
| Meta/summarizer/judge calls excluded from usage | R | Pass | all use `sendMetaPrompt` (no `usage_event`); grep-confirmed |
| **Test page** open / detect / run sandbox / persistence | R(core)/C | Pass | `verify-testlab.ts` 19/0; sandbox safety core verified |
| **ISAScore** objective-only / judge / PDF single+comparison | C | Pass | `evaluate:*` IPC + pdfkit wired; judge via `sendMetaPrompt` |
| **Packaging** pack:mac / launch / identity / icon / native modules | R | Pass | `Akorith.app`, CFBundleName=Akorith, boots, DB created |

---

## 5. Bugs found in Akorith

No **blocker/high** bug was found during this validation. The Phase 11 fixes (sidebar logo,
terminal split, light theme) hold. Lower-severity observations:

1. **Auto Mode brief status flicker** — _severity: low._
   - Repro: in Auto Mode, `propose()` sets status `awaiting_approval` for an instant before the
     loop auto-sends. Repro is timing-dependent (renderer polls every 1.5s, so usually unseen).
   - Expected: never shows the manual "Approve" affordance during Auto.
   - Actual: a sub-second window where the approval UI could render.
   - Suggested fix: add an `auto_sending` transient status or skip the `awaiting_approval` write
     when `mode==='auto'`. (Not fixed — cosmetic, not user-impacting at 1.5s poll cadence.)

2. **Codex-as-planner latency** — _severity: low (UX, not a defect)._
   - Codex `exec` takes ~30–60s / ~12–14k tokens per call, so Auto Mode turns are slow when the
     planner is Codex. Bounded polling handles it correctly; consider defaulting the planner to a
     faster model and surfacing an "agent is working…" affordance.

3. **`timeout(1)` coreutils absent on macOS** — _severity: low, dev-env only._
   - Not an app bug; only affects ad-hoc shell scripting during validation.

No Akorith source fix was required, so **no `Fix validation blocker:` commit was made** (an honest
zero — nothing critical was broken).

---

## 6. UI/UX polish recommendations

- **Empty states:** add friendly empty states for the chat (before first message), the macro-loop
  (before a goal is set), and the Test page (before a repo is selected).
- **Auto Mode affordance:** while a loop runs, show an explicit animated "Akorith is working on
  turn N — reading <terminal>" banner so the 1.5s poll cadence doesn't feel like a freeze.
- **Planner latency:** a per-turn spinner / elapsed timer for slow Codex calls.
- **Permission panel:** when a prompt is detected, show the exact matched terminal text snippet
  prominently (already stored) and the risk reason in plain language.
- **Labels:** "Summarize from terminal" is good; consider a tooltip clarifying it's a read-only
  snapshot summary, not a re-run.
- **Theme:** the Phase 11 light bubbles + glass sidebar look professional; ensure the code-block
  contrast inside light assistant bubbles stays legible across messages (verified for one case).

---

## 7. Security / safety observations

- **No API keys / no credential storage** — confirmed: providers shell out to the user's logged-in
  `claude`/`codex` CLIs; no keys read or written by Akorith. App data is local SQLite + a small
  JSON config only.
- **Single write path** — confirmed by grep: programmatic terminal input flows only through
  `bridgeSend → PtyManager.write`; the only other writer is the human-keystroke `pty:input`
  handler. The macro-loop (incl. permission responses) uses `bridgeSend`, never a second path.
- **Auto Mode safety** — `verify-agentic-loop.ts` confirms: Approval Mode never auto-answers;
  Auto Mode auto-answers only low-risk, one-time, high-confidence (≥0.6) confirmations; medium/
  high-risk, destructive (`rm -rf`/`sudo`/`--force`), "always allow", and low-confidence prompts
  all pause for the user; planner `high` risk pauses; Stop aborts at every await; every automatic
  action is logged to `macro_sessions.auto_actions`.
- **Permission handling** — never selects a permanent "always allow"; responses are short one-time
  tokens, not arbitrary commands.
- **Terminal snapshot** — read-only, bounded (120k ring; capped tail returned); no filesystem or
  exec surface.
- **Dashboard privacy** — usage charts read only `usage_events`; planner/summarizer/judge meta
  calls write none, so orchestration does not inflate usage stats.
- **Sample-project safety** — all sample work stayed under `~/Desktop/akorith-validation/`; repos
  are local-only with no remotes; no destructive commands were run; Codex `exec` runs left repos
  unmodified.

---

## 8. Packaging / release readiness

- **Packaged app:** `dist/mac-arm64/Akorith.app` — builds via `npm run pack:mac`.
- **Launch:** REAL — boots, shows ≥1 process, creates `~/Library/Application Support/Akorith/
  loopex.db` on startup (proves better-sqlite3 + node-pty load in the packaged context).
- **Identity/icon:** `CFBundleName`/`CFBundleDisplayName` = **Akorith**, `CFBundleIdentifier` =
  `com.akorith.app`, icon = `icon.icns`. Menu/Dock/window show Akorith in the packaged app.
- **Native modules:** `npmRebuild:false` + `asarUnpack` for node-pty/better-sqlite3; spawn-helper
  remains executable (verified in prior phases; DB creation reconfirms it here).
- **Gatekeeper/signing limitation:** ad-hoc signed only — distributing to other Macs needs Apple
  Developer-ID signing + notarization. **Open item before public download links.**
- **Windows:** NSIS config present but **not built** on macOS; needs a Windows build box.
- **Release checklist:** `docs/release-checklist.md` exists and is current.

---

## 9. Final recommendation

**Ready for private demo** — and very close to **public soft launch**.

Akorith does what it claims: it orchestrates real logged-in coding agents (Claude + Codex) with
no API keys, packages into a correctly-branded macOS app that launches and loads native modules,
and its safety model (single write path, cautious Auto Mode, meta-call/dashboard isolation) held
up under real review. Three real projects were built, tested, and AI-reviewed end-to-end.

The only things standing between "private demo" and "public soft launch" are **operational, not
functional**: (1) Developer-ID signing + notarization so external users don't hit Gatekeeper, and
(2) a short polish pass on empty states + an Auto-Mode "working…" affordance. Recommend shipping a
**private/TestFlight-style demo now**, and gating the public download on signing + notarization.
