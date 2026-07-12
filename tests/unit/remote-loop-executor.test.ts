import { describe, expect, it, vi } from 'vitest'
import { RemoteStructuredExecutorClient } from '../../src/main/autonomous-loop/remote-executor-client'
import type { RemoteNodeClientManager } from '../../src/main/remote-node'

describe('RemoteStructuredExecutorClient', () => {
  it('streams authenticated inference while keeping tools on the client', async () => {
    const generate = vi.fn(async function* () {
      yield { type: 'started' as const, generationId: 'g1', modelKey: 'ollama:qwen', at: 1 }
      yield { type: 'delta' as const, generationId: 'g1', text: '{"patches":', index: 0 }
      yield { type: 'delta' as const, generationId: 'g1', text: '[]}', index: 1 }
      yield { type: 'usage' as const, generationId: 'g1', promptTokens: 12, completionTokens: 4, cachedTokens: 2 }
      yield { type: 'completed' as const, generationId: 'g1', at: 2 }
    })
    const manager = {
      catalog: vi.fn(async () => ({
        catalog: { models: [{ key: 'ollama:qwen', id: 'qwen', name: 'Qwen Coder', available: true }] }
      })),
      client: vi.fn(async () => ({ profile: {}, client: { generate } }))
    } as unknown as RemoteNodeClientManager
    const client = new RemoteStructuredExecutorClient(manager)
    const deltas: string[] = []
    const result = await client.generate({
      catalogId: 'remote-model', providerId: 'remote:rtx:ollama', model: 'qwen', location: 'remote', nodeId: 'rtx', capabilityProbeId: 'probe-1'
    }, 'return a structured patch', undefined, (delta) => deltas.push(delta))
    expect(result.text).toBe('{"patches":[]}')
    expect(result.usage).toEqual({ input: 12, output: 4, cached: 2, costUsd: 0 })
    expect(result.estimated).toBe(false)
    expect(deltas).toEqual(['{"patches":', '[]}'])
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      modelKey: 'ollama:qwen',
      safety: expect.objectContaining({ inferenceOnly: true, nodeFilesystemAccess: false, codeToolsLocation: 'client' })
    }), undefined)
  })

  it('rejects selections without a node identity', async () => {
    const client = new RemoteStructuredExecutorClient({} as RemoteNodeClientManager)
    await expect(client.generate({
      catalogId: 'remote-model', providerId: 'remote:rtx:ollama', model: 'qwen', location: 'remote', capabilityProbeId: 'probe-1'
    }, 'prompt')).rejects.toThrow(/node identity/i)
  })
})
