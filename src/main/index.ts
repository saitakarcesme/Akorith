import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
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
  for (const rel of [
    ['assets', 'akorith-logo.png'],
    ['assets', 'akorith-icon.svg']
  ]) {
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

function createWindow(): void {
  const icon = resolveAppIcon()
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b10',
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
