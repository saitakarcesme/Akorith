# Akorith — In-App Update System

Akorith ships an in-app **source updater** for git/dev installs. It keeps a local
checkout current with GitHub `main` without you dropping to a terminal. It is
deliberately conservative: **read-only check first, fast-forward only, never
discards your work.**

Open it at **Settings → Update**. The Dashboard also shows a small
"up to date / update available" badge.

## What it shows (read-only check)

- current branch, current commit, `origin/main` commit
- behind / ahead counts, dirty (uncommitted) status
- masked remote URL (any embedded credentials are stripped)
- last-checked time and any warnings

Backing git commands (all bounded, no shell):
`rev-parse --show-toplevel`, `branch --show-current`, `rev-parse HEAD`,
`fetch origin`, `rev-parse origin/main`, `status --porcelain`,
`rev-list --left-right --count HEAD...origin/main`.

## What the update does

Enabled **only** when a clean fast-forward is possible (working tree clean, on or
able to switch to `main`, `origin/main` reachable, and you click Update):

1. `git fetch origin`
2. `git switch main` (if not already on it)
3. `git merge --ff-only origin/main`
4. *(optional)* `npm install --no-audit --no-fund`
5. *(optional)* `npm run build`

Then it recommends a restart to load the new build.

## Safety rules (hard constraints)

- Never `git reset --hard`, never discards or stashes your changes.
- Never force-pushes, never deletes branches, never touches other repos.
- Never runs remote-supplied commands — only the fixed commands above.
- Refuses to update a **dirty** tree (asks you to commit/stash first).
- Refuses if the fast-forward would fail (diverged history) — you resolve manually.
- Command output in the log panel is bounded and secret-masked (no tokens).

## Packaged installs

Settings -> Update now distinguishes:

- dev mode (`npm run dev` / electron-vite)
- source checkout mode
- packaged Windows app
- packaged macOS/other app

In packaged Windows mode, Akorith does **not** pretend that `git pull` updates
the installed app. It shows the current executable path, detected source
checkout, update target, and relaunch target. When a clean source checkout is
available, **Update installed Windows app** fast-forwards the checkout if
needed, starts `scripts/refresh-windows-app.ps1`, builds a Windows installer,
runs that installer, and relaunches the installed `Akorith.exe`.

If local Electron Builder cannot extract `winCodeSign` because Windows symlink
creation is disabled, the refresh script falls back to a local unsigned
installer build with executable signing/resource editing disabled. It still
installs the generated NSIS installer and never treats `dist/win-unpacked` as an
installed app.

Packaged macOS/other app updates still require a manual installer/app refresh
from a source checkout.

## Keeping Mac + PC in sync

On each machine that runs Akorith from source: open **Settings → Update**, click
**Check for updates**, then **Update to latest main**. That replaces the manual
`git pull` on both machines.
