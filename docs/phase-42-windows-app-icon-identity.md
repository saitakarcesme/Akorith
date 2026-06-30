# Phase 42 - Windows App Icon Identity

Phase 42 fixes the Windows side of Akorith's desktop identity. The goal is
that installed Windows builds, shortcuts, the taskbar group, the NSIS
installer, Apps & Features, and the executable resources all say Akorith and
use the Akorith icon.

## Audit

- Windows packaging config already lives in `package.json` under `build`.
- `productName` is `Akorith`.
- `appId` is `com.akorith.app`.
- `win.executableName` is `Akorith`.
- `win.icon` points to `build/icon.ico`.
- `nsis.shortcutName` and `nsis.uninstallDisplayName` are Akorith-based.
- `build/icon.ico` exists and contains Akorith artwork with the required
  Windows sizes: 16, 24, 32, 48, 64, 128, and 256 px.
- Renderer favicon assets are Akorith assets under `src/renderer/public`.
- Main process calls `app.setName('Akorith')` and titles the window
  `Akorith`.

## Root Cause Found On The Windows PC

The PC showed the Electron icon because the local `npm run dist:win` attempt
failed while Electron Builder was extracting its Windows resource-editing
helper (`winCodeSign`). Windows refused to create two macOS symlinks inside
that helper archive:

```text
Cannot create symbolic link : A required privilege is not held by the client.
```

Electron Builder had already produced `dist/win-unpacked/Akorith.exe`, but it
had not completed the resource-edit step that applies:

- the Akorith `.ico`,
- `ProductName`,
- `FileDescription`,
- `OriginalFilename`,
- and other Windows executable metadata.

Launching or manually copying that incomplete `win-unpacked` executable leaves
Windows seeing Electron's default resources. The correct fix is to complete a
real Windows package/install flow, not to copy the pre-resource-edit unpacked
folder.

## Phase 42 Fixes

- Keep and validate the Akorith multi-size Windows `.ico`.
- Make Windows installer icon fields explicit, not just the app executable
  icon.
- Set the Windows AppUserModelID before creating windows so taskbar grouping
  and shortcut identity use the same app id as Electron Builder.
- Add a Windows refresh helper that avoids deleting user data and warns when
  the local builder cannot finish because Windows symlink creation is disabled.
- Expand release checks so a future release cannot silently drift back to
  Electron/default Windows identity settings.
- Document Windows stale icon/cache recovery steps.

## Preserved

This phase does not change provider runtime, Claude/Codex/Ollama/OpenCode
behavior, PTY lifecycle, the bridge write path, controller security, local user
data, `loopex.db`, or `loopex.config.json`.
