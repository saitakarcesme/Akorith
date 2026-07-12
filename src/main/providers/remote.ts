import { estimateTokens } from './util'
import { getRemoteNodeClientManager, REMOTE_NODE_SAFETY_POLICY, type RemoteGenerationEvent, type RemoteNodeClientManager } from '../remote-node'
import type { Provider, ProviderAvailability, SendOptions, SendResult } from './types'

interface ResolvedRemoteModel {
  nodeId: string
  modelKey: string
  display: string
}

function wireModel(nodeId: string, modelKey: string): string {
  return `${nodeId}/${modelKey}`
}

export class RemoteNodeProvider implements Provider {
  readonly id = 'remote'
  readonly label = 'Remote — paired nodes'
  readonly kind: Provider['kind'] = ['chat', 'executor']

  constructor(private readonly manager: RemoteNodeClientManager = getRemoteNodeClientManager()) {}

  async isAvailable(): Promise<ProviderAvailability> {
    const nodes = await this.manager.list()
    if (nodes.length === 0) return { ok: false, reason: 'No authenticated remote nodes are paired.' }
    if (!nodes.some((node) => node.connection.phase === 'online' || node.connection.phase === 'idle')) {
      return { ok: false, reason: 'Paired remote nodes are currently offline.' }
    }
    return { ok: true }
  }

  async listModels(): Promise<string[]> {
    const models: string[] = []
    for (const node of await this.manager.list()) {
      try {
        const { catalog } = await this.manager.catalog(node.id)
        for (const model of catalog.models) if (model.available) models.push(wireModel(node.id, model.key))
      } catch {
        // One unavailable node must not hide healthy peers.
      }
    }
    return models.sort((left, right) => left.localeCompare(right))
  }

  private async resolve(value: string | undefined): Promise<ResolvedRemoteModel> {
    if (!value) throw new Error('Select a model from a paired remote node.')
    for (const node of await this.manager.list()) {
      try {
        const { catalog } = await this.manager.catalog(node.id)
        const model = catalog.models.find((candidate) => wireModel(node.id, candidate.key) === value)
        if (model?.available) return { nodeId: node.id, modelKey: model.key, display: value }
      } catch {
        // Continue resolving against other paired nodes.
      }
    }
    throw new Error('The selected remote model is no longer available.')
  }

  async send(prompt: string, options: SendOptions, onToken: (token: string) => void): Promise<SendResult> {
    const selected = await this.resolve(options.model)
    const handle = await this.manager.client(selected.nodeId)
    const stream = handle.client.generate({
      modelKey: selected.modelKey,
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: 16_384,
      safety: { ...REMOTE_NODE_SAFETY_POLICY }
    }, options.signal)
    let text = ''
    let promptTokens: number | undefined
    let completionTokens: number | undefined
    for await (const event of stream as AsyncIterable<RemoteGenerationEvent>) {
      if (event.type === 'delta') { text += event.text; onToken(event.text) }
      if (event.type === 'usage') {
        promptTokens = event.promptTokens
        completionTokens = event.completionTokens
      }
      if (event.type === 'error') throw new Error(`Remote generation failed: ${event.message}`)
      if (event.type === 'cancelled') {
        const error = new Error('Remote generation was cancelled.')
        error.name = 'AbortError'
        throw error
      }
    }
    return {
      text,
      model: selected.display,
      usage: {
        promptTokens: promptTokens ?? estimateTokens(prompt),
        completionTokens: completionTokens ?? estimateTokens(text),
        costUsd: 0,
        estimated: promptTokens === undefined || completionTokens === undefined
      }
    }
  }
}
