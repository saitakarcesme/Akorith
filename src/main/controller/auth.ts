import { randomBytes, timingSafeEqual } from 'crypto'

// Phase 35: bearer-token auth for the controller. The token is generated locally,
// never logged, and only ever surfaced to the renderer as a mask.

export function generateToken(): string {
  return `ak_${randomBytes(24).toString('hex')}`
}

/** Display-only mask, e.g. "ak_3f9c…2b". Never returns the full secret. */
export function maskToken(token: string): string {
  if (!token) return ''
  if (token.length <= 10) return '••••'
  return `${token.slice(0, 6)}…${token.slice(-2)}`
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  try {
    return timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}

/** Extract a Bearer token from an Authorization header value. */
export function extractBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  const match = /^Bearer\s+(.+)$/i.exec(value.trim())
  return match ? match[1].trim() : null
}

/** Validate a request's bearer token against the configured token (constant-time). */
export function isAuthorized(header: string | string[] | undefined, expected: string): boolean {
  if (!expected) return false
  const provided = extractBearer(header)
  if (!provided) return false
  return constantTimeEqual(provided, expected)
}
