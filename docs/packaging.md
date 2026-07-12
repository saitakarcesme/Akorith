# Packaging & Release

How Akorith is packaged into installable apps, and how to cut a release.

## Configuration

All packaging is configured in `package.json` under `build` (electron-builder):

- `appId: com.akorith.app`, `productName: Akorith` → bundle/app name is **Akorith**.
- **macOS:** `dmg` + `zip`, host architecture, `darkModeSupport`, icon `build/icon.icns`.
  Native modules (`node-pty`, `better-sqlite3`) are `asarUnpack`ed.
- **Windows:** `nsis` installer + `portable` exe (x64), `executableName: Akorith`, icon
  `build/icon.ico`, and explicit NSIS installer/uninstaller/header icons. NSIS:
  non-one-click, choose-install-dir, desktop + Start-menu shortcuts named
  **Akorith**, `uninstallDisplayName: Akorith <version>`.
- **Linux:** `AppImage` (icon `build/icon.png`).
- `artifactName`s embed product/version/os/arch.

## App identity (Electron → Akorith)

- **Packaged app:** the build carries its own Info.plist (`CFBundleName`/
  `CFBundleDisplayName` = Akorith), so the **menu bar, Dock, and Finder all say
  Akorith**. The main process also calls `app.setName('Akorith')`, sets the About
  panel, installs an explicit Akorith application menu, and titles the window Akorith.
- **Windows packaged app:** Electron Builder must finish the executable resource
  edit step (`win.signAndEditExecutable`). That step applies `build/icon.ico` and
  the Akorith version metadata to `Akorith.exe`. The main process also calls
  `app.setAppUserModelId('com.akorith.app')` before windows are created so taskbar
  grouping matches the packaged app id.
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
npm run dist:win          # nsis + portable -> dist/
npm run refresh:win       # clean stale shortcuts, build/install, launch (Windows only)
npm run verify:windows-identity
```

> A macOS host cannot reliably cross-build a Windows NSIS installer (needs Wine/extra
> tooling). Prefer the CI workflow for Windows artifacts.

### Windows icon troubleshooting

If the Windows app still shows the Electron icon after installing a new build:

1. Make sure you are launching packaged Akorith, not `npm run dev` and not a
   manually copied `dist/win-unpacked` folder from a failed build.
2. Uninstall old Akorith/Electron entries from **Settings > Apps** if they clearly
   belong to Akorith.
3. Delete stale Desktop/Start Menu shortcuts and unpin old taskbar icons.
4. Install the latest `Akorith-Setup-<version>-x64.exe`.
5. Restart Explorer, or clear the Windows icon cache if the old icon persists.

On Windows you can use:

```powershell
npm run refresh:win
```

The helper is conservative: it backs up stale Akorith shortcuts to the Desktop,
uses only Akorith-identifying uninstall entries, never touches Akorith user
data/config/db, and refuses to install by copying `dist\win-unpacked`. If
`npm run dist:win` fails with a `winCodeSign` symbolic-link privilege error,
the helper retries with an unsigned local installer build that disables
executable signing/resource editing, then still installs through NSIS. For a
fully resource-edited executable, enable Windows Developer Mode or run the shell
as Administrator, then retry the normal build.

## Startup data hydration

Packaged Akorith stores local config and SQLite history under the Electron
`userData` path for the Akorith app name, for example `%APPDATA%\Akorith` on
Windows. On launch, the renderer uses `window.api.app.getStartupSnapshot()` to
wait for DB readiness and hydrate projects/chats from one complete snapshot.
This prevents the packaged app from showing a false first-run sidebar while
SQLite is still opening.

If a previous build wrote data under an old Electron/Loopex folder, Akorith only
copies missing `loopex.db` / `loopex.config.json` files into the current Akorith
folder when the current target is absent. It never overwrites current Akorith
data and never deletes legacy data. See
[`docs/phase-42-startup-data-hydration.md`](phase-42-startup-data-hydration.md).

## Release via GitHub Actions

The active `.github/workflows/release.yml` accepts an exact stable or beta tag whose
package/lockfile version matches and whose commit is contained in `origin/main`. Native
Windows and macOS jobs require signing/notarization credentials, build with
`--publish never`, verify signatures, notarization, packaged launch, channel YAML, and
SHA-512 inventories, then upload private workflow artifacts. Only after both platforms
pass does the write-enabled job create a draft, upload the exact inventory, and finalize
the GitHub Release. A failure removes the draft and existing releases are immutable.

Manual dispatch takes an existing tag and uses the same gates; it cannot publish an
arbitrary branch. Required secret names and the complete stable/beta process are in
[`production-updates-releases.md`](production-updates-releases.md).

Local packages may be unsigned and are suitable for development only. They cannot enter
the production publication job and are not evidence that release signing succeeded.

## Output

Artifacts land in `dist/` (git-ignored). Do not commit `dist/`.
