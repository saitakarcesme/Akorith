import { describe, expect, it, vi } from 'vitest'
import { RemoteNodeProvider } from '../../src/main/providers/remote'
import type { RemoteNodeClientManager } from '../../src/main/remote-node'

function manager(): RemoteNodeClientManager {
  return {
    list: vi.fn(async () => [{ id: 'rtx', connection: { phase: 'online' } }]),
    catalog: vi.fn(async () => ({
      catalog: { models: [{ key: 'ollama:qwen', id: 'qwen', name: 'Qwen Coder', available: true }] }
    })),
    client: vi.fn(async () => ({
      client: {
        generate: vi.fn(async function* () {
          yield { type: 'delta' as const, generationId: 'g1', text: 'Hello ', index: 0 }
          yield { type: 'delta' as const, generationId: 'g1', text: 'remote', index: 1 }
          yield { type: 'usage' as const, generationId: 'g1', promptTokens: 8, completionTokens: 2 }
          yield { type: 'completed' as const, generationId: 'g1', at: 2 }
        })
      }
    }))
  } as unknown as RemoteNodeClientManager
}

describe('RemoteNodeProvider', () => {
  it('discovers and streams models through paired nodes', async () => {
    const provider = new RemoteNodeProvider(manager())
    expect(await provider.isAvailable()).toEqual({ ok: true })
    expect(await provider.listModels()).toEqual(['rtx/ollama:qwen'])
    const deltas: string[] = []
    const result = await provider.send('Hello', { model: 'rtx/ollama:qwen' }, (delta) => deltas.push(delta))
    expect(result.text).toBe('Hello remote')
    expect(result.usage).toEqual({ promptTokens: 8, completionTokens: 2, costUsd: 0, estimated: false })
    expect(deltas).toEqual(['Hello ', 'remote'])
  })

  it('reports an honest unavailable state with no pairings', async () => {
    const empty = { list: vi.fn(async () => []) } as unknown as RemoteNodeClientManager
    const provider = new RemoteNodeProvider(empty)
    expect(await provider.isAvailable()).toEqual({ ok: false, reason: 'No authenticated remote nodes are paired.' })
    await expect(provider.send('Hello', {}, vi.fn())).rejects.toThrow(/select a model/i)
  })
})
