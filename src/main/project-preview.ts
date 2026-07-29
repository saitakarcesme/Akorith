import { BrowserWindow, ipcMain, shell } from 'electron'
import { randomUUID } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { createReadStream, existsSync } from 'fs'
import { readFile, realpath, stat } from 'fs/promises'
import { createServer as createHttpServer, type Server as HttpServer, type ServerResponse } from 'http'
import { createServer as createNetServer } from 'net'
import { homedir } from 'os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'path'

const SCRIPT_PRIORITY = ['dev', 'start', 'serve', 'preview'] as const
const STATIC_SCRIPT = 'static'
const MAX_LOG_LINES = 160
const MAX_CAPTURE_WIDTH = 1440
const DEFAULT_VIEWPORT_WIDTH = 1120
const DEFAULT_VIEWPORT_HEIGHT = 720
const MIN_VIEWPORT_WIDTH = 320
const MIN_VIEWPORT_HEIGHT = 240
const MAX_VIEWPORT_WIDTH = 1920
const MAX_VIEWPORT_HEIGHT = 1200
const PREVIEW_READY_TIMEOUT_MS = 8_000
const PREVIEW_READY_POLL_MS = 100
const BROWSER_SCRIPT = 'browser'
const PREVIEW_INPUT_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Backspace',
  'Delete',
  'End',
  'Enter',
  'Escape',
  'Home',
  'PageDown',
  'PageUp',
  'Space',
  'Tab'
])
const STATIC_MIME_TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.avif', 'image/avif'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.wasm', 'application/wasm'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm']
])

export type ProjectPreviewBrowser = 'default' | 'chrome'
export type OpenedProjectPreviewStatus = ProjectPreviewStatus & { url: string }
export interface WorkspacePreviewOpenRequest {
  workspacePath: unknown
  browser?: ProjectPreviewBrowser
}

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
  canGoBack?: boolean
  canGoForward?: boolean
}

interface PreviewSession extends ProjectPreviewStatus {
  process: ChildProcess | null
  staticServer: HttpServer | null
  previewWindow: BrowserWindow | null
  viewportWidth: number
  viewportHeight: number
  renderQueue: Promise<void>
}

const sessions = new Map<string, PreviewSession>()

function publicStatus(session: PreviewSession): ProjectPreviewStatus {
  const {
    process: _process,
    staticServer: _staticServer,
    previewWindow: _previewWindow,
    viewportWidth: _viewportWidth,
    viewportHeight: _viewportHeight,
    renderQueue: _renderQueue,
    ...status
  } = session
  const previewWindow = session.previewWindow
  const webContents = previewWindow && !previewWindow.isDestroyed() && !previewWindow.webContents.isDestroyed()
    ? previewWindow.webContents
    : null
  const currentUrl = webContents?.getURL()
  return {
    ...status,
    url: currentUrl && isLoopbackUrl(currentUrl) ? currentUrl : status.url,
    logs: [...status.logs],
    canGoBack: webContents?.canGoBack() ?? false,
    canGoForward: webContents?.canGoForward() ?? false
  }
}

function queuePreviewOperation<T>(session: PreviewSession, operation: () => Promise<T>): Promise<T> {
  const result = session.renderQueue.catch(() => undefined).then(operation)
  session.renderQueue = result.then(() => undefined, () => undefined)
  return result
}

function viewportDimension(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid preview viewport ${label}.`)
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}

async function settlePreviewLayout(previewWindow: BrowserWindow): Promise<void> {
  if (previewWindow.isDestroyed() || previewWindow.webContents.isDestroyed()) return
  await new Promise<void>((resolveSettled) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveSettled()
    }
    const timeout = setTimeout(finish, 120)
    void previewWindow.webContents
      .executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true)
      .then(finish, finish)
  })
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

function isContainedPath(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

async function canonicalStaticIndex(root: string): Promise<string | null> {
  try {
    const index = await realpath(join(root, 'index.html'))
    return isContainedPath(root, index) && (await stat(index)).isFile() ? index : null
  } catch {
    return null
  }
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
  const staticIndex = await canonicalStaticIndex(root)
  let scripts: string[] = []
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    scripts = Object.entries(pkg.scripts ?? {}).filter(([, value]) => typeof value === 'string').map(([name]) => name)
  } catch {
    scripts = []
  }
  const declaredScript = SCRIPT_PRIORITY.find((name) => scripts.includes(name)) ?? null
  const suggestedScript = declaredScript ?? (staticIndex ? STATIC_SCRIPT : null)
  return {
    projectPath: root,
    projectName: basename(root),
    packageManager,
    scripts,
    suggestedScript,
    runnable: Boolean((packageManager && declaredScript) || staticIndex),
    note: declaredScript
      ? `Ready to run ${packageManager} ${packageManager === 'npm' ? 'run ' : ''}${suggestedScript}.`
      : staticIndex
        ? 'Ready to serve index.html on a private loopback preview.'
        : 'Add an index.html or a dev, start, serve, or preview script to enable the live project stream.'
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => port ? resolvePort(port) : reject(new Error('Could not reserve a preview port.')))
    })
  })
}

function endStaticResponse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  })
  response.end(message)
}

async function resolveStaticRequest(root: string, requestUrl: string): Promise<{ path: string; size: number; mimeType: string }> {
  const rawPath = requestUrl.split(/[?#]/, 1)[0] || '/'
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    throw new Error('malformed')
  }
  if (decoded.includes('\0') || decoded.includes('\\')) throw new Error('forbidden')

  const segments = decoded.split('/').filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new Error('forbidden')
  }
  const requested = resolve(root, ...segments)
  if (!isContainedPath(root, requested)) throw new Error('forbidden')

  let canonical: string
  try {
    canonical = await realpath(requested)
  } catch {
    throw new Error('missing')
  }
  if (!isContainedPath(root, canonical)) throw new Error('forbidden')

  let fileStat = await stat(canonical)
  if (fileStat.isDirectory()) {
    try {
      canonical = await realpath(join(canonical, 'index.html'))
      if (!isContainedPath(root, canonical)) throw new Error('forbidden')
      fileStat = await stat(canonical)
    } catch (error) {
      if (error instanceof Error && error.message === 'forbidden') throw error
      throw new Error('missing')
    }
  }
  if (!fileStat.isFile()) throw new Error('missing')

  const mimeType = STATIC_MIME_TYPES.get(extname(canonical).toLowerCase())
  if (!mimeType) throw new Error('forbidden')
  return { path: canonical, size: fileStat.size, mimeType }
}

async function serveStaticRequest(
  root: string,
  method: string | undefined,
  requestUrl: string | undefined,
  response: ServerResponse
): Promise<void> {
  if (method !== 'GET' && method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD')
    endStaticResponse(response, 405, 'Method not allowed')
    return
  }

  let file: Awaited<ReturnType<typeof resolveStaticRequest>>
  try {
    file = await resolveStaticRequest(root, requestUrl ?? '/')
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'missing'
    if (reason === 'malformed') endStaticResponse(response, 400, 'Malformed request path')
    else if (reason === 'forbidden') endStaticResponse(response, 403, 'Forbidden')
    else endStaticResponse(response, 404, 'Not found')
    return
  }

  response.writeHead(200, {
    'Content-Type': file.mimeType,
    'Content-Length': file.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin'
  })
  if (method === 'HEAD') {
    response.end()
    return
  }
  const stream = createReadStream(file.path)
  stream.once('error', () => response.destroy())
  response.once('close', () => stream.destroy())
  stream.pipe(response)
}

async function startStaticServer(root: string): Promise<{ server: HttpServer; url: string }> {
  const server = createHttpServer((request, response) => {
    void serveStaticRequest(root, request.method, request.url, response)
      .catch(() => {
        if (!response.headersSent) endStaticResponse(response, 500, 'Preview server error')
        else response.destroy()
      })
  })
  server.unref()
  return new Promise((resolveServer, reject) => {
    const fail = (error: Error): void => {
      server.close()
      reject(error)
    }
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail)
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      if (!port) {
        fail(new Error('Could not start the static preview server.'))
        return
      }
      resolveServer({ server, url: `http://127.0.0.1:${port}/` })
    })
  })
}

function commandFor(manager: NonNullable<ProjectPreviewInspection['packageManager']>, script: string): { command: string; args: string[] } {
  const runnerArgs = manager === 'npm' ? ['run', script] : [script]
  if (process.platform === 'win32') {
    // npm/pnpm/yarn are command shims on Windows. Node 22's shell:false spawn
    // cannot execute those shims directly (`npm` => ENOENT, `npm.cmd` =>
    // EINVAL), while cmd.exe resolves the fixed allowlisted runner correctly.
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', manager, ...runnerArgs]
    }
  }
  return { command: manager, args: runnerArgs }
}

function projectPreviewInputKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (PREVIEW_INPUT_KEYS.has(value)) return value
  return Array.from(value).length === 1 && !/[\p{Cc}\p{Cs}]/u.test(value) ? value : null
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
    width: session.viewportWidth,
    height: session.viewportHeight,
    useContentSize: true,
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
  const recordNavigation = (_event: Electron.Event, url: string): void => {
    if (isLoopbackUrl(url)) session.url = url
  }
  previewWindow.webContents.on('did-navigate', recordNavigation)
  previewWindow.webContents.on('did-navigate-in-page', recordNavigation)
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
  session.state = 'error'
  session.error = 'The local preview did not become reachable.'
}

async function waitForPreviewReady(session: PreviewSession, timeoutMs = PREVIEW_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (session.state === 'running') return
    if (session.state === 'error') throw new Error(session.error ?? 'The project preview failed to start.')
    if (session.state === 'stopped') throw new Error('The project preview stopped before it became ready.')
    await new Promise((resolveWait) => setTimeout(resolveWait, PREVIEW_READY_POLL_MS))
  }
  throw new Error('The project preview did not become ready in time.')
}

export async function startProjectPreview(input: unknown): Promise<ProjectPreviewStatus> {
  const args = input && typeof input === 'object' ? input as { projectPath?: unknown; script?: unknown } : {}
  const inspection = await inspectProjectPreview(args.projectPath)
  if (!inspection.suggestedScript) throw new Error(inspection.note)
  const script = typeof args.script === 'string' ? args.script : inspection.suggestedScript
  const staticPreview = script === STATIC_SCRIPT
  if (staticPreview) {
    if (!(await canonicalStaticIndex(inspection.projectPath))) throw new Error('A contained index.html is required for a static preview.')
  } else if (
    !inspection.packageManager ||
    !SCRIPT_PRIORITY.includes(script as (typeof SCRIPT_PRIORITY)[number]) ||
    !inspection.scripts.includes(script)
  ) {
    throw new Error('Only a declared dev, start, serve, or preview script can be launched.')
  }

  for (const session of sessions.values()) {
    if (session.projectPath === inspection.projectPath && (session.state === 'starting' || session.state === 'running')) return publicStatus(session)
  }

  if (staticPreview) {
    const runtime = await startStaticServer(inspection.projectPath)
    const session: PreviewSession = {
      id: randomUUID(),
      projectPath: inspection.projectPath,
      projectName: inspection.projectName,
      script: STATIC_SCRIPT,
      state: 'starting',
      url: runtime.url,
      startedAt: Date.now(),
      logs: ['Serving index.html on a private loopback preview.'],
      process: null,
      staticServer: runtime.server,
      previewWindow: null,
      viewportWidth: DEFAULT_VIEWPORT_WIDTH,
      viewportHeight: DEFAULT_VIEWPORT_HEIGHT,
      renderQueue: Promise.resolve()
    }
    sessions.set(session.id, session)
    runtime.server.once('error', (error) => {
      if (session.state === 'stopped') return
      session.state = 'error'
      session.error = error.message
      addLog(session, error.message)
    })
    runtime.server.once('close', () => {
      if (session.state !== 'stopped' && session.state !== 'error') session.state = 'stopped'
    })
    void loadPreview(session)
    return publicStatus(session)
  }

  const port = await availablePort()
  const command = commandFor(inspection.packageManager!, script)
  const child = spawn(command.command, command.args, {
    cwd: inspection.projectPath,
    env: { ...process.env, PORT: String(port), BROWSER: 'none', HOST: '127.0.0.1' },
    shell: false,
    windowsHide: true,
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
    staticServer: null,
    previewWindow: null,
    viewportWidth: DEFAULT_VIEWPORT_WIDTH,
    viewportHeight: DEFAULT_VIEWPORT_HEIGHT,
    renderQueue: Promise.resolve()
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

export async function openProjectPreviewUrl(projectPath: unknown, value: unknown): Promise<ProjectPreviewStatus> {
  const root = await canonicalProjectPath(projectPath)
  if (typeof value !== 'string' || !isLoopbackUrl(value)) {
    throw new Error('Akorith Browser only opens verified localhost and 127.0.0.1 URLs.')
  }

  const active = [...sessions.values()].find((candidate) =>
    candidate.projectPath === root && (candidate.state === 'starting' || candidate.state === 'running')
  )
  if (active) {
    const previewWindow = active.previewWindow
    if (previewWindow && !previewWindow.isDestroyed() && !previewWindow.webContents.isDestroyed()) {
      return navigateProjectPreview(active.id, 'go', value)
    }
    active.url = value
    active.state = 'starting'
    active.error = undefined
    addLog(active, `Opening ${value} in the local browser.`)
    void loadPreview(active)
    return publicStatus(active)
  }

  const session: PreviewSession = {
    id: randomUUID(),
    projectPath: root,
    projectName: basename(root),
    script: BROWSER_SCRIPT,
    state: 'starting',
    url: value,
    startedAt: Date.now(),
    logs: [`Opening ${value} in the local browser.`],
    process: null,
    staticServer: null,
    previewWindow: null,
    viewportWidth: DEFAULT_VIEWPORT_WIDTH,
    viewportHeight: DEFAULT_VIEWPORT_HEIGHT,
    renderQueue: Promise.resolve()
  }
  sessions.set(session.id, session)
  void loadPreview(session)
  return publicStatus(session)
}

function requireSession(id: unknown): PreviewSession {
  if (typeof id !== 'string') throw new Error('Invalid preview session.')
  const session = sessions.get(id)
  if (!session) throw new Error('Preview session not found.')
  return session
}

export async function activeProjectPreview(projectPath: unknown): Promise<ProjectPreviewStatus | null> {
  const root = await canonicalProjectPath(projectPath)
  const session = [...sessions.values()].find((candidate) =>
    candidate.projectPath === root && (candidate.state === 'starting' || candidate.state === 'running')
  )
  return session ? publicStatus(session) : null
}

function chromeExecutables(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ]
  }
  if (process.platform === 'win32') {
    const roots = [
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
      process.env['LOCALAPPDATA']
    ].filter((root): root is string => Boolean(root))
    return roots.flatMap((root) => [
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(root, 'Chromium', 'Application', 'chrome.exe')
    ])
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  ]
}

async function openInChrome(url: string): Promise<void> {
  const executable = chromeExecutables().find((candidate) => existsSync(candidate))
  if (!executable) throw new Error('Google Chrome or Chromium was not found in a known install location.')
  await new Promise<void>((resolveOpen, reject) => {
    const child = spawn(executable, [url], {
      detached: true,
      shell: false,
      stdio: 'ignore'
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolveOpen()
    })
  })
}

export async function openProjectPreview(
  id: unknown,
  browser: ProjectPreviewBrowser = 'default'
): Promise<boolean> {
  if (browser !== 'default' && browser !== 'chrome') throw new Error('Unsupported preview browser.')
  const session = requireSession(id)
  await waitForPreviewReady(session)
  if (!session.url || !isLoopbackUrl(session.url)) throw new Error('No local preview URL is available yet.')
  if (browser === 'chrome') await openInChrome(session.url)
  else await shell.openExternal(session.url)
  return true
}

export function openWorkspacePreview(
  projectPath: unknown,
  browser?: ProjectPreviewBrowser
): Promise<OpenedProjectPreviewStatus>
export function openWorkspacePreview(input: WorkspacePreviewOpenRequest): Promise<OpenedProjectPreviewStatus>
export async function openWorkspacePreview(
  projectPathOrInput: unknown,
  browser: ProjectPreviewBrowser = 'default'
): Promise<OpenedProjectPreviewStatus> {
  const objectInput = projectPathOrInput && typeof projectPathOrInput === 'object'
    ? projectPathOrInput as Partial<WorkspacePreviewOpenRequest>
    : null
  const projectPath = objectInput && 'workspacePath' in objectInput
    ? objectInput.workspacePath
    : projectPathOrInput
  const requestedBrowser = objectInput?.browser ?? browser
  if (requestedBrowser !== 'default' && requestedBrowser !== 'chrome') throw new Error('Unsupported preview browser.')

  const root = await canonicalProjectPath(projectPath)
  const active = await activeProjectPreview(root)
  const status = active ?? await startProjectPreview({ projectPath: root })
  await openProjectPreview(status.id, requestedBrowser)
  const opened = publicStatus(requireSession(status.id))
  if (!opened.url || !isLoopbackUrl(opened.url)) throw new Error('No local preview URL is available yet.')
  return { ...opened, url: opened.url }
}

export async function setProjectPreviewViewport(
  id: unknown,
  width: unknown,
  height: unknown
): Promise<ProjectPreviewStatus> {
  const session = requireSession(id)
  session.viewportWidth = viewportDimension(width, MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH, 'width')
  session.viewportHeight = viewportDimension(height, MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT, 'height')

  await queuePreviewOperation(session, async () => {
    const previewWindow = session.previewWindow
    if (!previewWindow || previewWindow.isDestroyed() || previewWindow.webContents.isDestroyed()) return
    const targetWidth = session.viewportWidth
    const targetHeight = session.viewportHeight
    const [currentWidth, currentHeight] = previewWindow.getContentSize()
    if (currentWidth !== targetWidth || currentHeight !== targetHeight) {
      previewWindow.setContentSize(targetWidth, targetHeight, false)
    }
    await settlePreviewLayout(previewWindow)
  })

  return publicStatus(session)
}

export async function navigateProjectPreview(
  id: unknown,
  action: unknown,
  value?: unknown
): Promise<ProjectPreviewStatus> {
  const session = requireSession(id)
  const previewWindow = session.previewWindow
  if (!previewWindow || previewWindow.isDestroyed() || previewWindow.webContents.isDestroyed()) {
    throw new Error('The local browser is not ready.')
  }
  if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'go') {
    throw new Error('Unsupported browser navigation.')
  }

  await queuePreviewOperation(session, async () => {
    const webContents = previewWindow.webContents
    if (action === 'go') {
      if (typeof value !== 'string' || !isLoopbackUrl(value)) {
        throw new Error('Akorith Browser only opens verified localhost and 127.0.0.1 URLs.')
      }
      await webContents.loadURL(value)
    } else if (action === 'back') {
      if (webContents.canGoBack()) webContents.goBack()
    } else if (action === 'forward') {
      if (webContents.canGoForward()) webContents.goForward()
    } else {
      webContents.reload()
    }
    await settlePreviewLayout(previewWindow)
    const currentUrl = webContents.getURL()
    if (isLoopbackUrl(currentUrl)) session.url = currentUrl
  })
  return publicStatus(session)
}

async function captureProject(id: unknown): Promise<{ status: ProjectPreviewStatus; dataUrl: string | null; width: number; height: number }> {
  const session = requireSession(id)
  return queuePreviewOperation(session, async () => {
    const previewWindow = session.previewWindow
    if (!previewWindow || previewWindow.isDestroyed() || previewWindow.webContents.isDestroyed() || session.state === 'error') {
      return { status: publicStatus(session), dataUrl: null, width: 0, height: 0 }
    }
    const [width, height] = previewWindow.getContentSize()
    const scale = Math.min(1, MAX_CAPTURE_WIDTH / Math.max(1, width))
    const image = await previewWindow.webContents.capturePage()
    const resized = scale < 1 ? image.resize({ width: Math.round(width * scale) }) : image
    return { status: publicStatus(session), dataUrl: resized.toDataURL(), width, height }
  })
}

export async function stopProjectPreview(id: unknown): Promise<ProjectPreviewStatus> {
  const session = requireSession(id)
  session.state = 'stopped'
  if (session.previewWindow && !session.previewWindow.isDestroyed()) session.previewWindow.destroy()
  const child = session.process
  session.process = null
  if (child?.pid && !child.killed) {
    try {
      if (process.platform === 'win32') child.kill('SIGTERM')
      else process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  const server = session.staticServer
  session.staticServer = null
  if (server) {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose())
      server.closeAllConnections()
    })
  }
  return publicStatus(session)
}

export function stopAllProjectPreviews(): void {
  for (const id of sessions.keys()) void stopProjectPreview(id)
}

export function registerProjectPreviewIpc(): void {
  ipcMain.handle('projectPreview:inspect', (_event, path: unknown) => inspectProjectPreview(path))
  ipcMain.handle('projectPreview:start', (_event, input: unknown) => startProjectPreview(input))
  ipcMain.handle('projectPreview:openUrl', (_event, input: unknown) => {
    const args = input && typeof input === 'object'
      ? input as { projectPath?: unknown; url?: unknown }
      : {}
    return openProjectPreviewUrl(args.projectPath, args.url)
  })
  ipcMain.handle('projectPreview:status', (_event, id: unknown) => publicStatus(requireSession(id)))
  ipcMain.handle('projectPreview:active', (_event, path: unknown) => activeProjectPreview(path))
  ipcMain.handle('projectPreview:setViewport', (_event, id: unknown, width: unknown, height: unknown) =>
    setProjectPreviewViewport(id, width, height))
  ipcMain.handle('projectPreview:capture', (_event, id: unknown) => captureProject(id))
  ipcMain.handle('projectPreview:stop', (_event, id: unknown) => stopProjectPreview(id))
  ipcMain.handle('projectPreview:open', (_event, id: unknown) => openProjectPreview(id))
  ipcMain.handle('projectPreview:navigate', (_event, input: unknown) => {
    const args = input && typeof input === 'object'
      ? input as { id?: unknown; action?: unknown; value?: unknown }
      : {}
    return navigateProjectPreview(args.id, args.action, args.value)
  })
  ipcMain.handle('projectPreview:reveal', async (_event, path: unknown) => {
    const projectPath = await canonicalProjectPath(path)
    shell.showItemInFolder(projectPath)
    return true
  })
  ipcMain.handle('projectPreview:input', (_event, input: unknown) => {
    const args = input && typeof input === 'object' ? input as {
      id?: unknown
      type?: unknown
      x?: unknown
      y?: unknown
      deltaX?: unknown
      deltaY?: unknown
      text?: unknown
      key?: unknown
    } : {}
    const session = requireSession(args.id)
    const previewWindow = session.previewWindow
    if (!previewWindow || previewWindow.isDestroyed()) throw new Error('Live preview is not ready.')
    if (!session.url || !isLoopbackUrl(session.url)) throw new Error('Preview input is limited to verified loopback sessions.')
    if ((args.type === 'move' || args.type === 'click') && Number.isFinite(args.x) && Number.isFinite(args.y)) {
      const [width, height] = previewWindow.getContentSize()
      const x = Math.min(Math.max(0, width - 1), Math.max(0, Math.round(Number(args.x))))
      const y = Math.min(Math.max(0, height - 1), Math.max(0, Math.round(Number(args.y))))
      previewWindow.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      if (args.type === 'move') return true
      previewWindow.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y })
      previewWindow.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y })
      return true
    }
    if (
      args.type === 'wheel' &&
      Number.isFinite(args.x) &&
      Number.isFinite(args.y) &&
      Number.isFinite(args.deltaX) &&
      Number.isFinite(args.deltaY)
    ) {
      const [width, height] = previewWindow.getContentSize()
      const x = Math.min(Math.max(0, width - 1), Math.max(0, Math.round(Number(args.x))))
      const y = Math.min(Math.max(0, height - 1), Math.max(0, Math.round(Number(args.y))))
      const deltaX = Math.max(-1_200, Math.min(1_200, Math.round(Number(args.deltaX))))
      const deltaY = Math.max(-1_200, Math.min(1_200, Math.round(Number(args.deltaY))))
      if (deltaX === 0 && deltaY === 0) return true
      previewWindow.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX, deltaY, canScroll: true })
      return true
    }
    if (args.type === 'text' && typeof args.text === 'string' && args.text.length <= 4000) {
      previewWindow.webContents.insertText(args.text)
      return true
    }
    const key = args.type === 'key' ? projectPreviewInputKey(args.key) : null
    if (key) {
      previewWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
      previewWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
      return true
    }
    throw new Error('Unsupported preview input.')
  })
}
