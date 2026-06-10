import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'

// TODO(phase 2): node-pty session manager — spawn `claude` / `codex` CLIs in PTYs
//                and stream their output to the renderer terminals over IPC.
// TODO(phase 3): chat backends (Claude / ChatGPT / local Ollama) — no API keys; route
//                planner-chat requests from the renderer through the main process.
// TODO(phase 4): SQLite session history persistence backing the sidebar folders.

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    title: 'Agent Workspace',
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
  // TODO(phase 2): register IPC handlers here (terminal create/write/resize, prompt bridge).
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
