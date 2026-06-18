import { ipcMain } from 'electron'
import { hostname, networkInterfaces } from 'os'
import {
  getLocalProviderSettings,
  normalizeBaseUrl,
  setLocalProviderSettings,
  type LocalProviderSettings
} from './config'

export type OllamaConnectionTestResult =
  | { ok: true; baseUrl: string; models: string[]; modelCount: number }
  | { ok: false; baseUrl: string; error: string }

type OllamaSettingsResponse =
  | { ok: true; settings: LocalProviderSettings }
  | { ok: false; error: string; settings: LocalProviderSettings }

export interface OllamaEndpointSuggestion {
  label: string
  baseUrl: string
  address: string
  kind: 'local' | 'lan' | 'vpn' | 'other'
  recommended: boolean
}

export interface OllamaShareInfo {
  hostName: string
  port: number
  endpoints: OllamaEndpointSuggestion[]
}

function validBaseUrl(value: unknown): string | null {
  const normalized = normalizeBaseUrl(value, '')
  return normalized || null
}

function boolPatch(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function endpointFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  return validBaseUrl((args as { baseUrl?: unknown }).baseUrl)
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function isVpnLikeIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  // 100.64.0.0/10 is commonly used by Tailscale and other CGNAT-style private overlays.
  return a === 100 && b >= 64 && b <= 127
}

function endpointKind(address: string): OllamaEndpointSuggestion['kind'] {
  if (address === '127.0.0.1') return 'local'
  if (isVpnLikeIpv4(address)) return 'vpn'
  if (isPrivateIpv4(address)) return 'lan'
  return 'other'
}

function endpointLabel(kind: OllamaEndpointSuggestion['kind'], address: string): string {
  if (kind === 'local') return 'This device only'
  if (kind === 'vpn') return `VPN / Tailscale (${address})`
  if (kind === 'lan') return `Same Wi-Fi / LAN (${address})`
  return `Network adapter (${address})`
}

function shareInfo(): OllamaShareInfo {
  const port = 11434
  const addresses = new Set<string>(['127.0.0.1'])
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue
      addresses.add(entry.address)
    }
  }
  const rank = { vpn: 0, lan: 1, other: 2, local: 3 } satisfies Record<OllamaEndpointSuggestion['kind'], number>
  const endpoints = [...addresses]
    .map((address): OllamaEndpointSuggestion => {
      const kind = endpointKind(address)
      return {
        label: endpointLabel(kind, address),
        baseUrl: `http://${address}:${port}`,
        address,
        kind,
        recommended: kind === 'vpn' || kind === 'lan'
      }
    })
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.address.localeCompare(b.address))
  return { hostName: hostname(), port, endpoints }
}

async function testOllamaEndpoint(baseUrl: string): Promise<OllamaConnectionTestResult> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(6_000) })
    if (!res.ok) return { ok: false, baseUrl, error: `Ollama responded with HTTP ${res.status}` }
    const body = (await res.json()) as { models?: { name?: string }[] }
    const models = (body.models ?? []).map((model) => model.name).filter((name): name is string => typeof name === 'string')
    return { ok: true, baseUrl, models, modelCount: models.length }
  } catch (err) {
    return { ok: false, baseUrl, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerOllamaConnectionIpc(): void {
  ipcMain.handle('ollama:getSettings', (): LocalProviderSettings => getLocalProviderSettings())

  ipcMain.handle('ollama:getShareInfo', (): OllamaShareInfo => shareInfo())

  ipcMain.handle('ollama:testEndpoint', async (_event, args: unknown): Promise<OllamaConnectionTestResult> => {
    const baseUrl = endpointFromArgs(args) ?? getLocalProviderSettings().baseUrl
    return testOllamaEndpoint(baseUrl)
  })

  ipcMain.handle('ollama:setSettings', (_event, args: unknown): OllamaSettingsResponse => {
    if (!args || typeof args !== 'object') {
      return { ok: false, error: 'invalid Ollama settings', settings: getLocalProviderSettings() }
    }
    const input = args as Partial<Record<keyof LocalProviderSettings, unknown>>
    const baseUrl = input.baseUrl === undefined ? undefined : validBaseUrl(input.baseUrl)
    if (input.baseUrl !== undefined && !baseUrl) {
      return { ok: false, error: 'Enter a valid http(s) Ollama endpoint.', settings: getLocalProviderSettings() }
    }
    const settings = setLocalProviderSettings({
      ...(input.enabled !== undefined ? { enabled: boolPatch(input.enabled) } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(input.autoStart !== undefined ? { autoStart: boolPatch(input.autoStart) } : {}),
      ...(input.exposeLan !== undefined ? { exposeLan: boolPatch(input.exposeLan) } : {}),
      ...(input.lanDiscovery !== undefined ? { lanDiscovery: boolPatch(input.lanDiscovery) } : {}),
      ...(typeof input.ollamaHost === 'string' ? { ollamaHost: input.ollamaHost } : {})
    })
    return { ok: true, settings }
  })
}
