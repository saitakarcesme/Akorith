import type { RemoteNodeClientManager, RemoteNodeCatalog, RemoteGenerationEvent } from '../remote-node'
import { REMOTE_NODE_SAFETY_POLICY } from '../remote-node'
import type { StructuredExecutorClient, StructuredExecutorGeneration } from './executor'
import type { LoopExecutorSelection } from './types'

async function collect(stream: AsyncIterable<RemoteGenerationEvent>): Promise<StructuredExecutorGeneration> {
  let text = ''
  let input = 0
  let output = 0
  let cached = 0
  for await (const event of stream) {
    if (event.type === 'delta') text += event.text
    if (event.type === 'usage') {
      input = event.promptTokens ?? input
      output = event.completionTokens ?? output
      cached = event.cachedTokens ?? cached
    }
    if (event.type === 'error') throw new Error(`Remote generation failed: ${event.message}`)
    if (event.type === 'cancelled') {
      const error = new Error('Remote generation was cancelled.')
      error.name = 'AbortError'
      throw error
    }
  }
  return { text, usage: { input, output, cached, costUsd: 0 }, estimated: input === 0 && output === 0 }
}

function selectModel(catalog: RemoteNodeCatalog, selection: LoopExecutorSelection): RemoteNodeCatalog['models'][number] {
  const model = catalog.models.find((candidate) => candidate.id === selection.model || candidate.name === selection.model || candidate.key === selection.model)
  if (!model || !model.available) throw new Error('The selected remote model is no longer available on its node.')
  return model
}

/** Remote nodes perform inference only; structured patches are still validated and applied on the client workspace. */
export class RemoteStructuredExecutorClient implements StructuredExecutorClient {
  constructor(private readonly manager: RemoteNodeClientManager) {}

  async generate(
    selection: LoopExecutorSelection,
    prompt: string,
    signal?: AbortSignal,
    onToken?: (token: string) => void
  ): Promise<StructuredExecutorGeneration> {
    if (selection.location !== 'remote' || !selection.nodeId) throw new Error('Remote executor selection is missing its node identity.')
    const { catalog } = await this.manager.catalog(selection.nodeId)
    const model = selectModel(catalog, selection)
    const handle = await this.manager.client(selection.nodeId)
    const stream = handle.client.generate({
      modelKey: model.key,
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: 16_384,
      safety: { ...REMOTE_NODE_SAFETY_POLICY }
    }, signal)
    async function* observed(): AsyncIterable<RemoteGenerationEvent> {
      for await (const event of stream) {
        if (event.type === 'delta') onToken?.(event.text)
        yield event
      }
    }
    return collect(observed())
  }
}
