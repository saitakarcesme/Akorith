import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
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
// NOTE: in dev the macOS *menu-bar bold app name* and the *dock tooltip* are
// read from the running Electron.app bundle's Info.plist (CFBundleName =
// "Electron") and cannot be overridden at runtime — that requires a packaged
// build with productName (Phase 10). Everything else below is fixed here.
app.setName('Akorith')

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
