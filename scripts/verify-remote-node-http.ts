import assert from 'node:assert/strict'
import {
  PairingAuthority,
  REMOTE_NODE_SAFETY_POLICY,
  RemoteNodeHttpClient,
  RemoteNodeHttpServer,
  RemoteNodeService,
  StaticRuntimeDiscovery,
  type AdapterGenerationChunk,
  type RemoteRuntimeAdapter
} from '../src/main/remote-node/index.ts'

let assertions = 0
function equal<T>(actual: T, expected: T): void {
  assert.deepEqual(actual, expected)
  assertions += 1
}

async function main(): Promise<void> {
  const adapter: RemoteRuntimeAdapter = {
    id: 'ollama-http-fixture',
    kind: 'ollama',
    label: 'Ollama HTTP Fixture',
    async probe() { return { available: true } },
    async listModels() {
      return [{
        id: 'qwen-fixture',
        name: 'Qwen Fixture',
        contextLength: 32_768,
        capabilities: {
          textGeneration: true,
          streaming: true,
          cancellation: true,
          toolUse: 'reported',
          codeEditing: 'unknown',
          multiFileReasoning: 'reported',
          commandPlanning: 'reported'
        }
      }]
    },
    async *generate(): AsyncIterable<AdapterGenerationChunk> {
      yield { type: 'delta', text: 'hello' }
      yield { type: 'delta', text: ' remote' }
      yield { type: 'usage', promptTokens: 4, completionTokens: 2, cachedTokens: 0 }
    }
  }
  const authority = new PairingAuthority()
  let persisted = authority.exportState()
  const protocol = new RemoteNodeService({
    nodeId: 'http-fixture-node',
    nodeName: 'RTX Fixture',
    pairingAuthority: authority,
    runtimeDiscoverers: [new StaticRuntimeDiscovery('ollama', [adapter])]
  })
  const server = new RemoteNodeHttpServer({
    service: protocol,
    pairingAuthority: authority,
    host: '127.0.0.1',
    port: 0,
    persistAuthority: (state) => { persisted = state }
  })
  const address = await server.start()
  try {
    const challenge = authority.beginPairing({ nodeName: 'RTX Fixture' })
    const client = new RemoteNodeHttpClient({ baseUrl: address.url })
    const paired = await client.pair({
      pairingId: challenge.pairingId,
      code: challenge.code,
      deviceName: 'MacBook Air M1'
    })
    equal(paired.node.name, 'RTX Fixture')
    equal(persisted.devices.length, 1)
    assert.ok(!JSON.stringify(persisted).includes(paired.deviceToken)); assertions += 1

    const health = await client.health()
    equal(health.node.id, 'http-fixture-node')
    equal(health.modelCount, 1)
    equal(health.safety.nodeFilesystemAccess, false)

    const catalog = await client.catalog(true)
    equal(catalog.models.length, 1)
    equal(catalog.safety.codeToolsLocation, 'client')
    const events = []
    for await (const event of client.generate({
      modelKey: catalog.models[0].key,
      messages: [{ role: 'user', content: 'Say hello.' }],
      safety: { ...REMOTE_NODE_SAFETY_POLICY }
    })) events.push(event)
    equal(events.map((event) => event.type), ['started', 'delta', 'delta', 'usage', 'completed'])
    equal(events.filter((event) => event.type === 'delta').map((event) => event.text).join(''), 'hello remote')

    const unauthenticated = new RemoteNodeHttpClient({ baseUrl: address.url })
    await assert.rejects(unauthenticated.health(), /Pair with the remote node/); assertions += 1
    assert.throws(
      () => new RemoteNodeHttpClient({ baseUrl: 'https://203.0.113.10:47841' }),
      /explicit opt-in|not allowed|Public addresses/i
    ); assertions += 1
  } finally {
    await server.stop()
  }
  console.log(`verify-remote-node-http: ${assertions} assertions passed`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
