import { createHash } from 'node:crypto'
import type {
  AdapterGenerationChunk,
  AdapterGenerationRequest,
  RemoteRuntimeAdapter,
  RemoteRuntimeDiscoveryAdapter,
  RemoteRuntimeKind,
  RuntimeModelDescription,
  RuntimeProbeResult
} from './types'

const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

function safeId(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return clean || createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('Runtime endpoint must be an http(s) URL without embedded credentials.')
  }
  return url.toString().replace(/\/$/, '')
}

async function fetchWithDeadline(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new Error('Runtime request timed out.')), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: AbortSignal.any([signal, timeout.signal]) })
  } finally {
    clearTimeout(timer)
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('Runtime response exceeds the catalog size cap.')
  try { return JSON.parse(text) as unknown }
  catch { throw new Error('Runtime returned invalid JSON.') }
}

function unknownCapabilities() {
  return {
    textGeneration: true as const,
    streaming: true,
    cancellation: true,
    toolUse: 'unknown' as const,
    codeEditing: 'unknown' as const,
    multiFileReasoning: 'unknown' as const,
    commandPlanning: 'unknown' as const
  }
}

interface OllamaTag {
  name?: unknown
  model?: unknown
  details?: { quantization_level?: unknown }
}

export class OllamaRemoteRuntimeAdapter implements RemoteRuntimeAdapter {
  readonly id: string
  readonly kind = 'ollama' as const
  readonly label: string

  constructor(readonly baseUrl = 'http://127.0.0.1:11434', label = 'Ollama') {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.id = `ollama-${safeId(new URL(this.baseUrl).host)}`
    this.label = label.trim().slice(0, 100) || 'Ollama'
  }

  async probe(signal: AbortSignal): Promise<RuntimeProbeResult> {
    try {
      const response = await fetchWithDeadline(`${this.baseUrl}/api/tags`, { method: 'GET' }, signal)
      return response.ok ? { available: true } : { available: false, reason: `Ollama returned HTTP ${response.status}.` }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message.slice(0, 300) : 'Ollama is unavailable.' }
    }
  }

  async listModels(signal: AbortSignal): Promise<readonly RuntimeModelDescription[]> {
    const response = await fetchWithDeadline(`${this.baseUrl}/api/tags`, { method: 'GET' }, signal)
    if (!response.ok) throw new Error(`Ollama catalog returned HTTP ${response.status}.`)
    const value = await boundedJson(response)
    const models = value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).models)
      ? (value as { models: OllamaTag[] }).models
      : []
    return models.slice(0, 512).flatMap((entry): RuntimeModelDescription[] => {
      const name = typeof entry.name === 'string' ? entry.name : typeof entry.model === 'string' ? entry.model : ''
      if (!name || name.length > 300 || /[\0\r\n]/.test(name)) return []
      const quantization = typeof entry.details?.quantization_level === 'string'
        ? entry.details.quantization_level.slice(0, 80)
        : undefined
      return [{
        id: name,
        name,
        ...(quantization ? { quantization } : {}),
        capabilities: unknownCapabilities()
      }]
    })
  }

  async *generate(request: AdapterGenerationRequest, signal: AbortSignal): AsyncIterable<AdapterGenerationChunk> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages,
        stream: true,
        options: {
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxOutputTokens !== undefined ? { num_predict: request.maxOutputTokens } : {})
        }
      }),
      signal
    })
    if (!response.ok || !response.body) throw new Error(`Ollama generation returned HTTP ${response.status}.`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let received = 0
    try {
      while (true) {
        const part = await reader.read()
        received += part.value?.byteLength ?? 0
        if (received > MAX_RESPONSE_BYTES * 4) throw new Error('Ollama stream exceeds the output cap.')
        buffer += decoder.decode(part.value, { stream: !part.done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line) as Record<string, unknown>
          const message = event.message as Record<string, unknown> | undefined
          if (typeof message?.content === 'string' && message.content) yield { type: 'delta', text: message.content }
          if (event.done === true) {
            yield {
              type: 'usage',
              ...(typeof event.prompt_eval_count === 'number' ? { promptTokens: event.prompt_eval_count } : {}),
              ...(typeof event.eval_count === 'number' ? { completionTokens: event.eval_count } : {})
            }
          }
        }
        if (part.done) break
      }
    } finally {
      reader.releaseLock()
    }
  }
}

interface OpenAiRuntimeOptions {
  id: string
  kind: Exclude<RemoteRuntimeKind, 'ollama'>
  label: string
  baseUrl: string
}

export class OpenAiCompatibleRemoteRuntimeAdapter implements RemoteRuntimeAdapter {
  readonly id: string
  readonly kind: Exclude<RemoteRuntimeKind, 'ollama'>
  readonly label: string
  readonly baseUrl: string

  constructor(options: OpenAiRuntimeOptions) {
    this.id = safeId(options.id)
    this.kind = options.kind
    this.label = options.label.trim().slice(0, 100)
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
  }

  async probe(signal: AbortSignal): Promise<RuntimeProbeResult> {
    try {
      const response = await fetchWithDeadline(`${this.baseUrl}/v1/models`, { method: 'GET' }, signal)
      return response.ok ? { available: true } : { available: false, reason: `${this.label} returned HTTP ${response.status}.` }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message.slice(0, 300) : `${this.label} is unavailable.` }
    }
  }

  async listModels(signal: AbortSignal): Promise<readonly RuntimeModelDescription[]> {
    const response = await fetchWithDeadline(`${this.baseUrl}/v1/models`, { method: 'GET' }, signal)
    if (!response.ok) throw new Error(`${this.label} catalog returned HTTP ${response.status}.`)
    const value = await boundedJson(response)
    const data = value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).data)
      ? (value as { data: Array<Record<string, unknown>> }).data
      : []
    return data.slice(0, 512).flatMap((entry): RuntimeModelDescription[] => {
      const id = typeof entry.id === 'string' ? entry.id : ''
      if (!id || id.length > 300 || /[\0\r\n]/.test(id)) return []
      return [{ id, name: id, capabilities: unknownCapabilities() }]
    })
  }

  async *generate(request: AdapterGenerationRequest, signal: AbortSignal): AsyncIterable<AdapterGenerationChunk> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages,
        stream: true,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
        stream_options: { include_usage: true }
      }),
      signal
    })
    if (!response.ok || !response.body) throw new Error(`${this.label} generation returned HTTP ${response.status}.`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let received = 0
    try {
      while (true) {
        const part = await reader.read()
        received += part.value?.byteLength ?? 0
        if (received > MAX_RESPONSE_BYTES * 4) throw new Error(`${this.label} stream exceeds the output cap.`)
        buffer += decoder.decode(part.value, { stream: !part.done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data || data === '[DONE]') continue
          const event = JSON.parse(data) as Record<string, unknown>
          const choice = Array.isArray(event.choices) ? event.choices[0] as Record<string, unknown> | undefined : undefined
          const delta = choice?.delta as Record<string, unknown> | undefined
          if (typeof delta?.content === 'string' && delta.content) yield { type: 'delta', text: delta.content }
          const usage = event.usage as Record<string, unknown> | undefined
          if (usage) {
            yield {
              type: 'usage',
              ...(typeof usage.prompt_tokens === 'number' ? { promptTokens: usage.prompt_tokens } : {}),
              ...(typeof usage.completion_tokens === 'number' ? { completionTokens: usage.completion_tokens } : {}),
              ...(typeof usage.cached_tokens === 'number' ? { cachedTokens: usage.cached_tokens } : {})
            }
          }
        }
        if (part.done) break
      }
    } finally {
      reader.releaseLock()
    }
  }
}

export class DefaultLocalRuntimeDiscovery implements RemoteRuntimeDiscoveryAdapter {
  constructor(
    readonly kind: RemoteRuntimeKind,
    private readonly adapters: readonly RemoteRuntimeAdapter[]
  ) {}

  async discover(signal: AbortSignal): Promise<readonly RemoteRuntimeAdapter[]> {
    return signal.aborted ? [] : this.adapters
  }
}

export function defaultRemoteRuntimeDiscoverers(): RemoteRuntimeDiscoveryAdapter[] {
  return [
    new DefaultLocalRuntimeDiscovery('ollama', [new OllamaRemoteRuntimeAdapter()]),
    new DefaultLocalRuntimeDiscovery('lm_studio', [new OpenAiCompatibleRemoteRuntimeAdapter({
      id: 'lm-studio-local', kind: 'lm_studio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234'
    })]),
    new DefaultLocalRuntimeDiscovery('vllm', [new OpenAiCompatibleRemoteRuntimeAdapter({
      id: 'vllm-local', kind: 'vllm', label: 'vLLM', baseUrl: 'http://127.0.0.1:8000'
    })])
  ]
}

