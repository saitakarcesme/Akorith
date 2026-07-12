import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { toClientRemoteModels } from './client-catalog'
import {
  RemoteNodeHttpClient,
  type RemoteNodeHttpClientOptions,
  type RemoteNodePairingResult
} from './http-transport'
import { assessRemoteNodeAddress } from './network-policy'
import { REMOTE_NODE_PROTOCOL_VERSION, type ClientRemoteModel, type RemoteNodeCatalog, type RemoteNodeHealth } from './types'
import {
  REMOTE_NODE_CLIENT_STATE_VERSION,
  type ManagedRemoteNode,
  type ManagedRemoteNodeClient,
  type PairRemoteNodeInput,
  type PersistedRemoteNodeClientState,
  type RemoteNodeClientHandle,
  type RemoteNodeConnectionState,
  type RemoteNodePairingView,
  type RemoteNodeProfile,
  type RemoteNodeTestResult,
  type RemoteNodeTokenVault
} from './client-manager-types'
import { ElectronSafeStorageTokenVault, type ElectronSafeStorageLike } from './token-vault'

const STATE_FILE_LIMIT_BYTES = 2 * 1024 * 1024
const PROFILE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/
const CREDENTIAL_PATTERN = /akrn_v1\.[A-Za-z0-9._:-]+\.[A-Za-z0-9_-]{20,}/g

interface ClientFactoryInput extends RemoteNodeHttpClientOptions {
  baseUrl: string
}

export interface RemoteNodeClientManagerOptions {
  dataDir: string
  tokenVault?: RemoteNodeTokenVault
  safeStorage?: ElectronSafeStorageLike
  clientFactory?: (options: ClientFactoryInput) => ManagedRemoteNodeClient
  stateFileName?: string
  requestTimeoutMs?: number
  healthyPollMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  now?: () => number
  monotonicNow?: () => number
  random?: () => number
}

export interface RemoteCatalogIntegrationView {
  catalog: RemoteNodeCatalog
  models: ClientRemoteModel[]
}

type StateListener = (nodes: ManagedRemoteNode[]) => void

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Remote node request failed.'
  return raw.replace(CREDENTIAL_PATTERN, '[credential]').replace(/[\0\r\n]+/g, ' ').slice(0, 500)
}

function copyConnection(value: RemoteNodeConnectionState): RemoteNodeConnectionState {
  return { ...value }
}

function copyProfile(value: RemoteNodeProfile): RemoteNodeProfile {
  return { ...value }
}

function assertText(value: string, label: string, maxLength: number): string {
  const clean = value.trim()
  if (!clean || clean.length > maxLength || /[\0\r\n]/.test(clean)) throw new Error(`${label} is invalid.`)
  return clean
}

function normalizeAddress(baseUrl: string, acknowledged: boolean): { baseUrl: string; privateLanHttpAcknowledged: boolean } {
  const assessment = assessRemoteNodeAddress(baseUrl, { allowPublicAddress: true })
  if (!assessment.normalizedUrl) throw new Error(assessment.reason ?? 'Remote node address is invalid.')
  const url = new URL(assessment.normalizedUrl)
  if (url.protocol === 'https:' && assessment.allowed) {
    return { baseUrl: assessment.normalizedUrl, privateLanHttpAcknowledged: false }
  }
  if (url.protocol === 'http:' && assessment.classification === 'private') {
    if (!acknowledged) {
      throw new Error('Plaintext HTTP is disabled by default. Explicitly acknowledge this private-LAN connection or configure HTTPS.')
    }
    return { baseUrl: assessment.normalizedUrl, privateLanHttpAcknowledged: true }
  }
  throw new Error(assessment.reason ?? 'Remote node connections require HTTPS outside a private LAN.')
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const handle = await open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, filePath)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseProfile(value: unknown): RemoteNodeProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    typeof input.id !== 'string' || !PROFILE_ID_PATTERN.test(input.id) ||
    typeof input.nodeId !== 'string' || input.nodeId !== input.id ||
    typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 ||
    typeof input.baseUrl !== 'string' ||
    input.protocolVersion !== REMOTE_NODE_PROTOCOL_VERSION ||
    typeof input.deviceId !== 'string' || !PROFILE_ID_PATTERN.test(input.deviceId) ||
    typeof input.deviceName !== 'string' || !input.deviceName.trim() || input.deviceName.length > 200 ||
    !validTimestamp(input.createdAt) || !validTimestamp(input.updatedAt) ||
    typeof input.privateLanHttpAcknowledged !== 'boolean'
  ) return null
  let normalized: { baseUrl: string; privateLanHttpAcknowledged: boolean }
  try { normalized = normalizeAddress(input.baseUrl, input.privateLanHttpAcknowledged) }
  catch { return null }
  return {
    id: input.id,
    nodeId: input.nodeId,
    name: input.name.trim(),
    baseUrl: normalized.baseUrl,
    protocolVersion: REMOTE_NODE_PROTOCOL_VERSION,
    deviceId: input.deviceId,
    deviceName: input.deviceName.trim(),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    privateLanHttpAcknowledged: normalized.privateLanHttpAcknowledged
  }
}

export class RemoteNodeClientManager {
  private readonly stateFile: string
  private readonly tokenVault: RemoteNodeTokenVault
  private readonly clientFactory: (options: ClientFactoryInput) => ManagedRemoteNodeClient
  private readonly requestTimeoutMs: number
  private readonly healthyPollMs: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly now: () => number
  private readonly monotonicNow: () => number
  private readonly random: () => number
  private readonly profiles = new Map<string, RemoteNodeProfile>()
  private readonly connections = new Map<string, RemoteNodeConnectionState>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly probeControllers = new Map<string, AbortController>()
  private readonly probes = new Map<string, Promise<RemoteNodeHealth | undefined>>()
  private readonly listeners = new Set<StateListener>()
  private initialization: Promise<void> | null = null
  private mutationQueue: Promise<void> = Promise.resolve()
  private monitoring = false

  constructor(options: RemoteNodeClientManagerOptions) {
    const dataDir = path.resolve(options.dataDir)
    this.stateFile = path.join(dataDir, options.stateFileName ?? 'remote-nodes.json')
    if (options.tokenVault) this.tokenVault = options.tokenVault
    else if (options.safeStorage) this.tokenVault = new ElectronSafeStorageTokenVault(dataDir, options.safeStorage)
    else throw new Error('Remote node manager requires an encrypted token vault or Electron safeStorage.')
    this.clientFactory = options.clientFactory ?? ((input) => new RemoteNodeHttpClient(input))
    this.requestTimeoutMs = Math.min(Math.max(options.requestTimeoutMs ?? 10_000, 250), 120_000)
    this.healthyPollMs = Math.min(Math.max(options.healthyPollMs ?? 30_000, 1_000), 30 * 60_000)
    this.retryBaseMs = Math.min(Math.max(options.retryBaseMs ?? 2_000, 250), 60_000)
    this.retryMaxMs = Math.min(Math.max(options.retryMaxMs ?? 120_000, this.retryBaseMs), 30 * 60_000)
    this.now = options.now ?? Date.now
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.random = options.random ?? Math.random
  }

  initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.loadState()
    return this.initialization
  }

  async list(): Promise<ManagedRemoteNode[]> {
    await this.initialize()
    return this.snapshot()
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async pair(input: PairRemoteNodeInput): Promise<RemoteNodePairingView> {
    await this.initialize()
    const address = normalizeAddress(input.baseUrl, input.acknowledgePrivateLanHttp === true)
    const pairingId = assertText(input.pairingId, 'Pairing id', 200)
    const code = assertText(input.code, 'Pairing code', 100)
    const deviceName = assertText(input.deviceName, 'Device name', 200)
    const client = this.clientFactory({ baseUrl: address.baseUrl, allowPublicAddress: true })
    const result = await this.withTimeout((signal) => client.pair({ pairingId, code, deviceName }, signal))
    this.validatePairingResult(result)
    const now = this.now()
    const priorByNode = this.profiles.get(result.node.id)
    const priorByAddress = [...this.profiles.values()].find((profile) => profile.baseUrl === address.baseUrl)
    const prior = priorByNode ?? priorByAddress
    const id = result.node.id
    const profile: RemoteNodeProfile = {
      id,
      nodeId: result.node.id,
      name: result.node.name.trim(),
      baseUrl: address.baseUrl,
      protocolVersion: result.node.protocolVersion,
      deviceId: result.device.id,
      deviceName: result.device.name.trim(),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      privateLanHttpAcknowledged: address.privateLanHttpAcknowledged
    }

    await this.mutate(async () => {
      const previousToken = await this.tokenVault.get(id)
      const previousProfile = this.profiles.get(id)
      const previousConnection = this.connections.get(id)
      const replacedToken = prior && prior.id !== id ? await this.tokenVault.get(prior.id) : undefined
      const replacedConnection = prior && prior.id !== id ? this.connections.get(prior.id) : undefined
      try {
        if (prior && prior.id !== id) {
          this.profiles.delete(prior.id)
          this.connections.delete(prior.id)
          await this.tokenVault.delete(prior.id)
        }
        this.profiles.set(id, profile)
        this.connections.set(id, { phase: 'idle', consecutiveFailures: 0 })
        await this.tokenVault.set(id, result.deviceToken)
        await this.persistState()
      } catch (error) {
        if (previousProfile) {
          this.profiles.set(id, previousProfile)
          this.connections.set(id, previousConnection ?? { phase: 'idle', consecutiveFailures: 0 })
        } else {
          this.profiles.delete(id)
          this.connections.delete(id)
        }
        if (previousToken) await this.tokenVault.set(id, previousToken).catch(() => undefined)
        else await this.tokenVault.delete(id).catch(() => undefined)
        if (prior && prior.id !== id) {
          this.profiles.set(prior.id, prior)
          this.connections.set(prior.id, replacedConnection ?? { phase: 'idle', consecutiveFailures: 0 })
          if (replacedToken) await this.tokenVault.set(prior.id, replacedToken).catch(() => undefined)
        }
        throw error
      }
    })
    this.emit()
    if (this.monitoring) this.schedule(id, 0)
    return { node: this.managed(profile), replacedExistingProfile: prior !== undefined }
  }

  async test(nodeId: string): Promise<RemoteNodeTestResult> {
    await this.initialize()
    const profile = this.requireProfile(nodeId)
    const health = await this.probe(profile.id)
    return { node: this.managed(this.requireProfile(profile.id)), ...(health ? { health } : {}) }
  }

  async catalog(nodeId: string, refresh = false): Promise<RemoteCatalogIntegrationView> {
    const handle = await this.client(nodeId)
    const started = this.monotonicNow()
    try {
      const catalog = await this.withTimeout((signal) => handle.client.catalog(refresh, signal))
      if (catalog.node.id !== handle.profile.nodeId) throw new Error('Remote node identity changed unexpectedly.')
      this.markHealthy(nodeId, Math.max(0, Math.round(this.monotonicNow() - started)))
      return { catalog, models: toClientRemoteModels(catalog) }
    } catch (error) {
      this.markFailed(nodeId, error)
      throw new Error(sanitizeError(error))
    }
  }

  /** Returns an authenticated client without exposing its bearer token. */
  async client(nodeId: string): Promise<RemoteNodeClientHandle> {
    await this.initialize()
    const profile = this.requireProfile(nodeId)
    const token = await this.tokenVault.get(profile.id)
    if (!token) throw new Error('Remote node credential is unavailable. Pair this node again.')
    return {
      profile: copyProfile(profile),
      client: this.clientFactory({ baseUrl: profile.baseUrl, deviceToken: token, allowPublicAddress: true })
    }
  }

  /** Local revocation removes the encrypted client credential and its connection profile. */
  async revoke(nodeId: string): Promise<boolean> {
    await this.initialize()
    const existing = this.profiles.get(nodeId)
    if (!existing) return false
    this.clearTimer(nodeId)
    this.probeControllers.get(nodeId)?.abort()
    await this.mutate(async () => {
      await this.tokenVault.delete(nodeId)
      this.profiles.delete(nodeId)
      this.connections.delete(nodeId)
      await this.persistState()
    })
    this.emit()
    return true
  }

  async startMonitoring(): Promise<void> {
    await this.initialize()
    if (this.monitoring) return
    this.monitoring = true
    for (const id of this.profiles.keys()) this.schedule(id, 0)
  }

  stopMonitoring(): void {
    this.monitoring = false
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const controller of this.probeControllers.values()) controller.abort()
    this.probeControllers.clear()
  }

  private async loadState(): Promise<void> {
    let contents: string
    try {
      const file = await readFile(this.stateFile)
      if (file.byteLength > STATE_FILE_LIMIT_BYTES) throw new Error('Remote node profile store exceeds its size cap.')
      contents = file.toString('utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    let parsed: unknown
    try { parsed = JSON.parse(contents) }
    catch { throw new Error('Remote node profile store is not valid JSON.') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Remote node profile store has an invalid shape.')
    const state = parsed as Record<string, unknown>
    if (state.schemaVersion !== REMOTE_NODE_CLIENT_STATE_VERSION || !Array.isArray(state.profiles)) {
      throw new Error('Remote node profile store uses an unsupported schema.')
    }
    for (const value of state.profiles) {
      const profile = parseProfile(value)
      if (!profile || this.profiles.has(profile.id)) continue
      this.profiles.set(profile.id, profile)
      this.connections.set(profile.id, { phase: 'idle', consecutiveFailures: 0 })
    }
  }

  private async persistState(): Promise<void> {
    const state: PersistedRemoteNodeClientState = {
      schemaVersion: REMOTE_NODE_CLIENT_STATE_VERSION,
      profiles: [...this.profiles.values()].map(copyProfile).sort((left, right) => left.id.localeCompare(right.id))
    }
    await atomicWrite(this.stateFile, `${JSON.stringify(state, null, 2)}\n`)
  }

  private snapshot(): ManagedRemoteNode[] {
    return [...this.profiles.values()]
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map((profile) => this.managed(profile))
  }

  private managed(profile: RemoteNodeProfile): ManagedRemoteNode {
    return { ...copyProfile(profile), connection: copyConnection(this.connections.get(profile.id) ?? { phase: 'idle', consecutiveFailures: 0 }) }
  }

  private requireProfile(nodeId: string): RemoteNodeProfile {
    const profile = this.profiles.get(nodeId)
    if (!profile) throw new Error('Remote node profile was not found.')
    return profile
  }

  private validatePairingResult(result: RemoteNodePairingResult): void {
    if (
      !result || result.node.protocolVersion !== REMOTE_NODE_PROTOCOL_VERSION ||
      !PROFILE_ID_PATTERN.test(result.node.id) ||
      !result.node.name?.trim() || result.node.name.length > 200 ||
      !PROFILE_ID_PATTERN.test(result.device.id) ||
      !result.device.name?.trim() || result.device.name.length > 200 ||
      !validTimestamp(result.device.createdAt) ||
      !/^akrn_v1\.[A-Za-z0-9._:-]+\.[A-Za-z0-9_-]{20,}$/.test(result.deviceToken)
    ) throw new Error('Remote node returned an invalid pairing response.')
  }

  private probe(nodeId: string): Promise<RemoteNodeHealth | undefined> {
    const existing = this.probes.get(nodeId)
    if (existing) return existing
    const probe = this.runProbe(nodeId).finally(() => {
      this.probes.delete(nodeId)
      this.probeControllers.delete(nodeId)
      if (this.monitoring && this.profiles.has(nodeId)) {
        const state = this.connections.get(nodeId)
        const delay = Math.max(0, (state?.nextRetryAt ?? this.now() + this.healthyPollMs) - this.now())
        this.schedule(nodeId, delay)
      }
    })
    this.probes.set(nodeId, probe)
    return probe
  }

  private async runProbe(nodeId: string): Promise<RemoteNodeHealth | undefined> {
    if (!this.profiles.has(nodeId)) return undefined
    this.connections.set(nodeId, { ...this.connections.get(nodeId), phase: 'connecting', consecutiveFailures: this.connections.get(nodeId)?.consecutiveFailures ?? 0 })
    this.emit()
    const started = this.monotonicNow()
    const controller = new AbortController()
    this.probeControllers.set(nodeId, controller)
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    timeout.unref?.()
    try {
      const handle = await this.client(nodeId)
      const health = await handle.client.health(controller.signal)
      if (health.node.id !== handle.profile.nodeId || health.node.protocolVersion !== REMOTE_NODE_PROTOCOL_VERSION) {
        throw new Error('Remote node identity changed unexpectedly.')
      }
      if (this.profiles.has(nodeId)) this.markHealthy(nodeId, Math.max(0, Math.round(this.monotonicNow() - started)))
      return health
    } catch (error) {
      if (this.profiles.has(nodeId)) this.markFailed(nodeId, error)
      return undefined
    } finally {
      clearTimeout(timeout)
    }
  }

  private markHealthy(nodeId: string, latencyMs: number): void {
    if (!this.profiles.has(nodeId)) return
    const now = this.now()
    this.connections.set(nodeId, {
      phase: 'online',
      consecutiveFailures: 0,
      lastCheckedAt: now,
      lastHealthyAt: now,
      nextRetryAt: now + this.healthyPollMs,
      latencyMs
    })
    this.emit()
  }

  private markFailed(nodeId: string, error: unknown): void {
    if (!this.profiles.has(nodeId)) return
    const previous = this.connections.get(nodeId) ?? { phase: 'idle' as const, consecutiveFailures: 0 }
    const failures = previous.consecutiveFailures + 1
    const exponential = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(failures - 1, 20)))
    const jittered = Math.round(exponential * (0.9 + this.random() * 0.2))
    const now = this.now()
    this.connections.set(nodeId, {
      phase: previous.lastHealthyAt && failures === 1 ? 'degraded' : 'offline',
      consecutiveFailures: failures,
      lastCheckedAt: now,
      ...(previous.lastHealthyAt ? { lastHealthyAt: previous.lastHealthyAt } : {}),
      nextRetryAt: now + jittered,
      ...(previous.latencyMs !== undefined ? { latencyMs: previous.latencyMs } : {}),
      error: sanitizeError(error)
    })
    this.emit()
  }

  private schedule(nodeId: string, delayMs: number): void {
    if (!this.monitoring || !this.profiles.has(nodeId)) return
    this.clearTimer(nodeId)
    const timer = setTimeout(() => {
      this.timers.delete(nodeId)
      void this.probe(nodeId)
    }, Math.max(0, delayMs))
    timer.unref?.()
    this.timers.set(nodeId, timer)
  }

  private clearTimer(nodeId: string): void {
    const timer = this.timers.get(nodeId)
    if (timer) clearTimeout(timer)
    this.timers.delete(nodeId)
  }

  private withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    timeout.unref?.()
    return operation(controller.signal).finally(() => clearTimeout(timeout))
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private emit(): void {
    if (this.listeners.size === 0) return
    const value = this.snapshot()
    for (const listener of this.listeners) {
      try { listener(value) } catch { /* listener isolation */ }
    }
  }
}
