# Phase 41 — Public Release Packaging, App Identity, Installable Akorith

Branched from `main` (`77bdb24`, post-Phase-40). Makes Akorith feel like a real desktop
app: Akorith identity everywhere (incl. the **dev** menu bar), hardened macOS/Windows
packaging, a GitHub Actions release workflow, install/refresh scripts, and install/release
docs. No website, no runtime/provider/controller/PTY changes; `npm run dev` stays.

## Audit (starting state)

- `package.json` `build`: appId `com.akorith.app`, productName **Akorith**, mac `dmg`+`zip`,
  win `nsis` (shortcutName Akorith), linux `AppImage`; icons present (`build/icon.{icns,ico,png}`).
- Main process (Phase 39): `app.setName('Akorith')` at module load + About panel + an explicit
  Akorith application menu; window `title: 'Akorith'`. Packaged app verified Akorith.
- **Gap — dev menu bar reads "Electron":** it comes from `node_modules/electron`'s own
  `Electron.app/Contents/Info.plist` `CFBundleName` = `Electron`, which `app.setName` cannot
  change at runtime. **Fixable in dev** by patching that Info.plist's `CFBundleName`/
  `CFBundleDisplayName` to Akorith (the menu reads `CFBundleName`, not the executable).
- **Gaps — packaging/release:** no `.github/workflows/`, no `artifactName`s, NSIS lacks
  uninstall display name / desktop shortcut, no release/refresh npm scripts beyond pack/dist.

## Plan / commits

- `41.1` Audit + plan (this doc).
- `41.2` Dev app identity: `scripts/fix-dev-app-name.js` patches the dev Electron bundle's
  `CFBundleName` → Akorith (macOS only, idempotent, dev-only); wired into `postinstall` + `predev`.
- `41.3` Harden macOS packaging (artifactName, darkModeSupport, dmg, unsigned-local).
- `41.4` Harden Windows installer (artifactName, executableName, NSIS uninstall/shortcut, portable).
- `41.5` Release build + refresh npm scripts.
- `41.6` GitHub Actions `release.yml` (workflow_dispatch + `v*` tags; mac+win; unsigned unless secrets).
- `41.7` Install/cleanup scripts (`clean-old-akorith-apps.sh`, `release-check.js`).
- `41.8` README install/release refresh.
- `41.9` `docs/packaging.md` + `docs/install.md` + release-checklist updates.
- `41.10` Build + install the packaged macOS app locally.
- `41.11` Final validation + merge.

## Signing / notarization

No Apple Developer cert or Windows Authenticode cert is assumed. Local + CI builds are
**unsigned** (Gatekeeper/SmartScreen will warn on other machines). Signing/notarization is
documented as optional/future and only runs in CI if the relevant secrets are configured —
never faked.

## Preserved

Claude/Codex/Ollama/OpenCode runtime, token accounting, controller security (disabled by
default, token-protected), `bridgeSend → PtyManager.write`, Olympus/Gaia/Atlantis, PTY kinds,
`loopex.db`/`loopex.config.json`, `npm run dev`. No mission execution, no secrets.
