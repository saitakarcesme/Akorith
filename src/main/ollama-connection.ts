import { ipcMain } from 'electron'
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
