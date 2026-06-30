# Packaging & Release

How Akorith is packaged into installable apps, and how to cut a release.

## Configuration

All packaging is configured in `package.json` under `build` (electron-builder):

- `appId: com.akorith.app`, `productName: Akorith` → bundle/app name is **Akorith**.
- **macOS:** `dmg` + `zip`, host architecture, `darkModeSupport`, icon `build/icon.icns`.
  Native modules (`node-pty`, `better-sqlite3`) are `asarUnpack`ed.
- **Windows:** `nsis` installer + `portable` exe (x64), `executableName: Akorith`, icon
  `build/icon.ico`. NSIS: non-one-click, choose-install-dir, desktop + Start-menu
  shortcuts named **Akorith**, `uninstallDisplayName: Akorith <version>`.
- **Linux:** `AppImage` (icon `build/icon.png`).
- `artifactName`s embed product/version/os/arch.

## App identity (Electron → Akorith)

- **Packaged app:** the build carries its own Info.plist (`CFBundleName`/
  `CFBundleDisplayName` = Akorith), so the **menu bar, Dock, and Finder all say
  Akorith**. The main process also calls `app.setName('Akorith')`, sets the About
  panel, installs an explicit Akorith application menu, and titles the window Akorith.
- **Dev (`npm run dev`):** Electron runs from `node_modules`' own `Electron.app`.
  `scripts/fix-dev-app-name.js` (run by `predev` + `postinstall`) patches that dev-only
  bundle's `CFBundleName`/`CFBundleDisplayName` to **Akorith** as a best effort.
  **Honest limitation:** on current macOS the dev menu bar may still read "Electron",
  because electron-vite launches the Electron binary directly (not via LaunchServices),
  so macOS names the app from the running executable — which neither `app.setName` nor
  the Info.plist patch reliably overrides, and which LaunchServices caches. This is a
  dev-only cosmetic issue; the **packaged** app is Akorith everywhere and is what users run.

## Build locally

```bash
npm run release:check     # read-only preflight (identity, icons, targets, git, tag)
npm run pack:mac          # fast unpacked .app → dist/mac*/Akorith.app
npm run dist:mac          # dmg + zip → dist/
npm run refresh:mac       # back up old copies + install + open the new app
npm run clean:apps        # just back up old Akorith.app copies (no build/install)
```

Windows from a Windows host:

```bash
npm run dist:win          # nsis + portable → dist/
```

> A macOS host cannot reliably cross-build a Windows NSIS installer (needs Wine/extra
> tooling). Prefer the CI workflow for Windows artifacts.

## Release via GitHub Actions

`.github/workflows/release.yml` builds **unsigned** artifacts on `macos-latest`
(dmg+zip) and `windows-latest` (nsis+portable):

- **Manual:** Actions → "release" → Run workflow (optionally tick "Create a draft release").
- **Tag:** `git tag v0.1.0 && git push origin v0.1.0` → builds + a **draft prerelease**
  with the artifacts attached.

It never publishes a public/stable release automatically — only drafts/prereleases.
No secrets are required for unsigned builds.

## Signing & notarization (future / optional)

Unsigned artifacts work for local use but trigger Gatekeeper (macOS) / SmartScreen
(Windows) on other machines. To sign later:

- **macOS:** add `CSC_LINK` + `CSC_KEY_PASSWORD` (Developer ID), and for notarization
  `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`; remove
  `CSC_IDENTITY_AUTO_DISCOVERY: false` from the macOS CI step.
- **Windows:** add an Authenticode cert via `CSC_LINK` / `CSC_KEY_PASSWORD`.

Signing is **never faked** — until certs are configured, builds are honestly unsigned.

## Output

Artifacts land in `dist/` (git-ignored). Do not commit `dist/`.
