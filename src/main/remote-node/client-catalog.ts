import {
  REMOTE_NODE_SAFETY_POLICY,
  type ClientRemoteModel,
  type RemoteNodeCatalog,
  type RemoteNodeSafetyPolicy
} from './types'

function clientModelId(nodeId: string, modelKey: string): string {
  return `remote:${nodeId}:${modelKey}`
}

function executionPolicy(): RemoteNodeSafetyPolicy {
  return { ...REMOTE_NODE_SAFETY_POLICY }
}

export function toClientRemoteModels(catalog: RemoteNodeCatalog): ClientRemoteModel[] {
  const runtimes = new Map(catalog.runtimes.map((runtime) => [runtime.id, runtime]))
  return catalog.models.map((model) => {
    const runtime = runtimes.get(model.runtimeId)
    const available = model.available && runtime?.available === true
    return {
      id: clientModelId(catalog.node.id, model.key),
      providerId: `remote:${catalog.node.id}:${model.runtimeKind}`,
      providerLabel: `Remote — ${catalog.node.name}`,
      nodeId: catalog.node.id,
      nodeName: catalog.node.name,
      runtimeId: model.runtimeId,
      runtimeKind: model.runtimeKind,
      modelId: model.id,
      modelName: model.name,
      location: 'remote',
      available,
      ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
      ...(model.quantization ? { quantization: model.quantization } : {}),
      ...(model.requiredVramBytes !== undefined ? { requiredVramBytes: model.requiredVramBytes } : {}),
      ...(runtime?.latencyMs !== undefined ? { runtimeLatencyMs: runtime.latencyMs } : {}),
      ...(runtime?.load ? { runtimeLoad: { ...runtime.load } } : {}),
      nodeLoad: { ...catalog.load },
      capabilities: { ...model.capabilities },
      codeExecutorEligible:
        available &&
        model.capabilities.streaming &&
        model.capabilities.cancellation &&
        model.capabilities.codeEditing === 'verified' &&
        model.capabilities.multiFileReasoning === 'verified',
      executionPolicy: executionPolicy()
    }
  })
}
