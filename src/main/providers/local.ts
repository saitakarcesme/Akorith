// Local provider — talks to a local Ollama server over HTTP. The user's own
// hardware; no key, no cost. Knows nothing about other providers.

import { spawn } from 'child_process'
import { accessSync, constants, existsSync } from 'fs'
import { networkInterfaces } from 'os'
import { delimiter, join } from 'path'
import type {
  Provider,
  ProviderAvailability,
  ProviderConfigEntry,
  SendOptions,
  SendResult
} from './types'

const DEFAULT_BASE_URL = 'http://localhost:11434'
const LOOPBACK_FALLBACK = 'http://127.0.0.1:11434'
const OLLAMA_START_TIMEOUT_MS = 20_000
const OLLAMA_START_RETRY_MS = 30_000
const LAN_PROBE_TIMEOUT_MS = 350
const LAN_PROBE_CONCURRENCY = 32

let startedOllamaServe = false
let lastOllamaStartAttemptAt = 0

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
  private reachableBaseUrl: string | null = null

  constructor(entry: ProviderConfigEntry) {
    this.baseUrl = cleanBaseUrl(entry.baseUrl)
    this.autoStart = typeof entry.autoStart === 'boolean' ? entry.autoStart : true
    this.exposeLan = entry.exposeLan !== false
    this.lanDiscovery = entry.lanDiscovery !== false
    this.ollamaHost = cleanOllamaHost(entry.ollamaHost)
  }

  private baseUrls(): string[] {
    return this.baseUrl === DEFAULT_BASE_URL ? [this.baseUrl, LOOPBACK_FALLBACK] : [this.baseUrl]
  }

  private async probeTags(timeoutMs: number): Promise<{ baseUrl: string; response: Response }> {
    let lastError: unknown
    for (const baseUrl of this.baseUrls()) {
      try {
        const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
        if (res.ok) {
          this.reachableBaseUrl = baseUrl
          return { baseUrl, response: res }
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

  private async fetchTags(timeoutMs: number): Promise<Response> {
    if (this.reachableBaseUrl) {
      const res = await fetch(`${this.reachableBaseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
      if (res.ok) return res
    }
    return (await this.probeTags(timeoutMs)).response
  }

  async isAvailable(): Promise<ProviderAvailability> {
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
    await this.ensureReachable(5_000, true)
    const res = await this.fetchTags(5_000)
    const body = (await res.json()) as { models?: { name?: string }[] }
    return (body.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string')
  }

  async send(prompt: string, opts: SendOptions, onToken: (t: string) => void): Promise<SendResult> {
    const baseUrl = await this.ensureReachable(5_000, true)
    let model = opts.model
    if (!model || model === 'default') {
      model = (await this.listModels())[0]
      if (!model) throw new Error('No Ollama models installed — run `ollama pull <model>` first')
    }

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
        ...(opts.background === true ? { keep_alive: '30m' } : {})
      }),
      signal: opts.signal
    })
    if (!res.ok || !res.body) {
      throw new Error(`Ollama /api/chat failed: HTTP ${res.status}`)
    }

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
  error?: string
  prompt_eval_count?: number
  eval_count?: number
}
