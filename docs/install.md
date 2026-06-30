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

## 3. Run in development

```bash
npm install
npm run dev               # electron-vite dev server + Electron window
```

The `predev` hook patches the local dev Electron bundle so the **macOS menu bar
and Dock say "Akorith"** in dev too. (If you ever see "Electron", run
`node scripts/fix-dev-app-name.js` once, or reinstall.)

## Windows builds

Windows installers are best built on Windows or via the GitHub Actions **release**
workflow (a macOS host can't reliably cross-build a Windows NSIS installer). See
[`docs/packaging.md`](packaging.md).

## Keeping a source install current

Open **Settings → Update** in the app to fast-forward your checkout to GitHub
`main`. See [`docs/update-system.md`](update-system.md).
