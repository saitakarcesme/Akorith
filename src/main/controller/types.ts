import type { ControllerSettings } from '../config'

// Phase 35: shared controller types. The controller is an OPTIONAL, loopback-only,
// token-protected, READ-ONLY local HTTP API. No execution endpoints in this phase.

export type { ControllerSettings }

export interface ControllerStatus {
  enabled: boolean
  running: boolean
  host: string
  port: number
  /** Convenience base URL for the UI (loopback shown as 127.0.0.1). */
  baseUrl: string
  readOnly: boolean
  sseEnabled: boolean
  allowLan: boolean
  /** True once a token exists (never the token itself). */
  hasToken: boolean
  /** Masked token for display, e.g. "ak_12ab…f9". Never the full secret. */
  tokenMasked: string
  connectedClients: number
  lastStartedAt?: number
  lastError?: string
}

/** A safe view of config for the renderer — the raw token is replaced by a mask. */
export interface ControllerConfigView extends Omit<ControllerSettings, 'token'> {
  hasToken: boolean
  tokenMasked: string
}

export interface ControllerActionResult {
  ok: boolean
  status: ControllerStatus
  error?: string
}

/** Minimal endpoint description for the docs/openapi surface. */
export interface ControllerEndpoint {
  method: 'GET' | 'POST'
  path: string
  summary: string
  auth: boolean
}

export interface ControllerEvent {
  type: 'controller_started' | 'controller_stopped' | 'runtime_snapshot' | 'plugin_status' | 'mission_changed' | 'heartbeat'
  at: number
  data?: Record<string, unknown>
}
