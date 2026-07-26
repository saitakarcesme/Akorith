# Phase 73 — Workspace `/loop` Skill

Phase 73 retires Akorith's standalone Loop navigation and moves durable autonomous Goals into the
project Workspace composer. The Goal engine and its historical data remain; only the separate page
and product entry point are removed.

## Product contract

The skill activates only in a persisted project Workspace. A concrete task must end with the exact
`/loop` token:

```text
Fix the export flow and verify the Windows package /loop
```

Matching is case-insensitive and permits trailing whitespace. `/loop` by itself is invalid.
Occurrences in the middle of prose, Markdown blockquotes, quotes, inline code, or unfinished fenced
code are content rather than commands. Attachments are not accepted for `/loop` goals. The composer
offers a suffix hint, but it does not start work until the user sends the message.

The standalone `loops` App view, sidebar row, feature preloader, page mount, `ProjectLoopPage.tsx`,
and `LoopPipeline.tsx` are removed. Startup sanitizes a stale saved `loops` view to `workspace`, so
upgrading users are never routed to a missing page.

## Durable state and final-answer rule

Starting the skill creates the underlying Goal loop, adds its first backlog objective, and persists
both the clean user task and an assistant status message. `workspace_goal_bindings` records:

- the binding, loop, session, and idempotent request ids;
- the persisted user and assistant message ids;
- provider, model, canonical project path, and goal;
- status, attempt count, error, and lifecycle timestamps.

The same assistant message is updated as work progresses. Its `workspaceGoal.final` metadata is
`true` only when the Goal reaches `completed`. Understand, plan, execute, analyze, and replan cycles
must produce a completion review with sufficient confidence and inspectable evidence. A pause,
provider error, explicit blocker, repeated stalled cycles, or maximum-cycle review state is saved as
nonfinal. The Workspace card exposes Pause or Resume as appropriate; no blocker is presented as the
requested result.

## Recovery and concurrency

Each active Goal owns an abort controller. Pause checkpoints the durable state; Resume first verifies
that the session still points to the same canonical project path. App startup marks a cycle that was
running during shutdown as interrupted and relaunches every binding durably left in `running`.
Graceful shutdown aborts provider calls only after arranging for those Goals to remain recoverable.

A partial unique database index permits only one `running` Workspace Goal for a canonical project
path. Starting a second Goal in that project is rejected. Normal Workspace execute requests and
`/loop` start/resume/recovery paths also acquire the same synchronous, canonical-path main-process
writer lease for their full provider lifetime. This closes both check-then-act directions behind the
renderer, so alternate callers cannot create two concurrent writers.

## Usage accounting

Workspace Goals use the same additive `usage_events` ledger as the rest of Akorith:

- one visible request row with `request_count=1`;
- token/cost rows with `request_count=0` for understand, execute, and review;
- stable `source_kind=workspace-loop` and source ids for idempotent retries.

The assistant status remains attached to the originating session, so history restoration and
Dashboard accounting retain the same identity after restart.

## Git boundary

Workspace `/loop` works inside the user's selected project and may edit files or run validation.
Akorith's host path deliberately does not take ownership of version control, and its executor prompt
also instructs the selected CLI to leave Git history unchanged:

- no `git init`;
- no automatic staging;
- no automatic commits;
- no pull, rebase, or push.

The binding forces `pushEnabled=false`, and Goal cycles use the `workspaceGoal` execution path that
bypasses repository initialization and commit/push logic. For Local/Ollama patches, rejected changes
are restored from file-scoped snapshots without staging or rewriting Git history. Restoration must
succeed before Akorith records a rollback; a failure becomes a nonfinal `needs_review` state.

This differs from historical standalone Loop modes that could create managed repositories and
publish checkpoints. Those Phase 20–72 descriptions remain in the architecture history, but they do
not describe the current Workspace `/loop` Git policy.

## Verification

Run:

```bash
npm run verify:workspace-skill-loop
npm run verify:goal-cycle
npm run verify:project-loop
npm run verify:startup-hydration
npm run typecheck
npm run build
```

The focused skill verifier covers exact-suffix parsing, quote/code exclusions, suggestion insertion,
Workspace-only dispatch, attachment ordering, the durable IPC path, completion-only final metadata,
persisted bindings/messages, and a real two-contender canonical writer-lease race.
