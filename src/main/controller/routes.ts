import { controllerEvents } from './events'
import type { ControllerEndpoint, ControllerStatus } from './types'

// Phase 35: read-only route handlers for the controller API. Every handler returns
// plain JSON-serializable data. NO execution, NO writes — see docs/controller-api.md.
// More endpoints are added across Phase 35.6–35.8.

/**
 * Read-only data providers, injected by the electron bootstrap. Routes never
 * import database or Electron modules directly, which keeps them pure and unit-testable.
 * Every provider returns JSON-safe, metadata-only data.
 */
export interface ControllerData {
  runtime(): Promise<unknown> | unknown
  projects(): Promise<unknown> | unknown
  chats(): Promise<unknown> | unknown
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
  { method: 'GET', path: '/v1/status', summary: 'App, controller, runtime, and plugin summary.', auth: true },
  { method: 'GET', path: '/v1/runtime', summary: 'Runtime observation snapshot (no prompts/output).', auth: true },
  { method: 'GET', path: '/v1/projects', summary: 'Managed projects (metadata only).', auth: true },
  { method: 'GET', path: '/v1/chats', summary: 'Chat/session summaries (no message bodies).', auth: true },
  { method: 'GET', path: '/v1/plugins', summary: 'Plugin registry metadata + diagnostics.', auth: true },
  { method: 'GET', path: '/v1/gpu', summary: 'GPU/local-runtime telemetry (honest unavailable).', auth: true },
  { method: 'GET', path: '/v1/ollama', summary: 'Active Ollama endpoint/source (no secrets).', auth: true },
  { method: 'GET', path: '/v1/events', summary: 'SSE event stream (safe events only).', auth: true },
  { method: 'GET', path: '/v1/docs', summary: 'This endpoint catalogue.', auth: true }
]

async function dataResult(value: Promise<unknown> | unknown): Promise<RouteResult> {
  return { body: await value }
}

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
    handler: async (ctx) => {
      // Cheap, in-memory/sql summaries only — never the process-spawning GPU probe.
      const len = async (value: Promise<unknown> | unknown): Promise<number> => {
        const resolved = await value
        return Array.isArray(resolved) ? resolved.length : 0
      }
      return {
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
          },
          summary: {
            projects: await len(ctx.data.projects()),
            chats: await len(ctx.data.chats()),
            plugins: await len(ctx.data.plugins())
          }
        }
      }
    }
  },
  { method: 'GET', path: '/v1/runtime', auth: true, summary: 'Runtime snapshot.', handler: (ctx) => dataResult(ctx.data.runtime()) },
  { method: 'GET', path: '/v1/projects', auth: true, summary: 'Managed projects.', handler: (ctx) => dataResult(ctx.data.projects()) },
  { method: 'GET', path: '/v1/chats', auth: true, summary: 'Chat summaries.', handler: (ctx) => dataResult(ctx.data.chats()) },
  { method: 'GET', path: '/v1/plugins', auth: true, summary: 'Plugin registry.', handler: (ctx) => dataResult(ctx.data.plugins()) },
  { method: 'GET', path: '/v1/gpu', auth: true, summary: 'GPU telemetry.', handler: (ctx) => dataResult(ctx.data.gpu()) },
  { method: 'GET', path: '/v1/ollama', auth: true, summary: 'Ollama endpoint.', handler: (ctx) => dataResult(ctx.data.ollama()) },
  {
    method: 'GET',
    path: '/v1/docs',
    auth: true,
    summary: 'Endpoint catalogue.',
    handler: () => ({ body: { app: 'Akorith Controller API', readOnly: true, endpoints: ENDPOINTS } })
  },
  {
    method: 'POST',
    path: '/v1/controller/refresh',
    auth: true,
    summary: 'Re-run read-only snapshots and emit an SSE runtime_snapshot (no execution).',
    handler: async (ctx) => {
      const runtime = await ctx.data.runtime()
      // Emit a safe runtime_snapshot to any SSE listeners (counts/shape only).
      controllerEvents.emit({
        type: 'runtime_snapshot',
        at: Date.now(),
        data: { observed: Array.isArray((runtime as { observedSessions?: unknown[] })?.observedSessions) }
      })
      return { body: { ok: true, refreshedAt: Date.now(), runtime } }
    }
  }
]

export function findRoute(method: string, pathname: string): Route | undefined {
  return routes.find((route) => route.method === method && route.path === pathname)
}

export function allRoutes(): Route[] {
  return routes
}
