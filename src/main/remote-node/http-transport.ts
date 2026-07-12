import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { PairingAuthority, PairingError, type PersistedPairingAuthorityState } from './auth'
import { assessRemoteNodeAddress } from './network-policy'
import { RemoteNodeProtocolError, RemoteNodeService } from './service'
import {
  REMOTE_NODE_PROTOCOL_VERSION,
  REMOTE_NODE_SAFETY_POLICY,
  type RemoteGenerationEvent,
  type RemoteGenerationRequest,
  type RemoteNodeCatalog,
  type RemoteNodeHealth,
  type RemoteNodeRequest,
  type RemoteNodeResponse
} from './types'

const JSON_LIMIT_BYTES = 512 * 1024

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(body)
}

async function readJson(request: IncomingMessage, maxBytes = JSON_LIMIT_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw new RemoteNodeProtocolError('request_too_large', 'Request body exceeds the size cap.', 413)
    chunks.push(buffer)
  }
  if (total === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RemoteNodeProtocolError('invalid_request', 'Request body must be valid JSON.', 400) }
}

function errorResponse(response: ServerResponse, error: unknown): void {
  if (error instanceof RemoteNodeProtocolError) {
    json(response, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof PairingError) {
    const status = error.code === 'pairing_not_found' ? 404 : error.code === 'pairing_locked' ? 429 : 400
    json(response, status, { error: { code: error.code, message: error.message } })
    return
  }
  json(response, 500, { error: { code: 'internal_error', message: 'Akorith Node could not complete the request.' } })
}

export interface RemoteNodeHttpServerOptions {
  service: RemoteNodeService
  pairingAuthority: PairingAuthority
  host?: string
  port?: number
  allowLan?: boolean
  persistAuthority?: (state: PersistedPairingAuthorityState) => Promise<void> | void
}

export class RemoteNodeHttpServer {
  private server: Server | null = null

  constructor(private readonly options: RemoteNodeHttpServerOptions) {}

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.server) throw new Error('Akorith Node server is already running.')
    const host = this.options.host?.trim() || '127.0.0.1'
    if ((host === '0.0.0.0' || host === '::') && this.options.allowLan !== true) {
      throw new Error('Wildcard LAN binding requires explicit allowLan=true.')
    }
    const server = createServer((request, response) => void this.handle(request, response))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port ?? 47841, host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    const displayHost = host === '::' ? '[::1]' : host === '0.0.0.0' ? '127.0.0.1' : host
    return { host, port: address.port, url: `http://${displayHost}:${address.port}` }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('access-control-allow-origin', 'null')
    if (request.method === 'GET' && request.url === '/v1/info') {
      json(response, 200, {
        protocolVersion: REMOTE_NODE_PROTOCOL_VERSION,
        node: this.options.service.identity,
        pairingRequired: true,
        safety: REMOTE_NODE_SAFETY_POLICY
      })
      return
    }
    if (request.method !== 'POST') {
      json(response, 404, { error: { code: 'not_found', message: 'Endpoint not found.' } })
      return
    }
    try {
      if (request.url === '/v1/pair') {
        const raw = await readJson(request, 8_192)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PairingError('invalid_pairing_code', 'Pairing payload is invalid.')
        const input = raw as Record<string, unknown>
        const approval = this.options.pairingAuthority.approvePairing({
          pairingId: typeof input.pairingId === 'string' ? input.pairingId : '',
          code: typeof input.code === 'string' ? input.code : '',
          deviceName: typeof input.deviceName === 'string' ? input.deviceName : ''
        })
        await this.options.persistAuthority?.(this.options.pairingAuthority.exportState())
        json(response, 200, {
          protocolVersion: REMOTE_NODE_PROTOCOL_VERSION,
          node: this.options.service.identity,
          device: approval.device,
          deviceToken: approval.deviceToken
        })
        return
      }
      if (request.url !== '/v1/request') {
        json(response, 404, { error: { code: 'not_found', message: 'Endpoint not found.' } })
        return
      }
      const envelope = await readJson(request, this.options.service.caps.maxRequestBodyBytes) as RemoteNodeRequest
      const result = await this.options.service.handle(envelope)
      if (result.kind !== 'generation_stream') {
        json(response, 200, result)
        return
      }
      response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        connection: 'keep-alive'
      })
      response.write(`${JSON.stringify({
        protocolVersion: result.protocolVersion,
        requestId: result.requestId,
        kind: result.kind,
        generationId: result.generationId
      })}\n`)
      for await (const event of result.stream) response.write(`${JSON.stringify(event)}\n`)
      response.end()
    } catch (error) {
      if (!response.headersSent) errorResponse(response, error)
      else response.end(`${JSON.stringify({ type: 'error', code: 'stream_failed', message: 'Generation stream failed.' })}\n`)
    }
  }
}

export interface RemoteNodePairingResult {
  node: { id: string; name: string; protocolVersion: string }
  device: { id: string; name: string; createdAt: number }
  deviceToken: string
}

export interface RemoteNodeHttpClientOptions {
  baseUrl: string
  deviceToken?: string
  allowPublicAddress?: boolean
  fetchImpl?: typeof fetch
}

export class RemoteNodeHttpClient {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private deviceToken: string | undefined

  constructor(options: RemoteNodeHttpClientOptions) {
    const assessment = assessRemoteNodeAddress(options.baseUrl, { allowPublicAddress: options.allowPublicAddress })
    if (!assessment.allowed || !assessment.normalizedUrl) throw new Error(assessment.reason ?? 'Remote node address is blocked.')
    this.baseUrl = assessment.normalizedUrl
    this.deviceToken = options.deviceToken
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  setDeviceToken(token: string): void {
    if (!/^akrn_v1\.[A-Za-z0-9._:-]+\.[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Remote node token is invalid.')
    this.deviceToken = token
  }

  async pair(input: { pairingId: string; code: string; deviceName: string }, signal?: AbortSignal): Promise<RemoteNodePairingResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal
    })
    const value = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(this.responseError(value, response.status))
    if (typeof value.deviceToken !== 'string' || !value.node || !value.device) throw new Error('Remote node returned an invalid pairing response.')
    this.setDeviceToken(value.deviceToken)
    return value as unknown as RemoteNodePairingResult
  }

  async health(signal?: AbortSignal): Promise<RemoteNodeHealth> {
    const response = await this.request('health', {}, signal)
    if (response.kind !== 'health') throw new Error('Remote node returned an unexpected health response.')
    return response.health
  }

  async catalog(refresh = false, signal?: AbortSignal): Promise<RemoteNodeCatalog> {
    const response = await this.request('catalog', { refresh }, signal)
    if (response.kind !== 'catalog') throw new Error('Remote node returned an unexpected catalog response.')
    return response.catalog
  }

  async cancel(generationId: string, signal?: AbortSignal): Promise<boolean> {
    const response = await this.request('cancel', { generationId }, signal)
    if (response.kind !== 'cancel') throw new Error('Remote node returned an unexpected cancellation response.')
    return response.cancelled
  }

  async *generate(body: RemoteGenerationRequest, signal?: AbortSignal): AsyncIterable<RemoteGenerationEvent> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.envelope('generate', body)),
      signal
    })
    if (!response.ok || !response.body) {
      const value = await response.json().catch(() => ({})) as Record<string, unknown>
      throw new Error(this.responseError(value, response.status))
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let first = true
    try {
      while (true) {
        const part = await reader.read()
        buffer += decoder.decode(part.value, { stream: !part.done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const value = JSON.parse(line) as Record<string, unknown>
          if (first) {
            first = false
            if (value.kind !== 'generation_stream') throw new Error('Remote generation stream header is invalid.')
            continue
          }
          if (typeof value.type !== 'string' || typeof value.generationId !== 'string') throw new Error('Remote generation event is invalid.')
          yield value as unknown as RemoteGenerationEvent
        }
        if (part.done) break
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async request(kind: 'health' | 'catalog' | 'cancel', body: Record<string, unknown>, signal?: AbortSignal): Promise<RemoteNodeResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.envelope(kind, body)),
      signal
    })
    const value = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(this.responseError(value, response.status))
    if (value.protocolVersion !== REMOTE_NODE_PROTOCOL_VERSION || value.kind !== kind) {
      throw new Error('Remote node response failed protocol validation.')
    }
    return value as unknown as RemoteNodeResponse
  }

  private envelope(kind: RemoteNodeRequest['kind'], body: unknown): RemoteNodeRequest {
    if (!this.deviceToken) throw new Error('Pair with the remote node before making authenticated requests.')
    return {
      protocolVersion: REMOTE_NODE_PROTOCOL_VERSION,
      requestId: randomUUID(),
      kind,
      bearerToken: this.deviceToken,
      body
    } as RemoteNodeRequest
  }

  private responseError(value: Record<string, unknown>, status: number): string {
    const error = value.error && typeof value.error === 'object' ? value.error as Record<string, unknown> : {}
    return typeof error.message === 'string' ? error.message.slice(0, 500) : `Remote node request failed with HTTP ${status}.`
  }
}

