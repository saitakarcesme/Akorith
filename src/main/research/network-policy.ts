import { lookup } from 'dns/promises'
import { isIP } from 'net'

const DENIED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.azure.internal'
])

export async function assertPublicResearchUrl(raw: string): Promise<URL> {
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Research only fetches HTTP(S) sources.')
  if (url.username || url.password) throw new Error('Credential-bearing source URLs are not allowed.')
  if (url.port && url.port !== '80' && url.port !== '443') throw new Error('Non-standard source ports are not allowed.')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (DENIED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Local network source URLs are not allowed.')
  }
  if (isIP(host)) {
    if (!isPublicIp(host)) throw new Error('Private or reserved source addresses are not allowed.')
    return url
  }
  const addresses = await lookup(host, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((entry) => !isPublicIp(entry.address))) {
    throw new Error('Source host resolves to a private or reserved address.')
  }
  return url
}

export function isPublicIp(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isPublicIpv4(address)
  if (version === 6) return isPublicIpv6(address)
  return false
}

function isPublicIpv4(address: string): boolean {
  const [a, b, c] = address.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 0 && c === 0) return false
  if (a === 192 && b === 0 && c === 2) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false
  return true
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === '::' || normalized === '::1') return false
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false
  if (/^fe[89ab]/.test(normalized)) return false
  if (normalized.startsWith('ff')) return false
  if (normalized.startsWith('2001:db8')) return false
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length)
    return isIP(mapped) === 4 && isPublicIpv4(mapped)
  }
  return true
}
