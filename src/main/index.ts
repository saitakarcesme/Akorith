import { app, BrowserWindow, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'
import { getTheme, loadConfig, setTheme, type AppTheme } from './config'
import { ptyManager, registerPtyIpc } from './pty'
import { registerChatIpc } from './providers/registry'
import { warmLocalProvider } from './providers/local'
import { registerBridgeIpc } from './bridge'
import { registerRouterIpc } from './router'
import { registerDigestIpc } from './digest'
import { registerTestIpc } from './testlab-ipc'
import { registerBenchmarkIpc } from './benchmarks'
import { registerEvaluateIpc } from './evaluate'
import { registerMacroIpc, resumeActiveAutoLoopsAtStartup } from './macro'
import { registerOllamaConnectionIpc } from './ollama-connection'
import { registerGitStatusIpc } from './git-status'
import { registerProjectFilesIpc } from './project-files'
import { registerGpuStatusIpc } from './gpu-status'
import { registerRemoteTelemetryIpc } from './remote-telemetry'
import { registerControllerIpc, startControllerIfEnabled, stopController } from './controller'
import { registerPluginIpc } from './plugins/manager'
import { registerUpdateIpc } from './update'
import { registerUsageLimitsIpc } from './usage-limits'
import { registerAgentRegistryIpc } from './agents/registry'
import { registerMissionIpc } from './missions/inspector'
import { closeDb, ensureDbReady, registerDbIpc } from './db'
import { prepareStartupUserData, registerStartupSnapshotIpc } from './startupSnapshot'
import { registerBuildInfoIpc } from './build-info'
import { registerLocalRuntimeIpc } from './local-runtime'
import { registerProjectLoopIpc, startProjectLoopAutoScheduler, stopProjectLoopAutoScheduler } from './project-loop'
import { registerCompanionIpc } from './companions'
import { registerActionAgentIpc } from './action-agents'
import { registerGitHubActivityIpc } from './github-activity'
import { registerProjectPreviewIpc, stopAllProjectPreviews } from './project-preview'

let mainWindowRef: BrowserWindow | null = null
let splashWindowRef: BrowserWindow | null = null
const AKORITH_APP_ID = 'com.akorith.app'

// Visible app identity is Akorith. `app.setName` drives app.name, the
// "About Akorith"/"Hide Akorith"/"Quit Akorith" menu roles, and userData.
// NOTE: in *dev* the macOS menu-bar bold app name + dock tooltip still read
// "Electron" from node_modules' Electron.app Info.plist (CFBundleName), which no
// runtime API can change. The Phase 10 packaged build carries its own Info.plist
// (CFBundleName/CFBundleDisplayName = Akorith via electron-builder productName),
// so the packaged app shows Akorith in the menu bar and dock.
app.setName('Akorith')
if (process.platform === 'win32') {
  app.setAppUserModelId(AKORITH_APP_ID)
}
app.setAboutPanelOptions({ applicationName: 'Akorith', applicationVersion: app.getVersion() })

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
 * Phase 39: install an explicit Akorith application menu. The role-based items
 * (About/Hide/Quit) read app.name ("Akorith"), so the app menu and its entries
 * say Akorith. NOTE: in *dev* the bold menu-bar app-name still reads "Electron"
 * from node_modules' Electron.app Info.plist (CFBundleName), which no runtime API
 * can change; the packaged build carries its own Info.plist (productName=Akorith)
 * and shows Akorith everywhere.
 */
function applyApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'Akorith',
            submenu: [
              { role: 'about' as const, label: 'About Akorith' },
              { type: 'separator' as const },
              { role: 'hide' as const, label: 'Hide Akorith' },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const, label: 'Quit Akorith' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ role: 'front' as const }] : [{ role: 'close' as const }])] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function resolveAppIcon(): string | undefined {
  // macOS reads the application icon from the signed/bundled Info.plist. Passing
  // an .icns path as BrowserWindow.icon makes Electron's nativeImage loader try
  // to decode it as a window image and emits a false "Failed to load image"
  // warning even though Finder/Dock use the bundle icon correctly.
  if (process.platform === 'darwin') return undefined

  const base = app.getAppPath()
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE
  const winCandidates = [
    process.resourcesPath ? join(process.resourcesPath, 'icon.ico') : '',
    portableDir ? join(portableDir, 'icon.ico') : '',
    portableFile ? join(dirname(portableFile), 'icon.ico') : '',
    join(dirname(process.execPath), 'icon.ico'),
    join(base, 'build', 'icon.ico')
  ]
  const candidates =
    process.platform === 'win32'
      ? winCandidates
      : [join(process.resourcesPath, 'icon.png'), join(base, 'build', 'icon.png')]
  for (const iconPath of candidates) {
    if (!iconPath) continue
    if (existsSync(iconPath)) return iconPath
  }
  return undefined
}

function createSplashWindow(): BrowserWindow | null {
  // Inline the PNG as base64 so it renders inside the splash. The splash loads a
  // data: URL document with an opaque origin, and Electron blocks loading a
  // file:// resource from there — a file:// <img> just showed a broken placeholder.
  // Codex-style splash: a calm, solid screen without the retired logo asset.
  // The background follows the selected theme (mirrored to config for the splash,
  // since the renderer's localStorage doesn't exist yet at this point).
  const theme: AppTheme = getTheme()
  const bg = theme === 'light' ? '#ffffff' : '#181818'
  const fg = theme === 'light' ? '#1a1c1f' : '#ffffff'

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

    .splash-name {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: ${fg};
      font-size: 18px;
      font-weight: 650;
      letter-spacing: 0.01em;
      opacity: 0.86;
      animation: rise 420ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(8px) scale(0.96); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

  </style>
</head>
<body>
  <div class="splash-name">Akorith</div>
</body>
</html>`

  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined)
  splash.once('ready-to-show', () => splash.show())
  splash.on('closed', () => {
    if (splashWindowRef === splash) splashWindowRef = null
  })
  return splash
}

function createWindow(): void {
  const icon = resolveAppIcon()
  const splashWindow = createSplashWindow()
  splashWindowRef = splashWindow
  // Paint the main window in the selected theme's base color so there's no
  // bright flash between the splash and the rendered UI.
  const mainBg = getTheme() === 'light' ? '#ffffff' : '#181818'
  const useTransparentWindow = process.platform === 'darwin'
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: useTransparentWindow ? '#00000000' : mainBg,
    transparent: useTransparentWindow,
    autoHideMenuBar: true,
    title: 'Akorith',
    ...(process.platform === 'darwin'
      ? {
          frame: false,
          // CSS backdrop-filter cannot blur the native desktop seen through a
          // transparent Electron window. macOS vibrancy supplies the real
          // wallpaper blur; opaque renderer surfaces cover it outside sidebar.
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const
        }
      : {}),
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: mainBg,
            symbolColor: getTheme() === 'light' ? '#1a1c1f' : '#ffffff',
            height: 46
          }
        }
      : {}),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindowRef = mainWindow

  // Keep the splash up for a guaranteed minimum so it's actually seen, even when
  // the renderer is ready almost instantly. Reveal the main window once the
  // renderer reports ready; if Electron never emits `ready-to-show`, fall back to
  // `did-finish-load` / a bounded timer so launch can never get stuck invisible.
  const MIN_SPLASH_MS = 1500
  const MAX_HIDDEN_MS = 5000
  const splashShownAt = Date.now()
  let revealed = false
  const reveal = (): void => {
    if (revealed || mainWindow.isDestroyed()) return
    revealed = true
    const wait = Math.max(0, MIN_SPLASH_MS - (Date.now() - splashShownAt))
    setTimeout(() => {
      if (mainWindow.isDestroyed()) return
      mainWindow.show()
      if (splashWindow && !splashWindow.isDestroyed()) {
        setTimeout(() => {
          if (!splashWindow.isDestroyed()) splashWindow.close()
        }, 220)
      }
    }, wait)
  }

  mainWindow.once('ready-to-show', reveal)
  mainWindow.webContents.once('did-finish-load', reveal)
  mainWindow.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    console.error(`[main] failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`)
    reveal()
  })
  setTimeout(reveal, MAX_HIDDEN_MS)

  mainWindow.on('closed', () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[main] renderer process gone: ${details.reason} (${details.exitCode})`)
    if (!mainWindow.isDestroyed() && details.reason !== 'clean-exit') {
      mainWindow.reload()
    }
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

function registerWindowControlsIpc(): void {
  ipcMain.handle('window:minimize', (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.handle('window:close', (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.handle('window:toggleFullscreen', (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    win.setFullScreen(!win.isFullScreen())
  })
}

function warmLocalProviderAtStartup(): void {
  const entry = loadConfig().providers.local
  if (!entry?.enabled || entry.autoStart === false) return
  warmLocalProvider(entry)
}

async function initializeStartupData(): Promise<void> {
  if (process.env.AKORITH_SKIP_DB_INIT === '1') return
  try {
    await ensureDbReady()
    resumeActiveAutoLoopsAtStartup()
    startProjectLoopAutoScheduler()
  } catch (err) {
    console.error('[db] SQLite initialization failed:', err)
  }
}

app.whenReady().then(() => {
  ensureCliPath()
  prepareStartupUserData()
  registerStartupSnapshotIpc()
  registerBuildInfoIpc()
  registerLocalRuntimeIpc()
  registerProjectLoopIpc()
  registerCompanionIpc()
  registerActionAgentIpc()
  registerGitHubActivityIpc()
  registerProjectPreviewIpc()
  registerDbIpc()
  registerPtyIpc()
  registerChatIpc()
  registerBridgeIpc()
  registerRouterIpc()
  registerDigestIpc()
  registerTestIpc()
  registerBenchmarkIpc()
  registerEvaluateIpc()
  registerAgentRegistryIpc()
  registerMissionIpc()
  registerMacroIpc()
  registerOllamaConnectionIpc()
  registerGitStatusIpc()
  registerProjectFilesIpc()
  registerGpuStatusIpc()
  registerRemoteTelemetryIpc()
  registerControllerIpc()
  registerPluginIpc()
  registerUpdateIpc()
  registerUsageLimitsIpc()
  registerSettingsIpc()
  registerWindowControlsIpc()
  applyAppIdentity()
  applyApplicationMenu()
  createWindow()

  // Open the first window before touching the native SQLite module, then start
  // DB hydration immediately. Startup IPC reads await this readiness gate and
  // no longer return false-empty project/chat lists while SQLite is opening.
  void initializeStartupData().finally(() => {
    warmLocalProviderAtStartup()
    // Phase 35: optional controller API — starts only if the user enabled it.
    void startControllerIfEnabled()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// No zombie shells: every PTY dies with the app.
app.on('will-quit', () => {
  stopProjectLoopAutoScheduler()
  stopAllProjectPreviews()
  ptyManager.killAll()
  closeDb()
  void stopController()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
