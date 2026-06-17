import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { pathToFileURL } from 'url'
import { ptyManager, registerPtyIpc } from './pty'
import { registerChatIpc } from './providers/registry'
import { registerBridgeIpc } from './bridge'
import { registerRouterIpc } from './router'
import { registerDigestIpc } from './digest'
import { registerTestIpc } from './testlab-ipc'
import { registerEvaluateIpc } from './evaluate'
import { registerMacroIpc } from './macro'
import { closeDb, initDb, registerDbIpc } from './db'

// Visible app identity is Akorith. `app.setName` drives app.name, the
// "About Akorith"/"Hide Akorith"/"Quit Akorith" menu roles, and userData.
// NOTE: in *dev* the macOS menu-bar bold app name + dock tooltip still read
// "Electron" from node_modules' Electron.app Info.plist (CFBundleName), which no
// runtime API can change. The Phase 10 packaged build carries its own Info.plist
// (CFBundleName/CFBundleDisplayName = Akorith via electron-builder productName),
// so the packaged app shows Akorith in the menu bar and dock.
app.setName('Akorith')

/**
 * macOS/Linux GUI apps launched from Finder/Dock inherit a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), so `claude`/`codex`/`ollama` installed in
 * Homebrew or a user bin dir are invisible — terminals would always fall back to
 * a plain shell and providers would read as unavailable. This prepends the
 * well-known install locations (only those that exist, only if not already on
 * PATH) so the existing PATH-based resolution in pty.ts / providers works in a
 * packaged build. No shell is spawned and nothing is eval'd — just static dirs.
 */
function ensureCliPath(): void {
  if (process.platform === 'win32') return
  const home = homedir()
  const candidates = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.deno', 'bin'),
    join(home, '.cargo', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  const current = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  const seen = new Set(current)
  const additions = candidates.filter((dir) => !seen.has(dir) && existsSync(dir))
  if (additions.length > 0) {
    process.env['PATH'] = [...additions, ...current].join(delimiter)
  }
}

/** Make the macOS "About" panel and app-menu roles say Akorith, not Electron. */
function applyAppIdentity(): void {
  app.setAboutPanelOptions({
    applicationName: 'Akorith',
    applicationVersion: app.getVersion(),
    credits: 'Akorith — agent orchestration with no API keys.'
  })
}

/**
 * Prefer the raster Akorith logo (works with nativeImage for the dock /
 * window icon); fall back to the vector mark. Returns the first asset present.
 */
function resolveAppIcon(): string | undefined {
  const base = app.getAppPath()
  const candidates =
    process.platform === 'win32'
      ? [
          ['build', 'icon.ico'],
          ['assets', 'akorith-logo.png'],
          ['assets', 'akorith-icon.svg']
        ]
      : [
          ['assets', 'akorith-logo.png'],
          ['assets', 'akorith-icon.svg']
        ]
  for (const rel of candidates) {
    const iconPath = join(base, ...rel)
    if (existsSync(iconPath)) return iconPath
  }
  return undefined
}

/** macOS dock icon — needs a raster image; SVG yields an empty nativeImage. */
function applyDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const pngPath = join(app.getAppPath(), 'assets', 'akorith-logo.png')
  if (!existsSync(pngPath)) return
  const image = nativeImage.createFromPath(pngPath)
  if (!image.isEmpty()) app.dock.setIcon(image)
}

function createSplashWindow(): BrowserWindow | null {
  const logoPath = join(app.getAppPath(), 'assets', 'akorith-logo.png')
  const logoUrl = existsSync(logoPath) ? pathToFileURL(logoPath).toString() : ''
  const splash = new BrowserWindow({
    width: 360,
    height: 260,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#241235',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html,
    body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background:
        radial-gradient(circle at 18% 28%, rgba(99, 235, 168, 0.78), transparent 28%),
        radial-gradient(circle at 76% 22%, rgba(165, 91, 255, 0.72), transparent 30%),
        radial-gradient(circle at 34% 82%, rgba(47, 186, 133, 0.64), transparent 33%),
        conic-gradient(from 130deg at 50% 50%, #201033, #57349a, #1f8e79, #7d3fb4, #201033);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    body::before,
    body::after {
      content: "";
      position: absolute;
      inset: -35%;
      background:
        repeating-radial-gradient(ellipse at 48% 52%, rgba(255, 255, 255, 0.18) 0 1px, transparent 1px 10px),
        conic-gradient(from 35deg, transparent, rgba(13, 224, 157, 0.24), transparent, rgba(177, 96, 255, 0.3), transparent);
      mix-blend-mode: screen;
      filter: blur(8px) saturate(1.35);
      transform: rotate(-8deg) scale(1.08);
    }

    body::after {
      filter: blur(15px) saturate(1.2);
      opacity: 0.72;
      transform: rotate(13deg) scale(1.18);
    }

    .mark {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
    }

    img {
      width: 86px;
      height: 86px;
      object-fit: contain;
      border-radius: 22px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(255, 255, 255, 0.2);
    }
  </style>
</head>
<body>
  <div class="mark">${logoUrl ? `<img src="${logoUrl}" alt="" />` : ''}</div>
</body>
</html>`

  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined)
  splash.once('ready-to-show', () => splash.show())
  return splash
}

function createWindow(): void {
  const icon = resolveAppIcon()
  const splashWindow = createSplashWindow()
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#f4f4f3',
    autoHideMenuBar: true,
    title: 'Akorith',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (splashWindow && !splashWindow.isDestroyed()) {
      setTimeout(() => {
        if (!splashWindow.isDestroyed()) splashWindow.close()
      }, 450)
    }
  })

  mainWindow.on('closed', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
  })

  // Phase 14.4: nudge the whole UI up one comfortable notch. A single zoom
  // factor scales every font/control/spacing uniformly (the layout viewport
  // reflows, so nothing is clipped) — cleaner than per-component font bumps.
  // Re-applied on each load so it survives reloads/HMR.
  const UI_ZOOM = 1.1
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(UI_ZOOM)
  })

  // Any external links open in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // HMR dev server URL in development, bundled file in production.
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ensureCliPath()
  initDb()
  registerDbIpc()
  registerPtyIpc()
  registerChatIpc()
  registerBridgeIpc()
  registerRouterIpc()
  registerDigestIpc()
  registerTestIpc()
  registerEvaluateIpc()
  registerMacroIpc()
  applyAppIdentity()
  applyDockIcon()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// No zombie shells: every PTY dies with the app.
app.on('will-quit', () => {
  ptyManager.killAll()
  closeDb()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
