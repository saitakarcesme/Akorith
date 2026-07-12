import { isIP } from 'node:net'

export type AddressClassification = 'private' | 'public' | 'unknown'

export interface RemoteAddressPolicy {
  allowPublicAddress?: boolean
}

export interface RemoteAddressAssessment {
  allowed: boolean
  normalizedUrl?: string
  host?: string
  classification: AddressClassification
  secureTransport: boolean
  requiresExplicitPublicOptIn: boolean
  warnings: string[]
  reason?: string
}

function ipv4Number(host: string): number | null {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) === (base & mask)
}

function classifyIpv4(host: string): AddressClassification {
  const value = ipv4Number(host)
  if (value === null) return 'unknown'
  const ranges: Array<[string, number]> = [
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16]
  ]
  return ranges.some(([base, prefix]) => inIpv4Range(value, ipv4Number(base)!, prefix)) ? 'private' : 'public'
}

function classifyIpv6(host: string): AddressClassification {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === '::1') return 'private'
  if (/^f[cd][0-9a-f]{2}:/.test(normalized) || /^fe[89ab][0-9a-f]:/.test(normalized)) return 'private'
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  if (mapped) return classifyIpv4(mapped[1])
  return 'public'
}

function classifyHost(host: string): AddressClassification {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return 'private'
  const family = isIP(normalized)
  if (family === 4) return classifyIpv4(normalized)
  if (family === 6) return classifyIpv6(normalized)
  return 'unknown'
}

export function assessRemoteNodeAddress(address: string, policy: RemoteAddressPolicy = {}): RemoteAddressAssessment {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return {
      allowed: false,
      classification: 'unknown',
      secureTransport: false,
      requiresExplicitPublicOptIn: false,
      warnings: [],
      reason: 'Enter a valid http(s) Akorith Node address.'
    }
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    return {
      allowed: false,
      classification: 'unknown',
      secureTransport: false,
      requiresExplicitPublicOptIn: false,
      warnings: [],
      reason: 'Akorith Node addresses must use http(s) and must not embed credentials.'
    }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === '0.0.0.0' || host === '::') {
    return {
      allowed: false,
      normalizedUrl: url.toString().replace(/\/$/, ''),
      host,
      classification: 'unknown',
      secureTransport: url.protocol === 'https:',
      requiresExplicitPublicOptIn: false,
      warnings: [],
      reason: 'A wildcard bind address is not a connectable remote-node address.'
    }
  }
  const classification = classifyHost(host)
  const secureTransport = url.protocol === 'https:'
  const publicRisk = classification !== 'private'
  const warnings: string[] = []
  if (publicRisk) {
    warnings.push(
      classification === 'public'
        ? 'This is a public network address. Prefer a trusted LAN or Tailscale address.'
        : 'This hostname could not be proven private. Treat it as public unless you control its DNS and network.'
    )
  }
  if (publicRisk && !secureTransport) warnings.push('Public remote-node connections require HTTPS; bearer tokens must not cross plaintext internet links.')
  if (publicRisk && !policy.allowPublicAddress) warnings.push('Public addresses require an explicit opt-in.')
  const allowed = !publicRisk || (policy.allowPublicAddress === true && secureTransport)
  return {
    allowed,
    normalizedUrl: url.toString().replace(/\/$/, ''),
    host,
    classification,
    secureTransport,
    requiresExplicitPublicOptIn: publicRisk,
    warnings,
    ...(allowed ? {} : { reason: warnings.at(-1) ?? 'Address is not allowed by the remote-node network policy.' })
  }
}
