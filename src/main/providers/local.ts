// Local provider — talks to a local Ollama server over HTTP. The user's own
// hardware; no key, no cost. Knows nothing about other providers.

import { spawn } from 'child_process'
import { accessSync, constants, existsSync } from 'fs'
import { networkInterfaces } from 'os'
import { delimiter, join } from 'path'
import {
  BEYEFENDI_MODEL_ID,
  getBeyefendiRuntimeStatus,
  sendBeyefendi
} from '../beyefendi-runtime'
import type {
  Provider,
  ProviderAvailability,
  ProviderConfigEntry,
  ProviderDiscovery,
  SendOptions,
  SendResult
} from './types'

const DEFAULT_BASE_URL = 'http://localhost:11434'
const LOOPBACK_FALLBACK = 'http://127.0.0.1:11434'
const OLLAMA_START_TIMEOUT_MS = 20_000
const OLLAMA_START_RETRY_MS = 30_000
const LAN_PROBE_TIMEOUT_MS = 350
const LAN_PROBE_CONCURRENCY = 32
const MODEL_CACHE_MS = 60_000
const LOCAL_WORKSPACE_CONTEXT_TOKENS = 8_192

let startedOllamaServe = false
let lastOllamaStartAttemptAt = 0

/**
 * Keep configured models first as user preference, while still exposing every
 * model Ollama actually reports. Older configs stored one selected model in
 * `providers.local.models`; treating that as a hard allow-list hid the rest of
 * the local catalog.
 */
export function visibleLocalModels(
  ollamaModels: string[],
  configuredModels: string[] | undefined,
  beyefendiReady: boolean
): string[] {
  const discovered = beyefendiReady
    ? [BEYEFENDI_MODEL_ID, ...ollamaModels]
    : ollamaModels
  const installed = new Set(discovered)
  const preferred = configuredModels?.filter((model) => installed.has(model)) ?? []
  return [...new Set([...preferred, ...discovered])]
}

export function buildOllamaGenerationOptions(
  opts: Pick<SendOptions, 'generation' | 'workingDirectory' | 'intent'>
): Record<string, number> {
  const options: Record<string, number> = {}
  if (
    typeof opts.generation?.temperature === 'number' &&
    Number.isFinite(opts.generation.temperature)
  ) {
    options.temperature = opts.generation.temperature
  }
  if (
    options.temperature === undefined &&
    opts.intent === 'execute' &&
    opts.workingDirectory
  ) {
    // Structured workspace patches should be deterministic. This avoids
    // wasting a bounded retry on prose or a second incompatible JSON shape.
    options.temperature = 0
  }
  if (
    typeof opts.generation?.maxTokens === 'number' &&
    Number.isInteger(opts.generation.maxTokens)
  ) {
    options.num_predict = opts.generation.maxTokens
  }
  // Ollama model tags can advertise 32K-64K contexts. Letting the runner
  // allocate that maximum for every Workspace turn can make even a 4B/7B
  // model fail immediately on an otherwise capable machine. Akorith already
  // sends a bounded project snapshot, so an 8K working context preserves the
  // useful input while keeping local execution inside a practical RAM/VRAM
  // envelope.
  if (opts.workingDirectory) options.num_ctx = LOCAL_WORKSPACE_CONTEXT_TOKENS
  return options
}

const LOCAL_WORKSPACE_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'summary', 'files', 'commands'],
  properties: {
    type: { type: 'string', const: 'workspace_patch' },
    summary: { type: 'string', minLength: 1 },
    rationale: { type: 'string' },
    files: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'operation'],
        properties: {
          path: { type: 'string', minLength: 1 },
          operation: {
            type: 'string',
            enum: ['create', 'modify', 'delete']
          },
          content: { type: 'string' }
        }
      }
    },
    commands: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cmd'],
        properties: {
          cmd: { type: 'string', minLength: 1 },
          reason: { type: 'string' }
        }
      }
    },
    expected_outcome: { type: 'string' }
  }
} as const

export function buildOllamaStructuredOutputOptions(
  opts: Pick<SendOptions, 'intent' | 'workingDirectory'>
): Record<string, unknown> {
  if (opts.intent !== 'execute' || !opts.workingDirectory) return {}
  // Ollama's native JSON-schema constraint keeps large file contents escaped
  // correctly. Disabling model thinking reserves the bounded context for the
  // actual project files and makes streaming progress reflect deliverables.
  return {
    format: LOCAL_WORKSPACE_PATCH_SCHEMA,
    think: false
  }
}

export function formatOllamaHttpError(status: number, rawBody: string): string {
  let detail = rawBody.trim()
  try {
    const parsed = JSON.parse(detail) as { error?: unknown }
    if (typeof parsed.error === 'string') detail = parsed.error
  } catch {
    // Non-JSON proxy/server errors still receive the same bounded treatment.
  }
  detail = detail.replace(/\s+/g, ' ').slice(0, 360)
  return `Ollama /api/chat failed: HTTP ${status}${detail ? ` — ${detail}` : ''}`
}

function cleanBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_BASE_URL
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed || /[\0\r\n]/.test(trimmed)) return DEFAULT_BASE_URL
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : DEFAULT_BASE_URL
  } catch {
    return DEFAULT_BASE_URL
  }
}

function cleanOllamaHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 200 || /[\0\r\n]/.test(trimmed)) return undefined
  return /^[a-z0-9_.:[\]-]+$/i.test(trimmed) ? trimmed : undefined
}

function isUsableExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return process.platform === 'win32' && existsSync(candidate)
  }
}

function commonOllamaExecutableCandidates(): string[] {
  if (process.platform === 'win32') {
    return [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : '',
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Ollama', 'ollama.exe') : '',
      process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Ollama', 'ollama.exe') : '',
      process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Ollama', 'ollama.exe') : ''
    ].filter(Boolean)
  }

  if (process.platform === 'darwin') {
    return ['/Applications/Ollama.app/Contents/Resources/ollama']
  }

  return ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama']
}

function resolveOllamaExecutable(): string | null {
  for (const candidate of commonOllamaExecutableCandidates()) {
    if (isUsableExecutable(candidate)) {
      return candidate
    }
  }

  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  const suffixes =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, process.platform === 'win32' ? `ollama${suffix}` : 'ollama')
      if (isUsableExecutable(candidate)) {
        return candidate
      }
    }
  }
  return null
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1'
  } catch {
    return false
  }
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function lanCandidates(): string[] {
  const out: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isPrivateIpv4(entry.address)) continue
      const parts = entry.address.split('.')
      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}.`
      for (let host = 1; host < 255; host++) {
        const ip = `${prefix}${host}`
        if (ip !== entry.address) out.push(`http://${ip}:11434`)
      }
    }
  }
  return [...new Set(out)]
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class LocalProvider implements Provider {
  readonly id = 'local'
  readonly label = 'Local (Ollama)'
  readonly kind: Provider['kind'] = ['chat', 'executor']
  private readonly baseUrl: string
  private readonly autoStart: boolean
  private readonly exposeLan: boolean
  private readonly lanDiscovery: boolean
  private readonly ollamaHost?: string
  private readonly configuredModels?: string[]
  private reachableBaseUrl: string | null = null
  private modelCache: { baseUrl: string; capturedAt: number; models: string[] } | null = null

  constructor(entry: ProviderConfigEntry) {
    this.baseUrl = cleanBaseUrl(entry.baseUrl)
    this.autoStart = typeof entry.autoStart === 'boolean' ? entry.autoStart : true
    this.exposeLan = entry.exposeLan !== false
    this.lanDiscovery = entry.lanDiscovery !== false
    this.ollamaHost = cleanOllamaHost(entry.ollamaHost)
    this.configuredModels = entry.models
      ?.map((model) => model.trim())
      .filter((model, index, models) => Boolean(model) && models.indexOf(model) === index)
  }

  private visibleModels(ollamaModels: string[], beyefendiReady: boolean): string[] {
    return visibleLocalModels(ollamaModels, this.configuredModels, beyefendiReady)
  }

  private baseUrls(): string[] {
    const configured = this.baseUrl === DEFAULT_BASE_URL ? [this.baseUrl, LOOPBACK_FALLBACK] : [this.baseUrl]
    return [...new Set([...(this.reachableBaseUrl ? [this.reachableBaseUrl] : []), ...configured])]
  }

  private async probeTags(timeoutMs: number): Promise<{ baseUrl: string; models: string[] }> {
    let lastError: unknown
    for (const baseUrl of this.baseUrls()) {
      try {
        const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
        if (res.ok) {
          this.reachableBaseUrl = baseUrl
          const body = (await res.json()) as { models?: { name?: string }[] }
          const models = (body.models ?? [])
            .map((model) => model.name)
            .filter((name): name is string => typeof name === 'string')
          this.modelCache = { baseUrl, capturedAt: Date.now(), models }
          return { baseUrl, models }
        }
        lastError = new Error(`Ollama responded with HTTP ${res.status} at ${baseUrl}`)
      } catch (err) {
        lastError = err
      }
    }
    throw lastError
  }

  private async discoverLanServer(): Promise<string | null> {
    if (!this.lanDiscovery || !isLoopback(this.baseUrl)) return null
    const candidates = lanCandidates()
    let index = 0
    let found: string | null = null
    const worker = async (): Promise<void> => {
      while (!found && index < candidates.length) {
        const baseUrl = candidates[index++]
        try {
          const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(LAN_PROBE_TIMEOUT_MS) })
          if (res.ok) {
            found = baseUrl
            this.reachableBaseUrl = baseUrl
            const body = (await res.json()) as { models?: { name?: string }[] }
            const models = (body.models ?? [])
              .map((model) => model.name)
              .filter((name): name is string => typeof name === 'string')
            this.modelCache = { baseUrl, capturedAt: Date.now(), models }
            return
          }
        } catch {
          // Keep probing bounded LAN candidates.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(LAN_PROBE_CONCURRENCY, candidates.length) }, () => worker()))
    return found
  }

  private startLocalServer(): boolean {
    if (!this.autoStart || !isLoopback(this.baseUrl)) return false
    if (startedOllamaServe && Date.now() - lastOllamaStartAttemptAt < OLLAMA_START_RETRY_MS) return true
    const executable = resolveOllamaExecutable()
    if (!executable) return false

    const env = { ...process.env }
    if (this.exposeLan || this.ollamaHost) {
      env.OLLAMA_HOST = this.ollamaHost ?? '0.0.0.0:11434'
    }

    try {
      const child = spawn(executable, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env
      })
      child.unref()
      startedOllamaServe = true
      lastOllamaStartAttemptAt = Date.now()
      child.once('exit', () => {
        startedOllamaServe = false
      })
      child.once('error', () => {
        startedOllamaServe = false
      })
      return true
    } catch {
      return false
    }
  }

  private async ensureReachable(timeoutMs: number, allowStart: boolean): Promise<string> {
    try {
      return (await this.probeTags(timeoutMs)).baseUrl
    } catch (firstError) {
      const lan = await this.discoverLanServer()
      if (lan) return lan
      if (!allowStart || !this.startLocalServer()) throw firstError
    }

    const deadline = Date.now() + OLLAMA_START_TIMEOUT_MS
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        return (await this.probeTags(1_500)).baseUrl
      } catch (err) {
        lastError = err
        await wait(350)
      }
    }
    throw lastError ?? new Error('Ollama did not become reachable after auto-start')
  }

  async isAvailable(): Promise<ProviderAvailability> {
    // Beyefendi is a managed Local runtime and remains usable when the
    // companion Ollama daemon is temporarily offline.
    if (getBeyefendiRuntimeStatus().available) return { ok: true }
    try {
      await this.ensureReachable(2_000, true)
      return { ok: true }
    } catch {
      // A private LAN endpoint only routes on the same network as the Ollama
      // machine; off-network it will never connect without a VPN/Tailscale.
      const host = (() => {
        try {
          return new URL(this.baseUrl).hostname.replace(/^\[|\]$/g, '')
        } catch {
          return ''
        }
      })()
      if (host && isPrivateIpv4(host)) {
        return {
          ok: false,
          reason: `Ollama not reachable at ${this.baseUrl} — that's a LAN address that only works on the same Wi-Fi as the PC. On another network, run Tailscale on both machines and use the PC's Tailscale address (100.x.x.x).`
        }
      }
      const auto = this.autoStart && isLoopback(this.baseUrl)
        ? startedOllamaServe
          ? '; Akorith is starting Ollama'
          : '; Akorith tried to auto-start it'
        : ''
      return { ok: false, reason: `Ollama not reachable at ${this.baseUrl}${auto}` }
    }
  }

  async warmUp(): Promise<void> {
    await this.ensureReachable(1_500, true)
  }

  async listModels(): Promise<string[]> {
    const beyefendiReady = getBeyefendiRuntimeStatus().available
    if (this.modelCache && Date.now() - this.modelCache.capturedAt < MODEL_CACHE_MS) {
      return this.visibleModels(this.modelCache.models, beyefendiReady)
    }
    try {
      await this.ensureReachable(5_000, true)
    } catch (error) {
      if (beyefendiReady) return this.visibleModels([], true)
      throw error
    }
    const models = this.modelCache?.models ?? []
    return this.visibleModels(models, beyefendiReady)
  }

  async discover(force = false): Promise<ProviderDiscovery> {
    if (!force && this.modelCache && Date.now() - this.modelCache.capturedAt < MODEL_CACHE_MS) {
      return { available: { ok: true }, models: await this.listModels() }
    }
    const available = await this.isAvailable()
    return {
      available,
      models: available.ok ? await this.listModels() : []
    }
  }

  async send(prompt: string, opts: SendOptions, onToken: (t: string) => void): Promise<SendResult> {
    let model = opts.model
    if (!model || model === 'default') {
      model = (await this.listModels())[0]
      if (!model) throw new Error('No Ollama models installed — run `ollama pull <model>` first')
    }
    if (model === BEYEFENDI_MODEL_ID) {
      return sendBeyefendi(prompt, { ...opts, model }, onToken)
    }
    const baseUrl = await this.ensureReachable(5_000, true)

    const generationOptions = buildOllamaGenerationOptions(opts)
    const structuredOutputOptions = buildOllamaStructuredOutputOptions(opts)

    const res = await fetch(`${this.reachableBaseUrl ?? baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: prompt,
          ...(opts.images?.length ? { images: opts.images.map((image) => image.dataBase64) } : {})
        }],
        stream: true,
        ...(Object.keys(generationOptions).length > 0 ? { options: generationOptions } : {}),
        ...structuredOutputOptions,
        ...(opts.background === true ? { keep_alive: '30m' } : {})
      }),
      signal: opts.signal
    })
    if (!res.ok) {
      const rawBody = await res.text().catch(() => '')
      throw new Error(formatOllamaHttpError(res.status, rawBody))
    }
    if (!res.body) throw new Error('Ollama /api/chat failed: response body was empty')

    const decoder = new TextDecoder()
    let lineBuffer = ''
    let text = ''
    let finalChunk: OllamaChunk | null = null

    const handleLine = (line: string): void => {
      if (!line.trim()) return
      let chunk: OllamaChunk
      try {
        chunk = JSON.parse(line) as OllamaChunk
      } catch {
        return
      }
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`)
      const token = chunk.message?.content
      if (token) {
        text += token
        onToken(token)
      }
      if (chunk.done) finalChunk = chunk
    }

    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      lineBuffer += decoder.decode(part, { stream: true })
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    }
    if (lineBuffer.trim()) handleLine(lineBuffer)

    // Cast: TS can't see the closure assignment inside handleLine.
    const done = finalChunk as OllamaChunk | null
    return {
      text,
      usage: {
        // Ollama reports real counts; local inference costs nothing.
        promptTokens: done?.prompt_eval_count,
        completionTokens: done?.eval_count,
        totalTokens: (done?.prompt_eval_count ?? 0) + (done?.eval_count ?? 0),
        costUsd: 0,
        estimated: false
      },
      model: done?.model ?? model,
      raw: done ?? undefined
    }
  }
}

export function warmLocalProvider(entry: ProviderConfigEntry): void {
  const provider = new LocalProvider(entry)
  void provider.warmUp().catch((err) => {
    console.error('[local] Ollama auto-start failed:', err)
  })
}

interface OllamaChunk {
  model?: string
  message?: { content?: string }
  done?: boolean
  done_reason?: string
  error?: string
  prompt_eval_count?: number
  eval_count?: number
}
