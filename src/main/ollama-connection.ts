import { ipcMain } from 'electron'
import { hostname, networkInterfaces } from 'os'
import {
  getLocalProviderSettings,
  getTelemetrySettings,
  normalizeBaseUrl,
  sanitizeRemoteProfiles,
  setLocalProviderSettings,
  type LocalProviderSettings,
  type OllamaRemoteProfile
} from './config'
import { getTailscaleStatus, tailscaleOllamaCandidates, type TailscaleStatus } from './remote-runtime/tailscale'

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

/** Turn a low-level fetch failure into an explanation the user can act on.
 *  The common off-network case: the saved endpoint is a home/LAN IP that is
 *  only routable on the same network as the Ollama machine. */
function describeOllamaError(baseUrl: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  let host = ''
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '')
  } catch {
    // fall through with empty host
  }
  const kind = host ? endpointKind(host) : 'other'
  const timedOut = /timed out|timeout|aborted/i.test(raw)
  if (kind === 'lan') {
    return `Can't reach ${host} — that's a home/Wi-Fi (LAN) address that only works on the same network as the Ollama machine. You're on a different network now. To use it from anywhere, run Tailscale on both machines and switch this endpoint to the PC's Tailscale address (100.x.x.x). Make sure the PC is on, awake, and Ollama is started with OLLAMA_HOST=0.0.0.0.`
  }
  if (kind === 'vpn') {
    return `Can't reach ${host} over Tailscale/VPN${timedOut ? ' (timed out)' : ''}. Check that the PC is on and awake, Tailscale is connected on both devices, and Ollama is running with OLLAMA_HOST=0.0.0.0.`
  }
  if (timedOut) {
    return `Timed out reaching ${baseUrl}. The machine may be off, asleep, or on another network.`
  }
  return `Can't reach ${baseUrl}: ${raw}. Confirm Ollama is running there and reachable from this network.`
}

async function testOllamaEndpoint(baseUrl: string, timeoutMs = 6_000): Promise<OllamaConnectionTestResult> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, baseUrl, error: `Ollama responded with HTTP ${res.status}` }
    const body = (await res.json()) as { models?: { name?: string }[] }
    const models = (body.models ?? []).map((model) => model.name).filter((name): name is string => typeof name === 'string')
    return { ok: true, baseUrl, models, modelCount: models.length }
  } catch (err) {
    return { ok: false, baseUrl, error: describeOllamaError(baseUrl, err) }
  }
}

// ---- Phase 33.14: auto-connect across endpoints by priority ----

export interface OllamaActiveEndpoint {
  baseUrl: string
  source: 'configured' | 'last' | 'profile' | 'tailscale' | 'controller'
  profileId?: string
  label: string
}

/** Derive an Ollama base URL (host:11434) from a controller/Tailscale host URL. */
function ollamaUrlFromHostUrl(hostUrl: string): string | null {
  try {
    const u = new URL(hostUrl)
    return `http://${u.hostname}:11434`
  } catch {
    return null
  }
}

export type OllamaAutoConnectResult =
  | { ok: true; active: OllamaActiveEndpoint; models: string[]; modelCount: number; switched: boolean }
  | { ok: false; error: string; lastSuccessfulBaseUrl?: string; triedCount: number }

interface ProfileStatusPatch {
  lastStatus: 'ok' | 'error'
  lastError?: string
  lastModelCount?: number
  lastConnectedAt?: number
  lastCheckedAt: number
}

function applyProfileUpdates(
  profiles: OllamaRemoteProfile[],
  updates: Map<string, ProfileStatusPatch>
): OllamaRemoteProfile[] {
  return profiles.map((profile) => {
    const patch = updates.get(profile.id)
    if (!patch) return profile
    const next: OllamaRemoteProfile = {
      ...profile,
      lastStatus: patch.lastStatus,
      lastCheckedAt: patch.lastCheckedAt
    }
    if (patch.lastError) next.lastError = patch.lastError
    else delete next.lastError
    if (patch.lastModelCount !== undefined) next.lastModelCount = patch.lastModelCount
    if (patch.lastConnectedAt !== undefined) next.lastConnectedAt = patch.lastConnectedAt
    return next
  })
}

/**
 * Try, in priority order, to reach an Ollama endpoint: the currently-configured
 * baseUrl first (so a healthy local setup is never disturbed), then the last
 * endpoint that answered, then each enabled remote profile by ascending
 * priority. The first that responds wins; if it differs from the configured
 * baseUrl we switch to it (and cache it) so remote models become available
 * automatically. Read-only health checks (/api/tags) with short timeouts — no
 * polling, no aggressive retries.
 */
async function autoConnectOllama(): Promise<OllamaAutoConnectResult> {
  const settings = getLocalProviderSettings()
  type Candidate = { baseUrl: string; source: OllamaActiveEndpoint['source']; profileId?: string; label: string }
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  const push = (candidate: Candidate): void => {
    if (!candidate.baseUrl || seen.has(candidate.baseUrl)) return
    seen.add(candidate.baseUrl)
    candidates.push(candidate)
  }

  if (settings.enabled) push({ baseUrl: settings.baseUrl, source: 'configured', label: 'Local' })
  if (settings.lastSuccessfulBaseUrl) push({ baseUrl: settings.lastSuccessfulBaseUrl, source: 'last', label: 'Last known' })
  const profiles = [...(settings.remoteProfiles ?? [])].filter((p) => p.enabled).sort((a, b) => a.priority - b.priority)
  for (const profile of profiles) {
    push({ baseUrl: profile.baseUrl, source: 'profile', profileId: profile.id, label: `Remote: ${profile.name}` })
  }

  // Phase 42 (Remote Ollama): a healthy Akorith Controller (the PC) usually runs
  // Ollama on the same host — derive host:11434 as a candidate. Token telemetry is
  // separate; here we only probe the public read-only /api/tags. Tokens never logged.
  for (const c of [...getTelemetrySettings().profiles].filter((p) => p.enabled).sort((a, b) => a.priority - b.priority)) {
    const derived = ollamaUrlFromHostUrl(c.baseUrl)
    if (derived) push({ baseUrl: derived, source: 'controller', label: `PC via Controller (${c.name})` })
  }

  // Phase 42 (Remote Ollama): when away from the home LAN, find the PC's Ollama over
  // Tailscale automatically (private 100.x peers only; no public/Internet probing).
  try {
    for (const t of await tailscaleOllamaCandidates()) {
      push({ baseUrl: t.baseUrl, source: 'tailscale', label: `PC via Tailscale (${t.hostName})` })
    }
  } catch {
    /* Tailscale is optional — never block auto-connect on it. */
  }

  const now = Date.now()
  const updates = new Map<string, ProfileStatusPatch>()
  let firstError = ''
  for (const candidate of candidates) {
    const res = await testOllamaEndpoint(candidate.baseUrl, 4_500)
    if (candidate.profileId) {
      updates.set(candidate.profileId, {
        lastStatus: res.ok ? 'ok' : 'error',
        lastError: res.ok ? undefined : res.error,
        lastModelCount: res.ok ? res.modelCount : undefined,
        lastConnectedAt: res.ok ? now : undefined,
        lastCheckedAt: now
      })
    }
    if (res.ok) {
      const switched = candidate.baseUrl !== settings.baseUrl
      const patch: Partial<LocalProviderSettings> = { lastSuccessfulBaseUrl: candidate.baseUrl }
      if (switched) patch.baseUrl = candidate.baseUrl
      if (updates.size && settings.remoteProfiles) {
        patch.remoteProfiles = applyProfileUpdates(settings.remoteProfiles, updates)
      }
      setLocalProviderSettings(patch)
      return {
        ok: true,
        active: { baseUrl: candidate.baseUrl, source: candidate.source, profileId: candidate.profileId, label: candidate.label },
        models: res.models,
        modelCount: res.modelCount,
        switched
      }
    }
    if (!firstError) firstError = res.error
  }

  if (updates.size && settings.remoteProfiles) {
    setLocalProviderSettings({ remoteProfiles: applyProfileUpdates(settings.remoteProfiles, updates) })
  }
  return {
    ok: false,
    error: firstError || 'No Ollama endpoint is reachable right now.',
    lastSuccessfulBaseUrl: settings.lastSuccessfulBaseUrl,
    triedCount: candidates.length
  }
}

// Phase 42 (Remote Ollama): a single summary the Dashboard / presentation-readiness
// check reads — active runtime source, model count, Tailscale state, and a readiness
// verdict. GPU is intentionally NOT faked here (direct Ollama exposes none).
export interface RuntimeStatus {
  ok: boolean
  source?: OllamaActiveEndpoint['source']
  label?: string
  baseUrl?: string
  modelCount: number
  models: string[]
  readiness: 'ready' | 'attention' | 'offline' | 'setup'
  reason: string
  tailscale: { installed: boolean; running: boolean; peerCount: number }
  hasRemoteProfiles: boolean
  hasControllerProfiles: boolean
  lastSuccessfulBaseUrl?: string
  checkedAt: number
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  const settings = getLocalProviderSettings()
  const hasRemoteProfiles = (settings.remoteProfiles ?? []).some((p) => p.enabled)
  const hasControllerProfiles = getTelemetrySettings().profiles.some((p) => p.enabled)
  const ts = await getTailscaleStatus().catch(() => ({ installed: false, running: false, peers: [] as { isSelf: boolean }[] }))
  const tailscale = {
    installed: ts.installed,
    running: ts.running,
    peerCount: ts.peers.filter((p) => !p.isSelf).length
  }

  const result = await autoConnectOllama()
  if (result.ok) {
    const readiness: RuntimeStatus['readiness'] = result.modelCount > 0 ? 'ready' : 'attention'
    return {
      ok: true,
      source: result.active.source,
      label: result.active.label,
      baseUrl: result.active.baseUrl,
      modelCount: result.modelCount,
      models: result.models,
      readiness,
      reason:
        readiness === 'ready'
          ? `Connected to ${result.active.label} — ${result.modelCount} model(s) available.`
          : `Connected to ${result.active.label} but no models are installed. Run "ollama pull <model>" on that machine.`,
      tailscale,
      hasRemoteProfiles,
      hasControllerProfiles,
      lastSuccessfulBaseUrl: settings.lastSuccessfulBaseUrl,
      checkedAt: Date.now()
    }
  }

  const hasAnyRemote = hasRemoteProfiles || hasControllerProfiles || tailscale.peerCount > 0
  const readiness: RuntimeStatus['readiness'] = hasAnyRemote ? 'offline' : 'setup'
  return {
    ok: false,
    modelCount: 0,
    models: [],
    readiness,
    reason: hasAnyRemote
      ? 'No local-model endpoint is reachable right now. Make sure the PC is on and awake, Ollama is running, and your private route (Tailscale/VPN/LAN) is connected.'
      : 'No local-model endpoint is configured for this network. Add a Remote Runtime profile (LAN, Tailscale, or Akorith Controller) in Settings → Providers.',
    tailscale,
    hasRemoteProfiles,
    hasControllerProfiles,
    lastSuccessfulBaseUrl: settings.lastSuccessfulBaseUrl,
    checkedAt: Date.now()
  }
}

export function registerOllamaConnectionIpc(): void {
  ipcMain.handle('ollama:getSettings', (): LocalProviderSettings => getLocalProviderSettings())

  ipcMain.handle('ollama:getShareInfo', (): OllamaShareInfo => shareInfo())

  ipcMain.handle('ollama:testEndpoint', async (_event, args: unknown): Promise<OllamaConnectionTestResult> => {
    const baseUrl = endpointFromArgs(args) ?? getLocalProviderSettings().baseUrl
    return testOllamaEndpoint(baseUrl)
  })

  // Phase 33.14: try configured → last → enabled remote profiles, pick first healthy.
  ipcMain.handle('ollama:autoConnect', async (): Promise<OllamaAutoConnectResult> => autoConnectOllama())

  // Phase 42 (Remote Ollama): runtime-source summary + presentation readiness, and a
  // read-only Tailscale status for setup guidance.
  ipcMain.handle('runtime:status', async (): Promise<RuntimeStatus> => getRuntimeStatus())
  ipcMain.handle('runtime:tailscaleStatus', async (): Promise<TailscaleStatus> => getTailscaleStatus())

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
      ...(typeof input.ollamaHost === 'string' ? { ollamaHost: input.ollamaHost } : {}),
      // Phase 33.13: remote profiles are validated/sanitized in config.
      ...(input.remoteProfiles !== undefined ? { remoteProfiles: sanitizeRemoteProfiles(input.remoteProfiles) } : {})
    })
    return { ok: true, settings }
  })
}
