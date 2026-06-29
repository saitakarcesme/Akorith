import type { ControllerSettings } from '../config'

// Phase 35: the controller's security policy lives here so the rules are in one
// place and easy to audit. Default posture: loopback-only, token-required,
// read-only, restrictive CORS.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

export interface BindDecision {
  ok: boolean
  reason?: string
}

/**
 * Decide whether the configured host is allowed to bind. A non-loopback host
 * (including 0.0.0.0) requires `allowLan: true` to be set explicitly. We never
 * bind a wildcard/LAN address implicitly.
 */
export function evaluateBindPolicy(settings: ControllerSettings): BindDecision {
  if (isLoopbackHost(settings.host)) return { ok: true }
  if (!settings.allowLan) {
    return {
      ok: false,
      reason: `Host "${settings.host}" is not loopback. Enable "Allow LAN access" to bind a non-loopback address — and only on a trusted private network.`
    }
  }
  return { ok: true }
}

/** True when the host is non-loopback (UI shows a warning for these). */
export function isLanExposed(settings: ControllerSettings): boolean {
  return !isLoopbackHost(settings.host)
}

/**
 * Restrictive CORS: by default only same-origin loopback origins are allowed.
 * An explicit allowedOrigins list extends it. Returns the origin to echo back,
 * or null to deny (no `Access-Control-Allow-Origin` header).
 */
export function resolveCorsOrigin(settings: ControllerSettings, origin: string | undefined): string | null {
  if (!origin) return null
  if (settings.allowedOrigins?.includes(origin)) return origin
  try {
    const url = new URL(origin)
    if (isLoopbackHost(url.hostname)) return origin
  } catch {
    return null
  }
  return null
}
