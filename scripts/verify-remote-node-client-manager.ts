import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RemoteNodeClientManager } from '../src/main/remote-node/client-manager.ts'
import type { ManagedRemoteNodeClient } from '../src/main/remote-node/client-manager-types.ts'
import { ElectronSafeStorageTokenVault, type ElectronSafeStorageLike } from '../src/main/remote-node/token-vault.ts'
import {
  REMOTE_NODE_PROTOCOL_VERSION,
  REMOTE_NODE_SAFETY_POLICY,
  type RemoteGenerationEvent,
  type RemoteGenerationRequest,
  type RemoteNodeCatalog,
  type RemoteNodeHealth
} from '../src/main/remote-node/types.ts'
import type { RemoteNodePairingResult } from '../src/main/remote-node/http-transport.ts'

let assertions = 0
function equal<T>(actual: T, expected: T): void {
  assert.deepEqual(actual, expected)
  assertions += 1
}

async function rejects(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(operation, pattern)
  assertions += 1
}

class XorSafeStorage implements ElectronSafeStorageLike {
  constructor(private readonly available = true) {}
  isEncryptionAvailable(): boolean { return this.available }
  encryptString(plainText: string): Buffer {
    return Buffer.from(plainText, 'utf8').map((byte, index) => byte ^ ((0x5a + index) & 0xff))
  }
  decryptString(encryptedValue: Buffer): string {
    return Buffer.from(encryptedValue).map((byte, index) => byte ^ ((0x5a + index) & 0xff)).toString('utf8')
  }
}

const TOKENS = {
  secure: 'akrn_v1.secure-device.ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
  lan: 'akrn_v1.lan-device.ZYXWVUTSRQPONMLKJIHGFEDCBA654321'
}

let failHealth = false
const authenticatedTokens: Array<string | undefined> = []

function identityFor(baseUrl: string): { id: string; name: string; deviceId: string; token: string } {
  if (baseUrl.startsWith('http://192.168.')) {
    return { id: 'node-lan', name: 'LAN RTX', deviceId: 'lan-device', token: TOKENS.lan }
  }
  return { id: 'node-secure', name: 'Secure RTX', deviceId: 'secure-device', token: TOKENS.secure }
}

function health(baseUrl: string): RemoteNodeHealth {
  const identity = identityFor(baseUrl)
  return {
    schemaVersion: 1,
    checkedAt: 1_700_000_000_000,
    node: { id: identity.id, name: identity.name, protocolVersion: REMOTE_NODE_PROTOCOL_VERSION },
    hardware: {
      observedAt: 1_700_000_000_000,
      platform: 'win32',
      architecture: 'x64',
      cpu: { logicalCores: 16, model: 'Fixture CPU' },
      memory: { totalBytes: 64 * 1024 ** 3, freeBytes: 32 * 1024 ** 3 },
      gpu: {
        status: 'observed',
        devices: [{ id: 'gpu-0', name: 'RTX Fixture', utilizationPercent: 37, memoryUsedBytes: 8 * 1024 ** 3, memoryTotalBytes: 24 * 1024 ** 3 }]
      }
    },
    load: { activeGenerations: 0, queuedGenerations: 0, maxConcurrentGenerations: 2, utilizationPercent: 0 },
    runtimeCount: 1,
    modelCount: 1,
    safety: REMOTE_NODE_SAFETY_POLICY
  }
}

function catalog(baseUrl: string): RemoteNodeCatalog {
  const current = health(baseUrl)
  return {
    schemaVersion: 1,
    generatedAt: current.checkedAt,
    node: current.node,
    hardware: current.hardware,
    load: current.load,
    runtimes: [{ id: 'ollama-fixture', kind: 'ollama', label: 'Ollama', available: true, latencyMs: 8 }],
    models: [{
      key: 'ollama-fixture:qwen-coder',
      runtimeId: 'ollama-fixture',
      runtimeKind: 'ollama',
      id: 'qwen-coder',
      name: 'Qwen Coder',
      available: true,
      contextLength: 32_768,
      capabilities: {
        textGeneration: true,
        streaming: true,
        cancellation: true,
        toolUse: 'unknown',
        codeEditing: 'unknown',
        multiFileReasoning: 'unknown',
        commandPlanning: 'unknown'
      }
    }],
    safety: REMOTE_NODE_SAFETY_POLICY,
    warnings: []
  }
}

class FixtureClient implements ManagedRemoteNodeClient {
  constructor(readonly baseUrl: string, private readonly deviceToken?: string) {
    if (deviceToken) authenticatedTokens.push(deviceToken)
  }

  async pair(input: { pairingId: string; code: string; deviceName: string }): Promise<RemoteNodePairingResult> {
    assert.ok(input.pairingId)
    assert.ok(input.code)
    const identity = identityFor(this.baseUrl)
    return {
      node: { id: identity.id, name: identity.name, protocolVersion: REMOTE_NODE_PROTOCOL_VERSION },
      device: { id: identity.deviceId, name: input.deviceName, createdAt: 1_700_000_000_000 },
      deviceToken: identity.token
    }
  }

  async health(): Promise<RemoteNodeHealth> {
    if (!this.deviceToken) throw new Error('fixture has no credential')
    if (failHealth) throw new Error(`fixture offline; bearer ${this.deviceToken}`)
    return health(this.baseUrl)
  }

  async catalog(): Promise<RemoteNodeCatalog> {
    if (!this.deviceToken) throw new Error('fixture has no credential')
    return catalog(this.baseUrl)
  }

  async cancel(): Promise<boolean> { return true }

  async *generate(_body: RemoteGenerationRequest): AsyncIterable<RemoteGenerationEvent> {
    yield { type: 'started', generationId: 'fixture-generation', modelKey: 'ollama-fixture:qwen-coder', at: 1 }
    yield { type: 'completed', generationId: 'fixture-generation', at: 2 }
  }
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'akorith-remote-manager-'))
  const safeStorage = new XorSafeStorage()
  let wallClock = 10_000
  let monotonic = 100
  const managerOptions = {
    dataDir,
    safeStorage,
    clientFactory: (input: { baseUrl: string; deviceToken?: string }) => new FixtureClient(input.baseUrl, input.deviceToken),
    now: () => wallClock,
    monotonicNow: () => monotonic,
    random: () => 0.5,
    retryBaseMs: 1_000,
    retryMaxMs: 8_000,
    healthyPollMs: 30_000
  }

  try {
    const manager = new RemoteNodeClientManager(managerOptions)
    await rejects(manager.pair({
      baseUrl: 'http://192.168.1.70:47841', pairingId: 'pair-lan', code: '123456', deviceName: 'Akorith Desktop'
    }), /disabled by default/i)
    await rejects(manager.pair({
      baseUrl: 'http://203.0.113.70:47841', pairingId: 'pair-public', code: '123456', deviceName: 'Akorith Desktop', acknowledgePrivateLanHttp: true
    }), /HTTPS|plaintext/i)

    const secure = await manager.pair({
      baseUrl: 'https://compute.example:47841/', pairingId: 'pair-secure', code: '654321', deviceName: 'Akorith Desktop'
    })
    equal(secure.node.id, 'node-secure')
    equal(secure.node.baseUrl, 'https://compute.example:47841')
    equal(secure.node.privateLanHttpAcknowledged, false)
    equal(secure.replacedExistingProfile, false)

    const profileFile = await readFile(path.join(dataDir, 'remote-nodes.json'), 'utf8')
    const credentialFile = await readFile(path.join(dataDir, 'remote-node-secrets.json'), 'utf8')
    assert.ok(!profileFile.includes(TOKENS.secure)); assertions += 1
    assert.ok(!profileFile.includes('654321')); assertions += 1
    assert.ok(!credentialFile.includes(TOKENS.secure)); assertions += 1
    equal(JSON.parse(profileFile).profiles[0].baseUrl, 'https://compute.example:47841')

    monotonic += 17
    const tested = await manager.test('node-secure')
    equal(tested.node.connection.phase, 'online')
    equal(tested.node.connection.latencyMs, 0)
    equal(tested.health?.hardware.gpu.status, 'observed')
    assert.ok(authenticatedTokens.includes(TOKENS.secure)); assertions += 1

    const remoteCatalog = await manager.catalog('node-secure', true)
    equal(remoteCatalog.models.length, 1)
    equal(remoteCatalog.models[0].location, 'remote')
    equal(remoteCatalog.models[0].executionPolicy.nodeCommandExecution, false)

    failHealth = true
    wallClock = 20_000
    monotonic += 3
    const failed = await manager.test('node-secure')
    equal(failed.health, undefined)
    equal(failed.node.connection.phase, 'degraded')
    equal(failed.node.connection.consecutiveFailures, 1)
    equal(failed.node.connection.nextRetryAt, 21_000)
    assert.ok(!failed.node.connection.error?.includes(TOKENS.secure)); assertions += 1
    assert.match(failed.node.connection.error ?? '', /\[credential\]/); assertions += 1

    failHealth = false
    const restarted = new RemoteNodeClientManager(managerOptions)
    const restored = await restarted.list()
    equal(restored.length, 1)
    equal(restored[0].connection.phase, 'idle')
    equal(restored[0].nodeId, 'node-secure')
    const restartTest = await restarted.test('node-secure')
    equal(restartTest.node.connection.phase, 'online')
    assert.ok(authenticatedTokens.filter((value) => value === TOKENS.secure).length >= 2); assertions += 1

    const lanPair = await restarted.pair({
      baseUrl: 'http://192.168.1.70:47841',
      pairingId: 'pair-lan',
      code: '123456',
      deviceName: 'Akorith Desktop',
      acknowledgePrivateLanHttp: true
    })
    equal(lanPair.node.privateLanHttpAcknowledged, true)
    equal((await restarted.list()).length, 2)

    equal(await restarted.revoke('node-secure'), true)
    equal(await restarted.revoke('node-secure'), false)
    await rejects(restarted.client('node-secure'), /not found/i)
    equal((await restarted.list()).map((node) => node.id), ['node-lan'])

    const finalRestart = new RemoteNodeClientManager(managerOptions)
    equal((await finalRestart.list()).map((node) => node.id), ['node-lan'])
    const vault = new ElectronSafeStorageTokenVault(dataDir, safeStorage)
    equal(await vault.get('node-secure'), undefined)
    equal(await vault.get('node-lan'), TOKENS.lan)

    const unavailableDir = await mkdtemp(path.join(os.tmpdir(), 'akorith-remote-manager-unavailable-'))
    try {
      const unavailable = new RemoteNodeClientManager({
        ...managerOptions,
        dataDir: unavailableDir,
        safeStorage: new XorSafeStorage(false)
      })
      await rejects(unavailable.pair({
        baseUrl: 'https://compute.example:47841', pairingId: 'pair-secure', code: '654321', deviceName: 'Akorith Desktop'
      }), /Secure credential storage is unavailable/i)
      equal((await unavailable.list()).length, 0)
    } finally {
      await rm(unavailableDir, { recursive: true, force: true })
    }

    console.log(`Remote node client manager verification passed (${assertions} assertions).`)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
