# Phase 42: Startup Data Hydration and Persistence Reliability

Phase 42 fixes a startup race where Akorith could look like a first-time install
even though projects and chats already existed in SQLite.

## Root Cause

The main process registered DB-backed IPC handlers and opened the renderer before
SQLite was initialized. SQLite startup was delayed by one second. During that
window:

- `projects:list` returned `[]` when the DB was not ready.
- `history:list` returned `[]` when the DB was not ready.
- The renderer accepted those empty arrays as real data.
- Sidebar empty states rendered immediately.
- Later actions such as Open Project or Send Message reloaded the same IPC after
  SQLite was ready, making old projects/chats appear late.

The data was present on disk; the startup hydration path was unreliable.

## Startup Snapshot Contract

The renderer now boots through `window.api.app.getStartupSnapshot()`. The snapshot
waits for DB readiness and returns one structured payload:

- app paths: userData, DB path, config path
- safe settings: theme, bridge auto-enter, digest status, router provider map,
  provider ids
- all managed projects
- all sessions/chats
- validated restore target for last active project/chat/view
- diagnostics: DB/config readiness, load time, project/chat counts, warnings, and
  legacy userData migration status

Normal startup should return arrays, even when empty. It should not return a
false-empty list simply because SQLite is still opening.

## Readiness Changes

`initDb()` is idempotent and `ensureDbReady()` gates startup reads. DB-backed IPC
handlers now await readiness instead of returning empty arrays before SQLite opens.
The first window still opens before touching the native SQLite module, but DB
hydration starts immediately rather than after a fixed delay.

## Renderer Hydration

`App.tsx` reads persisted local preferences, requests the startup snapshot, and
then restores a validated target:

- last active chat if it still exists
- otherwise last active project and its latest chat
- otherwise a sensible latest chat/project/general fallback
- otherwise the empty workspace

Saved project/session ids are not cleared until startup hydration finishes.
Sidebar project/chat lists are seeded from the snapshot, and project chats are
expanded when the project has chats unless the user already persisted a collapse
choice.

## Empty States

Sidebar empty states wait for real hydration:

- before hydration: loading rows
- after a hydration error: retry action
- after successful hydration with no data: true empty states

This prevents the app from flashing a first-run state while persisted data is
still loading.

## UserData Path Finding

Phase 42 checks known legacy userData folders (`Electron`, `letsgetit`, `Loopex`)
before DB startup. It only copies missing `loopex.db` / `loopex.config.json`
files into the current Akorith userData folder when the current target is absent.
It never overwrites current Akorith data and never deletes legacy data.

On the Windows PC used for this phase, `%APPDATA%\Akorith\loopex.db` already
existed and contained data. `%APPDATA%\Electron` had only a config file, so the
observed bug was not caused by an old DB folder.

## Verification

```bash
npm run typecheck
npm run verify:startup-hydration
npm run build
```

The focused verifier exercises the pure restore/counting contract without
touching private user data or requiring Electron to boot.
