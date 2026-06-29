import { ipcMain } from 'electron'
import {
  getTelemetrySettings,
  normalizeBaseUrl,
  setTelemetrySettings,
  type RemoteTelemetryProfile
} from './config'
import { getGpuStatus, type GpuStatusResult } from './gpu-status'

// Phase 36: read-only remote GPU/runtime telemetry. The Mac stores profiles that
// point at a remote Akorith Controller (e.g. the PC running Ollama, with Controller
// API enabled + Allow-LAN on a trusted private network). We call the remote read-only
// /v1/gpu and /v1/ollama with the bearer token. We never fabricate data and never
// expose tokens to the renderer (a mask is shown; reveal is a separate local call).

const FETCH_TIMEOUT_MS = 5_000

export interface RemoteTelemetryProfileView {
  id: string
  name: string
  baseUrl: string
  enabled: boolean
  priority: number
  lastStatus?: 'ok' | 'error'
  lastError?: string
  lastCheckedAt?: number
  hasToken: boolean
  tokenMasked: string
}

export interface TelemetryStatus {
  source: 'remote' | 'local'
  profile?: { id: string; name: string; baseUrl: string }
  gpu: GpuStatusResult
  ollama?: unknown
  checkedAt: number
  /** Set when a remote profile was tried but unreachable (UI shows it). */
  remoteError?: string
}

function maskToken(token: string): string {
  if (!token) return ''
  if (token.length <= 10) return '••••'
  return `${token.slice(0, 6)}…${token.slice(-2)}`
}

function toView(profile: RemoteTelemetryProfile): RemoteTelemetryProfileView {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    enabled: profile.enabled,
    priority: profile.priority,
    ...(profile.lastStatus ? { lastStatus: profile.lastStatus } : {}),
    ...(profile.lastError ? { lastError: profile.lastError } : {}),
    ...(profile.lastCheckedAt ? { lastCheckedAt: profile.lastCheckedAt } : {}),
    hasToken: Boolean(profile.token),
    tokenMasked: maskToken(profile.token)
  }
}

async function remoteGet(baseUrl: string, path: string, token: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (res.status === 401 || res.status === 403) throw new Error('Unauthorized — check the remote controller token.')
  if (!res.ok) throw new Error(`Remote controller responded HTTP ${res.status}.`)
  return res.json()
}

/** Update one profile's health fields and persist. */
function recordProfileResult(id: string, status: 'ok' | 'error', error?: string): void {
  const profiles = getTelemetrySettings().profiles.map((p) =>
    p.id === id
      ? {
          ...p,
          lastStatus: status,
          lastCheckedAt: Date.now(),
          ...(error ? { lastError: error } : { lastError: undefined as unknown as string })
        }
      : p
  )
  setTelemetrySettings({ profiles })
}

async function fetchRemote(profile: RemoteTelemetryProfile): Promise<{ gpu: GpuStatusResult; ollama: unknown }> {
  const gpu = (await remoteGet(profile.baseUrl, '/v1/gpu', profile.token)) as GpuStatusResult
  let ollama: unknown = undefined
  try {
    ollama = await remoteGet(profile.baseUrl, '/v1/ollama', profile.token)
  } catch {
    /* ollama is optional context */
  }
  return { gpu, ollama }
}

/**
 * Resolve the telemetry to show: the first healthy enabled remote profile (by
 * priority) wins; otherwise fall back to honest local GPU telemetry.
 */
async function getTelemetryStatus(): Promise<TelemetryStatus> {
  const profiles = [...getTelemetrySettings().profiles].filter((p) => p.enabled).sort((a, b) => a.priority - b.priority)
  let firstError = ''
  for (const profile of profiles) {
    try {
      const { gpu, ollama } = await fetchRemote(profile)
      recordProfileResult(profile.id, 'ok')
      return {
        source: 'remote',
        profile: { id: profile.id, name: profile.name, baseUrl: profile.baseUrl },
        gpu,
        ollama,
        checkedAt: Date.now()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      recordProfileResult(profile.id, 'error', message)
      if (!firstError) firstError = `${profile.name}: ${message}`
    }
  }
  const local = await getGpuStatus()
  return { source: 'local', gpu: local, checkedAt: Date.now(), ...(firstError ? { remoteError: firstError } : {}) }
}

/** Merge editor-supplied profiles with stored tokens: an empty token keeps the
 *  existing one (the editor only ever shows a mask). */
function mergeProfiles(incoming: unknown): RemoteTelemetryProfile[] {
  if (!Array.isArray(incoming)) return getTelemetrySettings().profiles
  const existing = new Map(getTelemetrySettings().profiles.map((p) => [p.id, p]))
  const merged: RemoteTelemetryProfile[] = []
  for (const raw of incoming.slice(0, 24)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const baseUrl = normalizeBaseUrl(entry.baseUrl, '')
    if (!baseUrl) continue
    const id = typeof entry.id === 'string' ? entry.id : `rt-${merged.length}-${baseUrl.length}`
    const providedToken = typeof entry.token === 'string' ? entry.token.trim() : ''
    const keptToken = existing.get(id)?.token ?? ''
    merged.push({
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 80) : 'Remote runtime',
      baseUrl,
      token: providedToken || keptToken,
      enabled: entry.enabled !== false,
      priority: Number.isFinite(entry.priority) ? Math.max(0, Math.trunc(entry.priority as number)) : merged.length
    })
  }
  return merged
}

export function registerRemoteTelemetryIpc(): void {
  ipcMain.handle('telemetry:getStatus', async (): Promise<TelemetryStatus> => getTelemetryStatus())

  ipcMain.handle('telemetry:getProfiles', (): RemoteTelemetryProfileView[] =>
    getTelemetrySettings().profiles.map(toView)
  )

  ipcMain.handle('telemetry:saveProfiles', (_event, profiles: unknown): RemoteTelemetryProfileView[] => {
    const merged = setTelemetrySettings({ profiles: mergeProfiles(profiles) })
    return merged.profiles.map(toView)
  })

  ipcMain.handle('telemetry:revealToken', (_event, id: unknown): string => {
    if (typeof id !== 'string') return ''
    return getTelemetrySettings().profiles.find((p) => p.id === id)?.token ?? ''
  })

  // Test a profile as the editor has it (token may be the stored one if blank).
  ipcMain.handle('telemetry:testProfile', async (_event, input: unknown): Promise<{ ok: boolean; message: string; modelCount?: number }> => {
    if (!input || typeof input !== 'object') return { ok: false, message: 'Invalid profile.' }
    const entry = input as Record<string, unknown>
    const baseUrl = normalizeBaseUrl(entry.baseUrl, '')
    if (!baseUrl) return { ok: false, message: 'Enter a valid http(s) controller base URL.' }
    const id = typeof entry.id === 'string' ? entry.id : ''
    const providedToken = typeof entry.token === 'string' ? entry.token.trim() : ''
    const token = providedToken || getTelemetrySettings().profiles.find((p) => p.id === id)?.token || ''
    if (!token) return { ok: false, message: 'A token is required (from the PC controller).' }
    try {
      const gpu = (await remoteGet(baseUrl, '/v1/gpu', token)) as GpuStatusResult
      const name = gpu.gpus?.[0]?.name
      return {
        ok: true,
        message: gpu.status === 'observed' && name ? `Connected — ${name}` : `Connected (GPU telemetry: ${gpu.status}).`
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
}
