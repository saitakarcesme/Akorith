import assert from 'node:assert/strict'
import {
  PairingAuthority,
  PairingError,
  REMOTE_NODE_PROTOCOL_VERSION,
  REMOTE_NODE_SAFETY_POLICY,
  RUNTIME_DISCOVERY_SEAMS,
  RemoteNodeProtocolError,
  RemoteNodeService,
  StaticRuntimeDiscovery,
  assessRemoteNodeAddress,
  toClientRemoteModels,
  validateGenerationRequest,
  validateHardwareSnapshot,
  type AdapterGenerationChunk,
  type AdapterGenerationRequest,
  type RemoteGenerationEvent,
  type RemoteHardwareSnapshot,
  type RemoteNodeResponse,
  type RemoteRuntimeAdapter,
  type RuntimeModelDescription
} from '../src/main/remote-node/index.ts'

function pairingCodeOtherThan(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, '0')
}

function approveDevice(authority: PairingAuthority, deviceName: string, now: number): { id: string; token: string } {
  const challenge = authority.beginPairing({ nodeName: 'Fixture Node', now, ttlMs: 10_000 })
  const approved = authority.approvePairing({ pairingId: challenge.pairingId, code: challenge.code, deviceName, now: now + 1 })
  return { id: approved.device.id, token: approved.deviceToken }
}

function envelope(kind: string, bearerToken: string, body: Record<string, unknown>, requestId: string): Record<string, unknown> {
  return { protocolVersion: REMOTE_NODE_PROTOCOL_VERSION, requestId, kind, bearerToken, body }
}

async function expectProtocolError(promise: Promise<unknown>, code: RemoteNodeProtocolError['code']): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof RemoteNodeProtocolError && error.code === code)
}

function expectPairingError(action: () => unknown, code: PairingError['code']): void {
  assert.throws(action, (error: unknown) => error instanceof PairingError && error.code === code)
}

async function main(): Promise<void> {
// Pairing codes expire, are one-use, and are compared through the authority's
// constant-time digest path. Device bearer tokens are returned once and only a
// digest remains in the authority's private record.
const authority = new PairingAuthority({ defaultTtlMs: 10_000, maxTtlMs: 10_000 })
const wrongCodeChallenge = authority.beginPairing({ nodeName: 'Fixture Node', now: 1_000, ttlMs: 10_000 })
expectPairingError(
  () =>
    authority.approvePairing({
      pairingId: wrongCodeChallenge.pairingId,
      code: pairingCodeOtherThan(wrongCodeChallenge.code),
      deviceName: 'Wrong-code client',
      now: 1_001
    }),
  'invalid_pairing_code'
)

const expiredChallenge = authority.beginPairing({ nodeName: 'Fixture Node', now: 20_000, ttlMs: 10_000 })
expectPairingError(
  () => authority.approvePairing({ pairingId: expiredChallenge.pairingId, code: expiredChallenge.code, deviceName: 'Late client', now: 30_000 }),
  'pairing_expired'
)

const replayChallenge = authority.beginPairing({ nodeName: 'Fixture Node', now: 40_000, ttlMs: 10_000 })
const replayApproval = authority.approvePairing({
  pairingId: replayChallenge.pairingId,
  code: replayChallenge.code,
  deviceName: 'Primary client',
  now: 40_001
})
expectPairingError(
  () =>
    authority.approvePairing({
      pairingId: replayChallenge.pairingId,
      code: replayChallenge.code,
      deviceName: 'Replay client',
      now: 40_002
    }),
  'pairing_replayed'
)
assert.equal(authority.authenticate('akrn_v1.invalid.invalid-secret'), null, 'invalid bearer token is rejected')
assert.equal(authority.authenticate(replayApproval.deviceToken)?.id, replayApproval.device.id, 'approved token authenticates')
assert.ok(!JSON.stringify(authority.listDevices()).includes(replayApproval.deviceToken), 'public device views never expose bearer tokens')
const authorityInternals = authority as unknown as {
  devices: Map<string, { tokenDigest: Buffer; deviceToken?: string }>
}
const storedDevice = authorityInternals.devices.get(replayApproval.device.id)
assert.ok(storedDevice?.tokenDigest instanceof Buffer, 'a token digest is retained')
assert.equal(storedDevice?.deviceToken, undefined, 'plaintext token is not retained')
assert.ok(!storedDevice?.tokenDigest.toString('hex').includes(replayApproval.deviceToken), 'stored digest is not plaintext')
assert.equal(authority.revokeDevice(replayApproval.device.id, 40_003), true)
assert.equal(authority.authenticate(replayApproval.deviceToken, 40_004), null, 'revoked tokens stop authenticating immediately')

// LAN/Tailscale destinations are accepted. Public or unresolved destinations
// warn and are blocked by default; public access requires explicit opt-in and TLS.
assert.equal(assessRemoteNodeAddress('http://192.168.1.20:4010').allowed, true)
assert.equal(assessRemoteNodeAddress('http://100.100.20.5:4010').classification, 'private', 'Tailscale CGNAT is private')
assert.equal(assessRemoteNodeAddress('http://[fd00::20]:4010').classification, 'private', 'IPv6 unique-local addresses are private')
const blockedPublic = assessRemoteNodeAddress('https://203.0.113.8:4010')
assert.equal(blockedPublic.allowed, false)
assert.equal(blockedPublic.requiresExplicitPublicOptIn, true)
assert.ok(blockedPublic.warnings.some((warning) => /public network address/i.test(warning)))
assert.equal(assessRemoteNodeAddress('http://203.0.113.8:4010', { allowPublicAddress: true }).allowed, false, 'plaintext public access stays blocked')
assert.equal(assessRemoteNodeAddress('https://203.0.113.8:4010', { allowPublicAddress: true }).allowed, true)
const unknownHost = assessRemoteNodeAddress('https://node.example.test:4010')
assert.equal(unknownHost.classification, 'unknown')
assert.ok(unknownHost.warnings.some((warning) => /could not be proven private/i.test(warning)))
assert.equal(assessRemoteNodeAddress('http://0.0.0.0:4010').allowed, false, 'wildcard bind addresses are not connectable')

const verifiedCapabilities = {
  textGeneration: true as const,
  streaming: true,
  cancellation: true,
  toolUse: 'unknown' as const,
  codeEditing: 'verified' as const,
  multiFileReasoning: 'verified' as const,
  commandPlanning: 'reported' as const
}

let abortObserved = false
let lastAdapterRequest: AdapterGenerationRequest | null = null
const fixtureModel: RuntimeModelDescription = {
  id: 'acme/qwen2.5-coder+instruct',
  name: 'Qwen 2.5 Coder Fixture',
  contextLength: 32_768,
  quantization: 'Q4_K_M',
  requiredVramBytes: 8 * 1024 ** 3,
  capabilities: verifiedCapabilities
}

const fixtureAdapter: RemoteRuntimeAdapter = {
  id: 'ollama-fixture',
  kind: 'ollama',
  label: 'Ollama Fixture',
  async probe() {
    return { available: true, load: { activeRequests: 1, queuedRequests: 0, utilizationPercent: 25 } }
  },
  async listModels() {
    return [fixtureModel]
  },
  async *generate(request: AdapterGenerationRequest, signal: AbortSignal): AsyncIterable<AdapterGenerationChunk> {
    lastAdapterRequest = request
    yield { type: 'delta', text: 'alpha' }
    const shouldWait = request.messages.some((message) => message.content.includes('cancel me'))
    if (shouldWait) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          abortObserved = true
          resolve()
          return
        }
        const timeout = setTimeout(resolve, 500)
        signal.addEventListener(
          'abort',
          () => {
            abortObserved = true
            clearTimeout(timeout)
            resolve()
          },
          { once: true }
        )
      })
    }
    if (signal.aborted) {
      abortObserved = true
      return
    }
    yield { type: 'delta', text: ' beta' }
    yield { type: 'usage', promptTokens: 4, completionTokens: 2, cachedTokens: 1 }
  }
}

const honestHardware: RemoteHardwareSnapshot = {
  observedAt: 50_000,
  platform: 'win32',
  architecture: 'x64',
  cpu: { logicalCores: 16, model: 'Fixture CPU' },
  memory: { totalBytes: 64 * 1024 ** 3, freeBytes: 32 * 1024 ** 3 },
  gpu: {
    status: 'observed',
    devices: [
      {
        id: 'gpu-0',
        name: 'Fixture GPU',
        utilizationPercent: 42,
        memoryUsedBytes: 6 * 1024 ** 3,
        memoryTotalBytes: 24 * 1024 ** 3,
        activeModel: fixtureModel.name
      }
    ]
  }
}
assert.equal(validateHardwareSnapshot(honestHardware).ok, true)
const sanitizedHardware = validateHardwareSnapshot({
  ...honestHardware,
  localPath: 'C:\\must-not-leak',
  gpu: {
    ...honestHardware.gpu,
    devices: honestHardware.gpu.devices.map((device) => ({ ...device, localPath: 'C:\\must-not-leak' }))
  }
})
assert.equal(sanitizedHardware.ok, true)
assert.equal('localPath' in (sanitizedHardware.value as unknown as Record<string, unknown>), false)
assert.equal('localPath' in (sanitizedHardware.value!.gpu.devices[0] as unknown as Record<string, unknown>), false)
assert.equal(
  validateHardwareSnapshot({ ...honestHardware, gpu: { status: 'unavailable', devices: honestHardware.gpu.devices, reason: 'not observed' } }).ok,
  false,
  'unavailable GPU telemetry cannot claim device metrics'
)

const primary = approveDevice(authority, 'Primary client v2', 60_000)
const secondary = approveDevice(authority, 'Secondary client', 70_000)
const discoverers = [new StaticRuntimeDiscovery('ollama', [fixtureAdapter])]
const service = new RemoteNodeService({
  nodeId: 'fixture-node',
  nodeName: 'Fixture Remote Node',
  pairingAuthority: authority,
  runtimeDiscoverers: discoverers,
  hardwareProvider: () => honestHardware,
  caps: { maxGenerationMs: 5_000, catalogCacheMs: 30_000 }
})

await expectProtocolError(service.handle(envelope('health', 'akrn_v1.invalid.invalid-secret', {}, 'auth-failure')), 'unauthorized')
await expectProtocolError(
  service.handle({ ...envelope('health', primary.token, {}, 'version-failure'), protocolVersion: 'akorith.remote-node.v0' }),
  'unsupported_version'
)

const healthResponse = await service.handle(envelope('health', primary.token, {}, 'health-ok'))
assert.equal(healthResponse.kind, 'health')
if (healthResponse.kind !== 'health') throw new Error('expected health response')
assert.equal(healthResponse.protocolVersion, REMOTE_NODE_PROTOCOL_VERSION)
assert.equal(healthResponse.health.hardware.gpu.status, 'observed')
assert.equal(healthResponse.health.hardware.gpu.devices[0]?.utilizationPercent, 42)
assert.equal(healthResponse.health.runtimeCount, 1)
assert.equal(healthResponse.health.modelCount, 1)
assert.deepEqual(healthResponse.health.safety, REMOTE_NODE_SAFETY_POLICY)
const replayProtectedRequest = envelope('health', primary.token, {}, 'authenticated-request-replay')
await service.handle(replayProtectedRequest)
await expectProtocolError(service.handle(replayProtectedRequest), 'request_replayed')

const catalogResponse = await service.handle(envelope('catalog', primary.token, { refresh: true }, 'catalog-ok'))
assert.equal(catalogResponse.kind, 'catalog')
if (catalogResponse.kind !== 'catalog') throw new Error('expected catalog response')
assert.equal(catalogResponse.catalog.models.length, 1, 'runtime models are enumerated')
assert.equal(catalogResponse.catalog.models[0]?.id, fixtureModel.id, 'runtime-native model ids may include slash and plus')
assert.equal(catalogResponse.catalog.runtimes[0]?.load?.utilizationPercent, 25)
assert.ok((catalogResponse.catalog.runtimes[0]?.latencyMs ?? -1) >= 0)
assert.deepEqual(
  new Set(RUNTIME_DISCOVERY_SEAMS.map((seam) => seam.kind)),
  new Set(['ollama', 'lm_studio', 'vllm', 'openai_compatible']),
  'all supported local runtime discovery seams are declared'
)

const clientModels = toClientRemoteModels(catalogResponse.catalog)
assert.equal(clientModels.length, 1)
assert.equal(clientModels[0]?.location, 'remote')
assert.match(clientModels[0]?.providerLabel ?? '', /^Remote/)
assert.ok((clientModels[0]?.runtimeLatencyMs ?? -1) >= 0)
assert.equal(clientModels[0]?.runtimeLoad?.utilizationPercent, 25)
assert.equal(clientModels[0]?.nodeLoad.maxConcurrentGenerations, 2)
assert.equal(clientModels[0]?.codeExecutorEligible, true)
assert.equal(clientModels[0]?.executionPolicy.codeToolsLocation, 'client')
assert.equal(clientModels[0]?.executionPolicy.nodeFilesystemAccess, false)
assert.equal(clientModels[0]?.executionPolicy.nodeCommandExecution, false)
assert.equal(clientModels[0]?.executionPolicy.nodeGitAccess, false)

const modelKey = catalogResponse.catalog.models[0]!.key
const generateBody = {
  modelKey,
  messages: [{ role: 'user', content: 'stream normally' }],
  maxOutputTokens: 64,
  safety: { ...REMOTE_NODE_SAFETY_POLICY }
}
const successful = await service.handle(envelope('generate', primary.token, generateBody, 'generate-ok'))
assert.equal(successful.kind, 'generation_stream')
if (successful.kind !== 'generation_stream') throw new Error('expected generation stream')
const successfulEvents: RemoteGenerationEvent[] = []
for await (const event of successful.stream) successfulEvents.push(event)
assert.deepEqual(
  successfulEvents.map((event) => event.type),
  ['started', 'delta', 'delta', 'usage', 'completed']
)
const successfulUsage = successfulEvents.find((event) => event.type === 'usage')
assert.deepEqual(successfulUsage, {
  type: 'usage',
  generationId: successful.generationId,
  promptTokens: 4,
  completionTokens: 2,
  cachedTokens: 1
})
assert.equal(lastAdapterRequest?.modelId, fixtureModel.id)
assert.equal('safety' in (lastAdapterRequest as unknown as Record<string, unknown>), false, 'adapter receives inference input, not node-side tools')

const forbiddenGeneration = { ...generateBody, workspacePath: 'C:\\should-not-reach-node' }
assert.equal(validateGenerationRequest(forbiddenGeneration).ok, false)
await expectProtocolError(service.handle(envelope('generate', primary.token, forbiddenGeneration, 'tools-forbidden')), 'invalid_request')

const cancellable = await service.handle(
  envelope(
    'generate',
    primary.token,
    { ...generateBody, messages: [{ role: 'user', content: 'cancel me after the first delta' }] },
    'generate-cancel'
  )
)
assert.equal(cancellable.kind, 'generation_stream')
if (cancellable.kind !== 'generation_stream') throw new Error('expected cancellable stream')
const iterator = cancellable.stream[Symbol.asyncIterator]()
assert.equal((await iterator.next()).value?.type, 'started')
assert.equal((await iterator.next()).value?.type, 'delta')
await expectProtocolError(
  service.handle(envelope('cancel', secondary.token, { generationId: cancellable.generationId }, 'cancel-foreign')),
  'generation_forbidden'
)
const cancellation = await service.handle(envelope('cancel', primary.token, { generationId: cancellable.generationId }, 'cancel-owner'))
assert.equal(cancellation.kind, 'cancel')
if (cancellation.kind !== 'cancel') throw new Error('expected cancel response')
assert.equal(cancellation.cancelled, true)
const eventsAfterCancel: RemoteGenerationEvent[] = []
for (;;) {
  const result = await iterator.next()
  if (result.done) break
  eventsAfterCancel.push(result.value)
}
assert.ok(eventsAfterCancel.some((event) => event.type === 'cancelled'))
assert.ok(!eventsAfterCancel.some((event) => event.type === 'completed'))
assert.equal(abortObserved, true, 'cancellation reaches the runtime AbortSignal')

// Invalid telemetry degrades to an explicit unavailable observation; metrics
// are never fabricated when the hardware provider cannot prove them.
const fallbackHardwareService = new RemoteNodeService({
  nodeId: 'hardware-fallback',
  nodeName: 'Hardware Fallback',
  pairingAuthority: authority,
  runtimeDiscoverers: [],
  hardwareProvider: () => ({ ...honestHardware, gpu: { status: 'unavailable', devices: [{ id: 'fake', name: 'fake' }], reason: 'bad data' } })
})
const fallbackHealth = await fallbackHardwareService.handle(envelope('health', primary.token, {}, 'hardware-fallback'))
assert.equal(fallbackHealth.kind, 'health')
if (fallbackHealth.kind !== 'health') throw new Error('expected fallback health')
assert.equal(fallbackHealth.health.hardware.gpu.status, 'unavailable')
assert.deepEqual(fallbackHealth.health.hardware.gpu.devices, [])
assert.match(fallbackHealth.health.hardware.gpu.reason, /unavailable|invalid/i)

// Body and per-device request caps are enforced before work is dispatched.
const sizeCappedService = new RemoteNodeService({
  nodeId: 'size-cap',
  nodeName: 'Size Cap',
  pairingAuthority: authority,
  runtimeDiscoverers: [],
  caps: { maxRequestBodyBytes: 1_024 }
})
await expectProtocolError(
  sizeCappedService.handle(envelope('catalog', primary.token, { padding: 'x'.repeat(2_000) }, 'oversized-body')),
  'request_too_large'
)

let rateNow = 90_000
const rateCappedService = new RemoteNodeService({
  nodeId: 'rate-cap',
  nodeName: 'Rate Cap',
  pairingAuthority: authority,
  runtimeDiscoverers: [],
  now: () => rateNow,
  caps: { maxRequestsPerWindow: 2, rateWindowMs: 10_000 }
})
await rateCappedService.handle(envelope('health', primary.token, {}, 'rate-1'))
await rateCappedService.handle(envelope('health', primary.token, {}, 'rate-2'))
await expectProtocolError(rateCappedService.handle(envelope('health', primary.token, {}, 'rate-3')), 'rate_limited')
rateNow += 10_001
await rateCappedService.handle(envelope('health', primary.token, {}, 'rate-window-reset'))

const _responseTypeCheck: RemoteNodeResponse = healthResponse
void _responseTypeCheck
console.log('Remote-node protocol verification passed.')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
