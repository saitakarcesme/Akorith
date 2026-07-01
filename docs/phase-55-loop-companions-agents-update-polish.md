# Phase 55 - Loop, Companions, Agents, Update Polish

## Audit

This phase addresses the screenshot-visible rough edges in the new Loop,
Companions, and Agents surfaces, plus Windows update and packaged identity
reliability.

### What is broken

- Companions sends a temporary user bubble, but it uses a fixed `tmp` id, has no
  stable pending lifecycle, has no cancellation guard, and the loading state is
  just a bare ellipsis. A first-session send can be visually replaced by the
  persisted reload in a way that makes the user message feel late.
- Companions composer controls use a text `Send` button instead of the circular
  icon-only ChatPanel action button style. There is no matching Stop control for
  an in-flight companion response.
- Agents creation is functionally a modal, but the shell is generic and sparse.
  The create buttons and template actions inherit too much of the default flat
  button look, so the page feels cheap beside the command-surface UI.
- Loop creation currently navigates into a large create screen. It is better
  than a literal bottom-left form, but it still feels detached from the Loop
  Operations Center and does not share a polished creation shell with Agents.
- Creation form styling is duplicated across pages through `modal`, `loop-field`,
  and one-off button classes. There is no reusable command modal, field, footer,
  or action-button vocabulary.
- The update system is still source-checkout focused. Packaged mode says release
  auto-updates are later, which is honest but not useful for the user who wants
  Settings -> Update to update the installed Windows app.
- Windows identity is mostly present (`app.setName`, `productName`, `appId`,
  `executableName`, NSIS icons, BrowserWindow icon), but the update flow can
  still produce confusion if it updates source only while the packaged app stays
  old.

### Why the screenshots look wrong

- The creation controls do not occupy a deliberate modal/drawer surface with a
  clear header, body, and footer. The result reads like debug UI instead of a
  premium command center.
- Buttons have inconsistent radius, padding, and hover/focus affordances across
  Agents, Loop, Companions, and Settings.
- Empty states leave too much untreated space, and their CTAs do not share the
  same visual language as the rest of Akorith.
- Companions does not immediately show a polished "message sent, assistant is
  thinking" state, so the interaction feels delayed even when the model call is
  underway.

### Current create flow architecture

- `AgentsPage.tsx` owns its own `CreateAgentModal` and calls
  `window.api.actionAgent.create`. It picks folders through
  `window.api.actionAgent.pickFolder` and refreshes local state after success.
- `LoopsPage.tsx` uses a `view` state with `list`, `create`, and `detail`.
  Templates populate create state and switch to the create view. Creation calls
  `window.api.macro.createWorkspaceProject`, optionally starts the executor, then
  selects the created loop detail.
- Existing CSS has generic `.modal-*` styles for project creation and ad hoc
  `.loop-field` styles used by Agents and Loop forms.

### Current update architecture

- `src/main/update/checker.ts` detects whether `app.getAppPath()` is a git repo.
  Git/source mode checks `origin/main`, branch state, dirty files, ahead/behind,
  and fast-forward safety.
- `src/main/update/runner.ts` only updates source checkouts by running fixed git
  commands and optional npm install/build. It never resets, discards, or runs
  remote-supplied commands.
- `UpdatePanel.tsx` exposes that source updater. Packaged mode currently reports
  that packaged release auto-updates are not implemented.

### Current Windows app identity/icon architecture

- `package.json` has `appId: "com.akorith.app"`, `productName: "Akorith"`,
  `win.executableName: "Akorith"`, NSIS `shortcutName: "Akorith"`, and icon
  paths for installer/uninstaller/header.
- `src/main/index.ts` calls `app.setName("Akorith")` and, on Windows,
  `app.setAppUserModelId("com.akorith.app")` before creating windows.
- `resolveAppIcon()` prefers `build/icon.ico` on Windows and passes it into
  `BrowserWindow`.
- `scripts/refresh-windows-app.ps1` stops installed Akorith, backs up stale
  Akorith/Electron shortcuts, builds `dist:win`, runs the NSIS installer, and
  launches the installed executable. It warns about the winCodeSign symlink
  issue and avoids copying `dist/win-unpacked`.

## Implementation Plan

1. Add shared renderer primitives for command modals, form fields, button
   variants, icon buttons, and composer action buttons.
2. Rework Companions send state around stable optimistic messages, pending
   assistant placeholders, inline errors, request tokens, cancellation, and
   deduped persisted reloads.
3. Replace Companions Send/Stop text controls with shared circular icon-only
   controls using the existing `SendIcon` and `StopIcon`.
4. Upgrade Agents creation to the shared command modal, richer fields, template
   summary, safety toggles, polished buttons, success selection, and responsive
   scrolling.
5. Move Loop creation into a shared command modal launched from the Operations
   Center, keeping the existing `createLoop` backend path and detail selection.
6. Extend update status and runner types so the UI can distinguish dev/source,
   packaged Windows, and packaged macOS, and so Windows can run a packaged
   refresh/install path instead of pretending a source update updated the app.
7. Add a Windows identity verification script and wire
   `npm run verify:windows-identity`.
8. Update documentation for creation modals, companion message behavior, update
   behavior, and Windows identity.

## Verification Plan

- `npm run typecheck`
- `npm run build`
- `npm run verify:companions`
- `npm run verify:agents`
- `npm run verify:project-loop`
- `npm run verify:windows-identity`
- `npm run verify:startup-hydration`
- Manual packaged Windows check where possible: Settings -> Update shows the
  executable path, packaged/source mode, relaunch target, and never claims source
  updates changed the installed app unless the refresh/install flow ran.

## Delivered

- Shared command-modal, field, footer, and action-button primitives.
- Companions optimistic user messages, immediate thinking state, inline errors,
  real IPC cancellation, and circular Send/Stop controls.
- Agents creation moved to a centered command modal with template summary,
  folder picker, local model, permission mode, validation-command toggle,
  permission explanation, success state, and polished CTAs.
- Loop creation moved into a centered command modal with Project Builder, Repo
  Grower, GitHub Repo Loop, Maintenance Loop, and Multi-Repo Loop presets.
- Update status now distinguishes dev/source/packaged Windows/packaged macOS,
  reports executable and relaunch targets, and can start the packaged Windows
  refresh/install flow from a clean source checkout.
- Windows identity verification added as `npm run verify:windows-identity`.

## Remaining Limitations

- Packaged Windows refresh still depends on a local source checkout and local
  build tooling. It is not a GitHub Releases auto-updater yet.
- The winCodeSign symlink fallback produces a usable unsigned local installer,
  but a fully resource-edited executable still needs Windows Developer Mode or
  Administrator privileges for the normal Electron Builder helper extraction.
- Packaged macOS update remains a manual installer/app refresh path.
