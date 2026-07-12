import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  LOOP_EXECUTOR_MANDATORY_CAPABILITIES,
  MODEL_CAPABILITIES,
  ModelCatalogStore,
  applyModelCatalogMigrations,
  buildModelCatalog,
  stableCatalogModelId,
  type ModelCapabilityProbeRecord
} from '../src/main/model-catalog/index.ts'

const database = new Database(':memory:')
assert.equal(applyModelCatalogMigrations(database), true)
assert.equal(applyModelCatalogMigrations(database), false)
const store = new ModelCatalogStore(database)
const now = Date.now()
const modelId = stableCatalogModelId({ source: 'local', providerId: 'local', nodeId: 'this-device', modelId: 'fixture-coder' })
const probe: ModelCapabilityProbeRecord = {
  schemaVersion: 1,
  id: 'probe-store-1',
  catalogModelId: modelId,
  probeKind: 'code_execution',
  probeVersion: '1',
  status: 'succeeded',
  startedAt: now - 100,
  completedAt: now,
  freshUntil: now + 86_400_000,
  providerId: 'local',
  modelName: 'fixture-coder',
  source: 'local',
  nodeId: 'this-device',
  capabilities: Object.fromEntries(MODEL_CAPABILITIES.map((capability) => [capability, {
    outcome: 'confirmed', summary: `confirmed ${capability}`
  }]))
}
store.saveProbe(probe)
store.saveProbe({
  ...probe,
  id: 'probe-store-reasoning-1',
  probeKind: 'reasoning',
  capabilities: { reasoning: { outcome: 'confirmed', summary: 'confirmed reasoning' } }
})
assert.equal(store.listProbes(modelId).some((item) => item.id === probe.id), true)
assert.throws(() => store.saveProbe({ ...probe, id: 'invalid\nprobe' }))

const catalog = buildModelCatalog({
  generatedAt: now,
  providers: [{
    providerId: 'local',
    providerLabel: 'Local',
    family: 'ollama',
    source: 'local',
    nodeId: 'this-device',
    nodeName: 'This device',
    availability: { ok: true, checkedAt: now },
    capabilities: Object.fromEntries(LOOP_EXECUTOR_MANDATORY_CAPABILITIES.map((capability) => [capability, true])),
    models: [{ name: 'fixture-coder', capabilities: { reasoning: true } }]
  }],
  probes: store.listProbes(),
  remoteNodes: []
})
assert.equal(catalog.models[0]?.id, modelId)
store.saveRoutingProfile({
  schemaVersion: 1,
  id: 'profile-1',
  name: 'Fixture route',
  plannerModelId: modelId,
  loopExecutorModelId: modelId,
  fallbackLoopExecutorModelIds: [],
  createdAt: now,
  updatedAt: now
}, catalog, now)
assert.equal(store.listRoutingProfiles()[0]?.id, 'profile-1')

database.close()
process.stdout.write('verify-model-catalog-store: ok\n')
