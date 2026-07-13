# Installing Akorith

Three ways to run Akorith, from easiest to most hands-on.

## 1. Download a release (recommended for users)

Once a release is published, grab the artifact for your OS from the repo's
**Releases** page:

- **macOS:** `Akorith-<version>-mac-<arch>.dmg` (or `.zip`). Open the DMG, drag
  **Akorith.app** to Applications, launch it.
- **Windows:** `Akorith-Setup-<version>-x64.exe` (installer) or
  `Akorith-<version>-portable-x64.exe` (no install). Run it; a desktop/Start-menu
  shortcut named **Akorith** is created by the installer.

> Builds are currently **unsigned**. macOS Gatekeeper may say the app is from an
> unidentified developer — right-click → **Open** the first time (or
> `xattr -dr com.apple.quarantine /Applications/Akorith.app`). Windows SmartScreen
> may warn — choose **More info → Run anyway**. Signing/notarization is planned.

After installing, sign in to the agent CLIs you use (Akorith never stores these):
`claude` login, Codex login, `opencode auth login`, `gh auth login`, and/or
`ollama serve`. See [`docs/setup.md`](setup.md).

## 2. Build from source (macOS)

```bash
git clone https://github.com/saitakarcesme/Akorith.git
cd Akorith
npm install
npm run dist:mac          # → dist/Akorith-<version>-mac-<arch>.dmg + .zip
npm run refresh:mac       # back up old copies + install the new Akorith.app
```

`npm run refresh:mac` moves any existing `Akorith.app` (in `/Applications`,
`~/Applications`, Desktop, Downloads) to a timestamped `~/Desktop/Akorith-old-apps-*`
backup (never deletes), installs the freshly built app, and opens it. Your data
(`~/Library/Application Support/akorith*`) is never touched.

## 2b. Build from source (Windows)

```powershell
git clone https://github.com/saitakarcesme/Akorith.git
cd Akorith
npm install
npm run dist:win          # builds installer + portable app under dist/
npm run refresh:win       # backs up stale shortcuts, installs, launches
```

Use the generated `Akorith-Setup-<version>-x64.exe` installer for normal use.
Do not install by copying `dist\win-unpacked` after a failed packaging run; if
Electron Builder stops before its Windows resource-edit step, that executable
can still carry Electron's default icon/metadata.

`npm run refresh:win` never removes Akorith user data/config/db. It only backs
up clearly Akorith-owned stale shortcuts, uses Akorith-identifying uninstall
entries, runs the latest installer when available, and prints manual recovery
steps when it cannot safely proceed.

## Existing projects and chats on launch

Akorith should load existing projects and chats immediately on launch. The
packaged app reads local data from the Akorith userData folder, for example
`%APPDATA%\Akorith` on Windows, and waits for SQLite readiness before rendering
the sidebar as empty.

If projects/chats do not appear after installing a new build:

1. Fully quit Akorith and reopen the packaged app.
2. Confirm you launched packaged Akorith, not `npm run dev`.
3. Check Settings/About logs or console diagnostics for the userData, DB, and
   config paths reported by startup hydration.
4. Do not delete `loopex.db`; it contains local chat/project history.

Phase 42 also performs a conservative legacy userData check. It can copy missing
DB/config files from known old app folders only when the current Akorith targets
do not exist; it never overwrites current data.

## 3. Run in development

```bash
npm install
npm run dev               # electron-vite dev server + Electron window
```

The `predev` hook patches the local dev Electron bundle name as a best effort.
Note: on current macOS the dev menu bar may **still** read "Electron" — electron-vite
launches the Electron binary directly, so macOS names the app from the running
executable, which the patch can't reliably override. The **packaged** app
(`/Applications/Akorith.app`) shows Akorith everywhere and is what users run.

## Windows builds

Windows installers are best built on Windows or via the GitHub Actions **release**
workflow (a macOS host can't reliably cross-build a Windows NSIS installer). See
[`docs/packaging.md`](packaging.md).

If Windows still shows the Electron icon after installing:

1. Uninstall old Akorith/Electron entries from **Settings > Apps** if they
   clearly belong to Akorith.
2. Delete stale Desktop/Start Menu shortcuts and unpin the old taskbar icon.
3. Install the latest `Akorith-Setup-<version>-x64.exe`.
4. Restart Explorer, or clear the Windows icon cache if the old icon persists.
5. Launch packaged Akorith, not `npm run dev`.

## Keeping a source install current

Open **Settings → Update** in the app to fast-forward your checkout to GitHub
`main`. See [`docs/update-system.md`](update-system.md).
