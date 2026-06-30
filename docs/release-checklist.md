# Akorith release checklist

Practical steps to cut a build and (optionally) publish it. Tick top-to-bottom.

## 1. Pre-build verification

- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] `node --experimental-strip-types scripts/verify-macro-loop.ts` → `verify-macro-loop: ok`.
- [ ] `node --experimental-strip-types scripts/verify-testlab.ts` → `19 passed, 0 failed`.
- [ ] Version bumped in `package.json` if this is a release (`version`).

## 2. Package

- [ ] macOS unpacked smoke build: `npm run pack:mac` → `dist/mac-arm64/Akorith.app`.
- [ ] macOS installers (optional): `npm run dist:mac` → `.dmg` + `.zip` in `dist/`.
- [ ] Windows (on a Windows machine): `npm run dist:win`.
- [ ] Confirm native modules unpacked: `dist/mac-arm64/Akorith.app/Contents/Resources/app.asar.unpacked/node_modules/{node-pty,better-sqlite3}` exist.
- [ ] Confirm `node-pty` `darwin-arm64/spawn-helper` is present and executable (`-rwxr-xr-x`).

## 3. Launch the packaged app

- [ ] `open dist/mac-arm64/Akorith.app` launches without crashing.
- [ ] App name in the **menu bar** says **Akorith** (not Electron).
- [ ] **Dock** tooltip / Finder name says **Akorith**.
- [ ] **Window title** says Akorith; **About Akorith** shows the right name.
- [ ] **Icon** in Dock/Finder is the Akorith logo.
- [ ] App data lands in `~/Library/Application Support/Akorith/` (`loopex.db`, `loopex.config.json`).

## 4. Functional smoke test (in the packaged app)

- [ ] Workspace route opens (sidebar | center chat | right terminals).
- [ ] Dashboard route opens.
- [ ] Test route opens.
- [ ] **Open Project** picks a folder and persists it.
- [ ] **Create Project** modal: name + parent folder → creates and activates the project.
- [ ] Olympus starts **Codex** and Atlantis starts **Claude** in the project cwd
      (or falls back to a shell with a clear message if a CLI is missing — see §5).
- [ ] Macro-loop: enter a goal, get one proposal, approve sends it to a terminal
      (semi-automatic; nothing auto-runs).
- [ ] No credentials/API keys requested or stored anywhere.

## 5. Packaged-app CLI availability (macOS PATH)

GUI apps launched from Finder inherit a minimal `PATH`. Akorith prepends common install
dirs (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, …) at startup so logged-in
CLIs resolve.

- [ ] With `claude`/`codex` installed in Homebrew or `/usr/local/bin`, terminals start the
      real CLI (header shows Codex/Claude, not Shell).
- [ ] With a CLI missing, the pane falls back to a shell and prints a clear Akorith message
      (no crash); the provider shows as unavailable in chat.

## 6. Publish (GitHub release)

- [ ] Commit + push `main` is green.
- [ ] Tag the release (`git tag vX.Y.Z && git push --tags`).
- [ ] Create a GitHub Release; attach `dist/*.dmg` / `dist/*.zip` (and Windows installer
      when built). **Do not commit `dist/` artifacts** — they are git-ignored.
- [ ] Release notes: what's new + the one-line connect prompt from the README.
- [ ] (Future) code-sign + notarize before wide distribution to avoid Gatekeeper warnings.

## 7. Announcement (X/Twitter) checklist

- [ ] One-sentence pitch: "Akorith orchestrates your logged-in coding agents (Claude/Codex)
      with no API keys."
- [ ] Screenshot or short demo clip of the 3-pane Workspace.
- [ ] Link to the GitHub release / repo.
- [ ] Call out: no API keys, runs your own CLI subscriptions, local data only.
- [ ] Note current limitations honestly (semi-automatic, no autopilot).

## 9. Phase 41 packaging & release (installable Akorith)

- [ ] `npm run release:check` → 0 errors (identity, icons, mac/win targets, workflow, git/tag).
- [ ] **macOS:** `npm run dist:mac` → `dist/Akorith-<version>-mac-<arch>.dmg` + `.zip`;
      `npm run refresh:mac` backs up old copies and installs `/Applications/Akorith.app`.
- [ ] **Windows:** build on a Windows host (`npm run dist:win`) or via CI — a macOS host
      cannot cross-build the NSIS installer.
- [ ] **CI:** GitHub Actions "release" workflow (`workflow_dispatch` or `git push origin v<version>`)
      builds unsigned mac+win artifacts and creates a draft prerelease.
- [ ] **Identity:** packaged menu bar / Dock / Finder say Akorith; dev menu bar says Akorith
      via `scripts/fix-dev-app-name.js`.
- [ ] **Signing:** artifacts are unsigned until certs are configured — never faked.
      See `docs/packaging.md` and `docs/install.md`.

## 8. Phase 39 tooling (source installs)

- [ ] **Keep checkouts current:** Settings → Update fast-forwards a source install to
      `origin/main` (see `docs/update-system.md`). Replaces manual `git pull` on Mac + PC.
- [ ] **Refresh the packaged macOS app:** `npm run pack:mac` then `npm run macos:refresh`
      (old copies are MOVED to `~/Desktop/Akorith-old-apps-<stamp>/`, never deleted; user
      data/config/db untouched).
- [ ] **One-command bootstrap on a new machine:** `npm run setup` (macOS/Linux) or
      `pwsh scripts/setup-akorith.ps1` (Windows); `npm run doctor` for a check-only pass.
      See `docs/setup.md`.
- [ ] **iCloud trap:** if the repo is under `~/Desktop`/`~/Documents`, relocate
      `node_modules` out of the synced tree (the setup script prints the fix).
