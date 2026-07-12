import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  LOOP_EXECUTOR_MANDATORY_CAPABILITIES,
  ModelCatalogService,
  ModelCatalogStore,
  applyModelCatalogMigrations,
  evaluateLoopExecutorEligibility,
  providerRegistrySource,
  remoteNodeCatalogSnapshots,
  type CatalogModel,
  type ProbeCompletionInput,
  type ProbeModelTransport,
  type RegistryProviderSnapshot
} from '../src/main/model-catalog/index.ts'
import {
  REMOTE_NODE_PROTOCOL_VERSION,
  REMOTE_NODE_SAFETY_POLICY,
  type RemoteNodeCatalog
} from '../src/main/remote-node/index.ts'

async function main(): Promise<void> {
const database = new Database(':memory:')
applyModelCatalogMigrations(database)
const store = new ModelCatalogStore(database)
const tempRoot = await mkdtemp(join(tmpdir(), 'akorith-model-service-'))
let now = Date.UTC(2026, 6, 12, 12, 0, 0)
let nextId = 0
let discoveryCalls = 0

const declaredExecutor = Object.fromEntries(
  LOOP_EXECUTOR_MANDATORY_CAPABILITIES.map((capability) => [capability, true])
)

const providerModels = ['good-coder', 'failed-coder', 'cancel-coder', 'timeout-coder', 'unwired-coder']
const providerSource = providerRegistrySource(async () => {
  discoveryCalls += 1
  return [{
    id: 'local',
    label: 'Local runtime',
    kind: ['chat', 'executor'],
    available: { ok: true },
    models: [...providerModels]
  }]
})

const remoteCatalog: RemoteNodeCatalog = {
  schemaVersion: 1,
  generatedAt: now,
  node: {
    id: 'remote-fixture',
    name: 'Remote fixture',
    protocolVersion: REMOTE_NODE_PROTOCOL_VERSION
  },
  hardware: {
    observedAt: now,
    platform: 'linux',
    architecture: 'x64',
    cpu: { logicalCores: 8 },
    memory: {},
    gpu: { status: 'unavailable', devices: [], reason: 'Offline verifier has no GPU.' }
  },
  load: { activeGenerations: 0, queuedGenerations: 0, maxConcurrentGenerations: 1, utilizationPercent: 12 },
  runtimes: [{ id: 'ollama-main', kind: 'ollama', label: 'Ollama', available: true, latencyMs: 7 }],
  models: [{
    key: 'ollama-main:remote-good',
    runtimeId: 'ollama-main',
    runtimeKind: 'ollama',
    id: 'remote-good',
    name: 'Remote Good',
    available: true,
    contextLength: 32_768,
    requiredVramBytes: 8 * 1024 * 1024 * 1024,
    capabilities: {
      textGeneration: true,
      streaming: true,
      cancellation: true,
      toolUse: 'reported',
      codeEditing: 'reported',
      multiFileReasoning: 'reported',
      commandPlanning: 'reported'
    }
  }],
  safety: { ...REMOTE_NODE_SAFETY_POLICY },
  warnings: []
}

class SequenceTransport implements ProbeModelTransport {
  private turn = 0

  async complete(input: ProbeCompletionInput): Promise<string> {
    if (input.prompt.includes('reasoning capability check')) {
      input.onDelta('497|')
      input.onDelta('catalog-akorith')
      return '497|catalog-akorith'
    }
    const actions = [
      { action: 'read', path: 'src/math.mjs' },
      { action: 'read', path: 'src/format.mjs' },
      { action: 'read', path: 'test.mjs' },
      { action: 'run_tests' },
      {
        action: 'write',
        path: 'src/math.mjs',
        content: 'export function total(items) {\n  return items.reduce((sum, item) => sum + item, 0)\n}\n'
      },
      { action: 'write', path: 'probe-result.json', content: '{"probe":"passed"}\n' },
      { action: 'delete', path: 'obsolete.txt' },
      { action: 'run_tests' },
      { action: 'finish' }
    ]
    const text = JSON.stringify(actions[this.turn++] ?? { action: 'finish' })
    input.onDelta(text.slice(0, Math.max(1, Math.floor(text.length / 2))))
    input.onDelta(text.slice(Math.max(1, Math.floor(text.length / 2))))
    return text
  }
}

class FinishImmediatelyTransport implements ProbeModelTransport {
  async complete(input: ProbeCompletionInput): Promise<string> {
    input.onDelta('{"action":')
    input.onDelta('"finish"}')
    return '{"action":"finish"}'
  }
}

class WaitForCancellationTransport implements ProbeModelTransport {
  async complete(input: ProbeCompletionInput): Promise<string> {
    return await new Promise<string>((_resolve, reject) => {
      const rejectCancelled = (): void => reject(input.signal.reason ?? new Error('cancelled'))
      if (input.signal.aborted) rejectCancelled()
      else input.signal.addEventListener('abort', rejectCancelled, { once: true })
    })
  }
}

function modelByName(models: CatalogModel[], name: string): CatalogModel {
  const model = models.find((candidate) => candidate.modelName === name)
  assert.ok(model, `catalog should contain ${name}`)
  return model
}

const service = new ModelCatalogService({
  store,
  providers: async (signal): Promise<readonly RegistryProviderSnapshot[]> => {
    const snapshots = await providerSource(signal)
    return snapshots.map((snapshot) => ({ ...snapshot, capabilities: declaredExecutor }))
  },
  remoteNodes: async () => remoteNodeCatalogSnapshots([remoteCatalog]),
  resolveTransport: (model) => {
    if (model.modelName === 'good-coder' || model.modelName === 'remote-good') return new SequenceTransport()
    if (model.modelName === 'failed-coder') return new FinishImmediatelyTransport()
    if (model.modelName === 'cancel-coder' || model.modelName === 'timeout-coder') return new WaitForCancellationTransport()
    return null
  },
  now: () => now,
  createId: () => `probe-service-${++nextId}`,
  probeFreshForMs: 60_000,
  tempRoot
})

try {
  const initial = await service.discover()
  assert.equal(initial.warnings.length, 0)
  assert.equal(initial.catalog.models.length, 6)
  assert.equal(discoveryCalls, 1)
  const remote = modelByName(initial.catalog.models, 'remote-good')
  assert.equal(remote.source, 'remote')
  assert.equal(remote.nodeId, 'remote-fixture')
  assert.equal(remote.pingMs, 7)
  assert.equal(remote.vramRequirementMb, 8 * 1024)
  assert.equal(remote.effectiveCapabilities.file_edit.support, 'unknown', 'reported remote claims never imply verified editing')

  providerModels.push('newly-discovered')
  const refreshed = await service.discover()
  assert.ok(modelByName(refreshed.catalog.models, 'newly-discovered'))
  assert.equal(discoveryCalls, 2, 'every refresh asks the live registry again')

  const good = modelByName(refreshed.catalog.models, 'good-coder')
  const reasoning = await service.runProbe(good.id, 'reasoning')
  assert.equal(reasoning.status, 'succeeded')
  assert.equal(reasoning.capabilities.reasoning?.outcome, 'confirmed')
  assert.equal(reasoning.capabilities.streaming_status?.outcome, 'confirmed')

  const code = await service.runProbe(good.id, 'code_execution')
  assert.equal(code.status, 'succeeded')
  for (const capability of LOOP_EXECUTOR_MANDATORY_CAPABILITIES) {
    assert.equal(code.capabilities[capability]?.outcome, 'confirmed', `${capability} needs observed evidence`)
  }
  const eligibleDiscovery = await service.discover()
  const eligible = modelByName(eligibleDiscovery.catalog.models, 'good-coder')
  assert.equal(evaluateLoopExecutorEligibility(eligible, now).selectable, true)
  assert.equal(store.listProbes(good.id).some((probe) => probe.id === code.id), true, 'terminal record is persisted through ModelCatalogStore')
  assert.deepEqual(await readdir(tempRoot), [], 'successful probe fixture is removed')

  const failed = modelByName(eligibleDiscovery.catalog.models, 'failed-coder')
  const failedResult = await service.runProbe(failed.id, 'code_execution')
  assert.equal(failedResult.status, 'failed')
  assert.equal(failedResult.capabilities.file_edit?.outcome, 'rejected')
  const failedCatalog = await service.discover()
  assert.equal(evaluateLoopExecutorEligibility(modelByName(failedCatalog.catalog.models, 'failed-coder'), now).code, 'probe_failed')
  assert.deepEqual(await readdir(tempRoot), [], 'failed probe fixture is removed')

  const unwired = modelByName(failedCatalog.catalog.models, 'unwired-coder')
  const unavailable = await service.runProbe(unwired.id, 'code_execution')
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.failureCode, 'probe_transport_unavailable')

  const cancelModel = modelByName(failedCatalog.catalog.models, 'cancel-coder')
  const controller = new AbortController()
  const cancelledPromise = service.runProbe(cancelModel.id, 'reasoning', { signal: controller.signal })
  setTimeout(() => controller.abort(new Error('verifier cancellation')), 10)
  const cancelled = await cancelledPromise
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.failureCode, 'probe_cancelled')

  const timeoutModel = modelByName(failedCatalog.catalog.models, 'timeout-coder')
  const timedOut = await service.runProbe(timeoutModel.id, 'reasoning', { timeoutMs: 20 })
  assert.equal(timedOut.status, 'error')
  assert.equal(timedOut.failureCode, 'probe_timeout')

  now += 60_001
  const staleDiscovery = await service.discover()
  const staleGood = modelByName(staleDiscovery.catalog.models, 'good-coder')
  assert.equal(evaluateLoopExecutorEligibility(staleGood, now).code, 'probe_stale')

  const partialService = new ModelCatalogService({
    store,
    providers: async () => { throw new Error('registry unavailable') },
    remoteNodes: async () => remoteNodeCatalogSnapshots([remoteCatalog]),
    resolveTransport: () => null,
    now: () => now
  })
  const partial = await partialService.discover()
  assert.equal(partial.catalog.models.length, 1)
  assert.match(partial.warnings[0] ?? '', /Provider discovery failed/)
} finally {
  database.close()
  await rm(tempRoot, { recursive: true, force: true })
}

process.stdout.write('verify-model-catalog-service: ok\n')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
