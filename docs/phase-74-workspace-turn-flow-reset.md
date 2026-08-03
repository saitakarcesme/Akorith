# Phase 74 — Workspace Turn-Flow Reset

Phase 74 replaces simulated Workspace narration with the actual provider event stream, isolates
model choices by chat surface, makes Browser natively interactive, and clears Research/Benchmark
for redesign.

## Resulting Workspace flow

1. The user sends one request from a project Workspace.
2. Akorith persists the user message and one pending assistant turn.
3. Exact provider commentary appears above the current real action. Commands, file changes, plans,
   reasoning, tool calls, and failures update by stable event id and are persisted live.
4. The elapsed-time disclosure opens the complete chronological event log. No synthetic narration
   or fake progress sentence is generated.
5. Tool work finishes, then one final assistant answer and the truthful changed-file summary appear.
6. Reloading an interrupted task recovers its persisted progress rather than inventing completion.

General Chat and each project Workspace restore independent provider/model selections. Browser uses
a loopback-only sandboxed `WebContentsView` for native input; Computer Use remains the explicit
offscreen automation surface. Research and Benchmark are empty navigation shells and have no active
legacy runtime. Existing DB rows are retained.

## Verification

```powershell
npm run verify:workspace-activity
npm run verify:replica-ui
npm run verify:performance
npm run typecheck
npm run build
npm run verify:bundle
```
