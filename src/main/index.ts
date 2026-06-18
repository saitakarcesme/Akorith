import { app, BrowserWindow, ipcMain, nativeImage, shell } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { getTheme, loadConfig, setTheme, type AppTheme } from './config'
import { ptyManager, registerPtyIpc } from './pty'
import { registerChatIpc } from './providers/registry'
import { warmLocalProvider } from './providers/local'
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
  // Inline the PNG as base64 so it renders inside the splash. The splash loads a
  // data: URL document with an opaque origin, and Electron blocks loading a
  // file:// resource from there — a file:// <img> just showed a broken placeholder.
  let logoUrl = ''
  if (existsSync(logoPath)) {
    try {
      logoUrl = `data:image/png;base64,${readFileSync(logoPath).toString('base64')}`
    } catch {
      logoUrl = ''
    }
  }
  // Codex-style splash: a calm, solid screen with just the centered Akorith mark.
  // The background follows the selected theme (mirrored to config for the splash,
  // since the renderer's localStorage doesn't exist yet at this point).
  const theme: AppTheme = getTheme()
  const bg = theme === 'light' ? '#f2f3f5' : '#101012'
  const ring = theme === 'light' ? 'rgba(15, 17, 21, 0.08)' : 'rgba(255, 255, 255, 0.08)'
  const shadow =
    theme === 'light' ? '0 18px 50px rgba(15, 17, 21, 0.14)' : '0 18px 50px rgba(0, 0, 0, 0.55)'

  const splash = new BrowserWindow({
    width: 420,
    height: 300,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: bg,
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
      background: ${bg};
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .mark {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
    }

    img {
      width: 96px;
      height: 96px;
      object-fit: contain;
      border-radius: 24px;
      box-shadow: ${shadow}, 0 0 0 1px ${ring};
      animation:
        rise 600ms cubic-bezier(0.22, 1, 0.36, 1) both,
        breathe 2600ms ease-in-out 600ms infinite;
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(8px) scale(0.96); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes breathe {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.035); }
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
  // Paint the main window in the selected theme's base color so there's no
  // bright flash between the splash and the rendered UI.
  const mainBg = getTheme() === 'light' ? '#f2f3f5' : '#101012'
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: mainBg,
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

  // Keep the splash up for a guaranteed minimum so it's actually seen, even when
  // the renderer is ready almost instantly. Reveal the main window only once it's
  // ready AND that minimum has elapsed — so there's never a blank gap.
  const MIN_SPLASH_MS = 1500
  const splashShownAt = Date.now()
  mainWindow.on('ready-to-show', () => {
    const wait = Math.max(0, MIN_SPLASH_MS - (Date.now() - splashShownAt))
    setTimeout(() => {
      mainWindow.show()
      if (splashWindow && !splashWindow.isDestroyed()) {
        setTimeout(() => {
          if (!splashWindow.isDestroyed()) splashWindow.close()
        }, 220)
      }
    }, wait)
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

// Theme is owned by the renderer, but mirrored to config so the next launch's
// splash can paint the matching background before any renderer exists.
function registerSettingsIpc(): void {
  ipcMain.handle('settings:getTheme', (): AppTheme => getTheme())
  ipcMain.handle('settings:setTheme', (_event, theme: unknown): AppTheme =>
    setTheme(theme === 'light' ? 'light' : 'dark')
  )
}

function warmLocalProviderAtStartup(): void {
  const entry = loadConfig().providers.local
  if (!entry?.enabled || entry.autoStart === false) return
  warmLocalProvider(entry)
}

app.whenReady().then(() => {
  ensureCliPath()
  warmLocalProviderAtStartup()
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
  registerSettingsIpc()
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
