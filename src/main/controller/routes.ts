import type { ControllerEndpoint, ControllerStatus } from './types'

// Phase 35: read-only route handlers for the controller API. Every handler returns
// plain JSON-serializable data. NO execution, NO writes — see docs/controller-api.md.
// More endpoints are added across Phase 35.6–35.8.

/**
 * Read-only data providers, injected by the electron bootstrap. Routes never
 * import db/agents/electron directly, which keeps them pure and unit-testable.
 * Every provider returns JSON-safe, metadata-only data.
 */
export interface ControllerData {
  agents(): Promise<unknown> | unknown
  runtime(): Promise<unknown> | unknown
  projects(): Promise<unknown> | unknown
  chats(): Promise<unknown> | unknown
  missions(): Promise<unknown> | unknown
  plugins(): Promise<unknown> | unknown
  gpu(): Promise<unknown> | unknown
  ollama(): Promise<unknown> | unknown
}

export interface RouteContext {
  url: URL
  version: string
  /** Live controller status, built by the server. */
  status: ControllerStatus
  data: ControllerData
}

export interface RouteResult {
  status?: number
  body: unknown
}

type Handler = (ctx: RouteContext) => RouteResult | Promise<RouteResult>

export interface Route {
  method: 'GET' | 'POST'
  path: string
  auth: boolean
  summary: string
  handler: Handler
}

// The published endpoint catalogue (also served at /v1/docs).
export const ENDPOINTS: ControllerEndpoint[] = [
  { method: 'GET', path: '/health', summary: 'Liveness probe (no auth).', auth: false },
  { method: 'GET', path: '/v1/status', summary: 'App + controller + runtime/mission/plugin summary.', auth: true },
  { method: 'GET', path: '/v1/docs', summary: 'This endpoint catalogue.', auth: true }
]

const routes: Route[] = [
  {
    method: 'GET',
    path: '/health',
    auth: false,
    summary: 'Liveness probe.',
    handler: (ctx) => ({ body: { ok: true, app: 'Akorith', version: ctx.version, time: Date.now() } })
  },
  {
    method: 'GET',
    path: '/v1/status',
    auth: true,
    summary: 'App + controller status summary.',
    handler: (ctx) => ({
      body: {
        app: 'Akorith',
        version: ctx.version,
        time: Date.now(),
        controller: {
          running: ctx.status.running,
          readOnly: ctx.status.readOnly,
          sseEnabled: ctx.status.sseEnabled,
          host: ctx.status.host,
          port: ctx.status.port,
          connectedClients: ctx.status.connectedClients
        }
      }
    })
  },
  {
    method: 'GET',
    path: '/v1/docs',
    auth: true,
    summary: 'Endpoint catalogue.',
    handler: () => ({ body: { app: 'Akorith Controller API', readOnly: true, endpoints: ENDPOINTS } })
  }
]

export function findRoute(method: string, pathname: string): Route | undefined {
  return routes.find((route) => route.method === method && route.path === pathname)
}

export function allRoutes(): Route[] {
  return routes
}
