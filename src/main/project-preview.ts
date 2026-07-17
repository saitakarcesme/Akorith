import { BrowserWindow, ipcMain, shell } from 'electron'
import { randomUUID } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { readFile, realpath, stat } from 'fs/promises'
import { createServer } from 'net'
import { basename, join, resolve } from 'path'

const SCRIPT_PRIORITY = ['dev', 'start', 'serve', 'preview'] as const
const MAX_LOG_LINES = 160
const MAX_CAPTURE_WIDTH = 1440

export interface ProjectPreviewInspection {
  projectPath: string
  projectName: string
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null
  scripts: string[]
  suggestedScript: string | null
  runnable: boolean
  note: string
}

export interface ProjectPreviewStatus {
  id: string
  projectPath: string
  projectName: string
  script: string
  state: 'starting' | 'running' | 'stopped' | 'error'
  url: string | null
  startedAt: number
  logs: string[]
  error?: string
}

interface PreviewSession extends ProjectPreviewStatus {
  process: ChildProcess
  previewWindow: BrowserWindow | null
}

const sessions = new Map<string, PreviewSession>()

function publicStatus(session: PreviewSession): ProjectPreviewStatus {
  const { process: _process, previewWindow: _previewWindow, ...status } = session
  return { ...status, logs: [...status.logs] }
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
  } catch {
    return false
  }
}

async function canonicalProjectPath(input: unknown): Promise<string> {
  if (typeof input !== 'string' || input.length < 1 || input.length > 4096) throw new Error('Choose a valid project folder.')
  const canonical = await realpath(resolve(input))
  if (!(await stat(canonical)).isDirectory()) throw new Error('The selected project path is not a folder.')
  return canonical
}

function packageManagerFor(root: string): ProjectPreviewInspection['packageManager'] {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun'
  if (existsSync(join(root, 'package.json'))) return 'npm'
  return null
}

export async function inspectProjectPreview(projectPath: unknown): Promise<ProjectPreviewInspection> {
  const root = await canonicalProjectPath(projectPath)
  const packageManager = packageManagerFor(root)
  let scripts: string[] = []
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    scripts = Object.entries(pkg.scripts ?? {}).filter(([, value]) => typeof value === 'string').map(([name]) => name)
  } catch {
    scripts = []
  }
  const suggestedScript = SCRIPT_PRIORITY.find((name) => scripts.includes(name)) ?? null
  return {
    projectPath: root,
    projectName: basename(root),
    packageManager,
    scripts,
    suggestedScript,
    runnable: Boolean(packageManager && suggestedScript),
    note: suggestedScript
      ? `Ready to run ${packageManager} ${packageManager === 'npm' ? 'run ' : ''}${suggestedScript}.`
      : 'Add a dev, start, serve, or preview script to enable the live project stream.'
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => port ? resolvePort(port) : reject(new Error('Could not reserve a preview port.')))
    })
  })
}

function commandFor(manager: NonNullable<ProjectPreviewInspection['packageManager']>, script: string): { command: string; args: string[] } {
  if (manager === 'npm') return { command: 'npm', args: ['run', script] }
  return { command: manager, args: [script] }
}

function addLog(session: PreviewSession, chunk: unknown): void {
  const lines = String(chunk).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  session.logs.push(...lines)
  if (session.logs.length > MAX_LOG_LINES) session.logs.splice(0, session.logs.length - MAX_LOG_LINES)
  for (const line of lines) {
    const match = line.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/[^\s]*)?/i)
    if (match && isLoopbackUrl(match[0])) session.url = match[0]
  }
}

function createPreviewWindow(session: PreviewSession): BrowserWindow {
  const previewWindow = new BrowserWindow({
    show: false,
    width: 1120,
    height: 720,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  previewWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  previewWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLoopbackUrl(url)) event.preventDefault()
  })
  previewWindow.on('closed', () => { session.previewWindow = null })
  return previewWindow
}

async function loadPreview(session: PreviewSession): Promise<void> {
  if (!session.url || !isLoopbackUrl(session.url) || session.state === 'stopped') return
  const previewWindow = session.previewWindow && !session.previewWindow.isDestroyed()
    ? session.previewWindow
    : createPreviewWindow(session)
  session.previewWindow = previewWindow
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await previewWindow.loadURL(session.url)
      session.state = 'running'
      return
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 350))
    }
  }
  session.error = 'The process started, but its local preview did not become reachable.'
}

async function startProject(input: unknown): Promise<ProjectPreviewStatus> {
  const args = input && typeof input === 'object' ? input as { projectPath?: unknown; script?: unknown } : {}
  const inspection = await inspectProjectPreview(args.projectPath)
  if (!inspection.packageManager || !inspection.suggestedScript) throw new Error(inspection.note)
  const script = typeof args.script === 'string' ? args.script : inspection.suggestedScript
  if (!SCRIPT_PRIORITY.includes(script as (typeof SCRIPT_PRIORITY)[number]) || !inspection.scripts.includes(script)) {
    throw new Error('Only a declared dev, start, serve, or preview script can be launched.')
  }

  for (const session of sessions.values()) {
    if (session.projectPath === inspection.projectPath && (session.state === 'starting' || session.state === 'running')) return publicStatus(session)
  }

  const port = await availablePort()
  const command = commandFor(inspection.packageManager, script)
  const child = spawn(command.command, command.args, {
    cwd: inspection.projectPath,
    env: { ...process.env, PORT: String(port), BROWSER: 'none', HOST: '127.0.0.1' },
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const session: PreviewSession = {
    id: randomUUID(),
    projectPath: inspection.projectPath,
    projectName: inspection.projectName,
    script,
    state: 'starting',
    url: `http://127.0.0.1:${port}`,
    startedAt: Date.now(),
    logs: [],
    process: child,
    previewWindow: null
  }
  sessions.set(session.id, session)
  child.stdout?.on('data', (chunk) => addLog(session, chunk))
  child.stderr?.on('data', (chunk) => addLog(session, chunk))
  child.once('error', (error) => {
    session.state = 'error'
    session.error = error.message
    addLog(session, error.message)
  })
  child.once('exit', (code) => {
    if (session.state !== 'stopped') {
      session.state = code === 0 ? 'stopped' : 'error'
      if (code !== 0) session.error = `Project process exited with code ${code ?? 'unknown'}.`
    }
  })
  void loadPreview(session)
  return publicStatus(session)
}

function requireSession(id: unknown): PreviewSession {
  if (typeof id !== 'string') throw new Error('Invalid preview session.')
  const session = sessions.get(id)
  if (!session) throw new Error('Preview session not found.')
  return session
}

async function captureProject(id: unknown): Promise<{ status: ProjectPreviewStatus; dataUrl: string | null; width: number; height: number }> {
  const session = requireSession(id)
  const previewWindow = session.previewWindow
  if (!previewWindow || previewWindow.isDestroyed() || session.state === 'error') return { status: publicStatus(session), dataUrl: null, width: 0, height: 0 }
  const bounds = previewWindow.getContentBounds()
  const scale = Math.min(1, MAX_CAPTURE_WIDTH / Math.max(1, bounds.width))
  const image = await previewWindow.webContents.capturePage()
  const resized = scale < 1 ? image.resize({ width: Math.round(bounds.width * scale) }) : image
  return { status: publicStatus(session), dataUrl: resized.toDataURL(), width: bounds.width, height: bounds.height }
}

async function stopProject(id: unknown): Promise<ProjectPreviewStatus> {
  const session = requireSession(id)
  session.state = 'stopped'
  if (session.previewWindow && !session.previewWindow.isDestroyed()) session.previewWindow.destroy()
  if (session.process.pid && !session.process.killed) {
    try {
      if (process.platform === 'win32') session.process.kill('SIGTERM')
      else process.kill(-session.process.pid, 'SIGTERM')
    } catch {
      session.process.kill('SIGTERM')
    }
  }
  return publicStatus(session)
}

export function stopAllProjectPreviews(): void {
  for (const id of sessions.keys()) void stopProject(id)
}

export function registerProjectPreviewIpc(): void {
  ipcMain.handle('projectPreview:inspect', (_event, path: unknown) => inspectProjectPreview(path))
  ipcMain.handle('projectPreview:start', (_event, input: unknown) => startProject(input))
  ipcMain.handle('projectPreview:status', (_event, id: unknown) => publicStatus(requireSession(id)))
  ipcMain.handle('projectPreview:active', async (_event, path: unknown) => {
    const projectPath = await canonicalProjectPath(path)
    const session = [...sessions.values()].find((candidate) => candidate.projectPath === projectPath && (candidate.state === 'starting' || candidate.state === 'running'))
    return session ? publicStatus(session) : null
  })
  ipcMain.handle('projectPreview:capture', (_event, id: unknown) => captureProject(id))
  ipcMain.handle('projectPreview:stop', (_event, id: unknown) => stopProject(id))
  ipcMain.handle('projectPreview:open', async (_event, id: unknown) => {
    const session = requireSession(id)
    if (!session.url || !isLoopbackUrl(session.url)) throw new Error('No local preview URL is available yet.')
    await shell.openExternal(session.url)
    return true
  })
  ipcMain.handle('projectPreview:reveal', async (_event, path: unknown) => {
    const projectPath = await canonicalProjectPath(path)
    shell.showItemInFolder(projectPath)
    return true
  })
  ipcMain.handle('projectPreview:input', (_event, input: unknown) => {
    const args = input && typeof input === 'object' ? input as { id?: unknown; type?: unknown; x?: unknown; y?: unknown; text?: unknown; key?: unknown } : {}
    const session = requireSession(args.id)
    const previewWindow = session.previewWindow
    if (!previewWindow || previewWindow.isDestroyed()) throw new Error('Live preview is not ready.')
    if ((args.type === 'move' || args.type === 'click') && Number.isFinite(args.x) && Number.isFinite(args.y)) {
      const x = Math.max(0, Math.round(Number(args.x)))
      const y = Math.max(0, Math.round(Number(args.y)))
      previewWindow.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      if (args.type === 'move') return true
      previewWindow.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y })
      previewWindow.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y })
      return true
    }
    if (args.type === 'text' && typeof args.text === 'string' && args.text.length <= 4000) {
      previewWindow.webContents.insertText(args.text)
      return true
    }
    if (args.type === 'key' && typeof args.key === 'string' && args.key.length <= 32) {
      previewWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: args.key })
      previewWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: args.key })
      return true
    }
    throw new Error('Unsupported preview input.')
  })
}
