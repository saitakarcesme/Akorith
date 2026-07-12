const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

export interface ExternalUrlDecision {
  allowed: boolean
  url?: string
  reason?: string
}

export function validateExternalUrl(value: unknown): ExternalUrlDecision {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) {
    return { allowed: false, reason: 'External URL must be a bounded string.' }
  }

  try {
    const parsed = new URL(value)
    if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
      return { allowed: false, reason: `Protocol ${parsed.protocol || '(missing)'} is not allowed.` }
    }
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.hostname) {
      return { allowed: false, reason: 'External web URLs require a hostname.' }
    }
    return { allowed: true, url: parsed.toString() }
  } catch {
    return { allowed: false, reason: 'External URL is invalid.' }
  }
}
