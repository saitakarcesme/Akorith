import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { ControllerSettings } from '../config'
import { generateToken, isAuthorized, maskToken } from './auth'
import { controllerEvents } from './events'
import { evaluateBindPolicy, isLoopbackHost, resolveCorsOrigin } from './policy'
import { allRoutes, ENDPOINTS, findRoute, type ControllerData } from './routes'
import type { ControllerActionResult, ControllerConfigView, ControllerStatus } from './types'

// Phase 35: the controller HTTP server. Pure factory — it takes its settings access
// and read-only data providers as dependencies and imports neither electron nor the
// config/db modules, so it can be exercised by a verification script without a window.
// Loopback-only by default; bearer-token auth on everything except /health; no
// execution endpoints.

export interface ControllerDeps {
  version: string
  getSettings: () => ControllerSettings
  saveSettings: (patch: Partial<ControllerSettings>) => ControllerSettings
  data: ControllerData
}

export interface ControllerServer {
  start: () => Promise<ControllerActionResult>
  stop: () => Promise<ControllerActionResult>
  restart: () => Promise<ControllerActionResult>
  status: () => ControllerStatus
  configView: () => ControllerConfigView
  revealToken: () => string
  regenerateToken: () => ControllerStatus
  isRunning: () => boolean
}

export function createControllerServer(deps: ControllerDeps): ControllerServer {
  let server: Server | null = null
  let running = false

  const buildStatus = (): ControllerStatus => {
    const s = deps.getSettings()
    return {
      enabled: s.enabled,
      running,
      host: s.host,
      port: s.port,
      baseUrl: `http://${s.host}:${s.port}`,
      readOnly: s.readOnly,
      sseEnabled: s.sseEnabled,
      allowLan: s.allowLan,
      hasToken: Boolean(s.token),
      tokenMasked: maskToken(s.token),
      connectedClients: controllerEvents.count(),
      ...(s.lastStartedAt ? { lastStartedAt: s.lastStartedAt } : {}),
      ...(s.lastError ? { lastError: s.lastError } : {})
    }
  }

  const configView = (): ControllerConfigView => {
    const { token, ...rest } = deps.getSettings()
    return { ...rest, hasToken: Boolean(token), tokenMasked: maskToken(token) }
  }

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    res.end(payload)
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const settings = deps.getSettings()
    const method = (req.method ?? 'GET').toUpperCase()

    // Restrictive CORS: echo only loopback / explicitly-allowed origins.
    const corsOrigin = resolveCorsOrigin(settings, req.headers.origin)
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    }
    if (method === 'OPTIONS') {
      res.writeHead(corsOrigin ? 204 : 403)
      res.end()
      return
    }
    // Only GET/POST are ever served; reject everything else early.
    if (method !== 'GET' && method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${settings.host}:${settings.port}`)
    } catch {
      sendJson(res, 400, { error: 'bad request' })
      return
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    // SSE stream (auth required; safe events only).
    if (pathname === '/v1/events' && method === 'GET') {
      if (!settings.sseEnabled) {
        sendJson(res, 404, { error: 'sse disabled' })
        return
      }
      if (!isAuthorized(req.headers.authorization, settings.token)) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      // Check the client cap before committing SSE response headers.
      if (controllerEvents.count() >= 32) {
        sendJson(res, 503, { error: 'too many sse clients' })
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff'
      })
      controllerEvents.addClient(res)
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ type: 'heartbeat', at: Date.now() })}\n\n`)
      return
    }

    const route = findRoute(method, pathname)
    if (!route) {
      sendJson(res, 404, { error: 'not found', path: pathname })
      return
    }
    if (route.auth && !isAuthorized(req.headers.authorization, settings.token)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    try {
      const result = await route.handler({ url, version: deps.version, status: buildStatus(), data: deps.data })
      sendJson(res, result.status ?? 200, result.body)
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'internal error' })
    }
  }

  const start = async (): Promise<ControllerActionResult> => {
    if (running) return { ok: true, status: buildStatus() }
    const settings = deps.getSettings()

    const decision = evaluateBindPolicy(settings)
    if (!decision.ok) {
      deps.saveSettings({ lastError: decision.reason })
      return { ok: false, status: buildStatus(), error: decision.reason }
    }

    // Ensure a token exists before the server accepts a single request.
    if (!settings.token) deps.saveSettings({ token: generateToken() })

    return new Promise<ControllerActionResult>((resolve) => {
      const srv = createServer((req, res) => void handle(req, res))
      srv.on('error', (err: NodeJS.ErrnoException) => {
        running = false
        server = null
        const message =
          err.code === 'EADDRINUSE'
            ? `Port ${settings.port} is already in use. Choose another port.`
            : err.message || 'Controller server error.'
        deps.saveSettings({ lastError: message })
        resolve({ ok: false, status: buildStatus(), error: message })
      })
      srv.listen(settings.port, settings.host, () => {
        server = srv
        running = true
        deps.saveSettings({ lastStartedAt: Date.now(), lastError: '' })
        controllerEvents.emit({ type: 'controller_started', at: Date.now(), data: { port: settings.port } })
        resolve({ ok: true, status: buildStatus() })
      })
    })
  }

  const stop = async (): Promise<ControllerActionResult> => {
    controllerEvents.emit({ type: 'controller_stopped', at: Date.now() })
    controllerEvents.closeAll()
    if (!server) {
      running = false
      return { ok: true, status: buildStatus() }
    }
    return new Promise<ControllerActionResult>((resolve) => {
      server?.close(() => {
        server = null
        running = false
        resolve({ ok: true, status: buildStatus() })
      })
    })
  }

  const restart = async (): Promise<ControllerActionResult> => {
    await stop()
    return start()
  }

  const regenerateToken = (): ControllerStatus => {
    deps.saveSettings({ token: generateToken() })
    return buildStatus()
  }

  // Local-only: the renderer's "copy token" button needs the real value once.
  // This never crosses the network and is never written to logs.
  const revealToken = (): string => deps.getSettings().token

  return {
    start,
    stop,
    restart,
    status: buildStatus,
    configView,
    revealToken,
    regenerateToken,
    isRunning: () => running
  }
}

export { ENDPOINTS, allRoutes }
