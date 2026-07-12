import type { ProviderInfo } from '../providers/types'
import type { RemoteNodeCatalog, RemoteRuntimeKind } from '../remote-node/types'
import type {
  CapabilityDeclaration,
  ModelProviderFamily,
  RegistryProviderSnapshot,
  RemoteNodeCatalogSnapshot,
  RemoteNodeModelSnapshot
} from './types'

export type ProviderCatalogSource = (signal: AbortSignal) => Promise<readonly RegistryProviderSnapshot[]>
export type RemoteCatalogSource = (signal: AbortSignal) => Promise<readonly RemoteNodeCatalogSnapshot[]>

/**
 * Adapts the live provider registry without importing its Electron-bound module.
 * The caller injects `describeProviders`, which keeps discovery testable and lets
 * the registry remain the single source of truth.
 */
export function providerRegistrySource(
  describeProviders: () => Promise<readonly ProviderInfo[]>
): ProviderCatalogSource {
  return async (signal) => {
    if (signal.aborted) throw signal.reason
    const providers = await describeProviders()
    if (signal.aborted) throw signal.reason
    return providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      available: provider.available,
      models: provider.models
    }))
  }
}

function runtimeFamily(kind: RemoteRuntimeKind): ModelProviderFamily {
  return kind === 'ollama' ? 'ollama' : 'openai_compatible'
}

function remoteDeclarations(model: RemoteNodeCatalog['models'][number]): CapabilityDeclaration {
  return {
    reasoning: 'unknown',
    tool_use: model.capabilities.toolUse === 'verified'
      ? true
      : model.capabilities.toolUse === 'reported'
        ? 'unknown'
        : 'unknown',
    file_edit: model.capabilities.codeEditing === 'verified' ? true : 'unknown',
    multi_file_reasoning: model.capabilities.multiFileReasoning === 'verified' ? true : 'unknown',
    command_execution: model.capabilities.commandPlanning === 'verified' ? true : 'unknown',
    streaming_status: model.capabilities.streaming
  }
}

/** Convert validated inference-node catalogs into the catalog's neutral snapshot. */
export function remoteNodeCatalogSnapshots(
  catalogs: readonly RemoteNodeCatalog[]
): RemoteNodeCatalogSnapshot[] {
  return catalogs.map((catalog) => {
    const runtimes = new Map(catalog.runtimes.map((runtime) => [runtime.id, runtime]))
    const models: RemoteNodeModelSnapshot[] = catalog.models.map((model) => {
      const runtime = runtimes.get(model.runtimeId)
      return {
        id: model.key,
        name: model.id,
        label: model.name,
        runtime: model.runtimeKind,
        providerId: `remote:${catalog.node.id}:${model.runtimeKind}`,
        providerLabel: `Remote — ${catalog.node.name}`,
        family: runtimeFamily(model.runtimeKind),
        available: {
          ok: model.available && runtime?.available === true,
          reason: model.unavailableReason ?? runtime?.reason,
          checkedAt: catalog.generatedAt
        },
        ...(model.contextLength !== undefined ? { contextWindowTokens: model.contextLength } : {}),
        ...(model.quantization ? { quantization: model.quantization } : {}),
        ...(model.requiredVramBytes !== undefined
          ? { vramRequirementMb: model.requiredVramBytes / (1024 * 1024) }
          : {}),
        ...(runtime?.latencyMs !== undefined ? { pingMs: runtime.latencyMs } : {}),
        capabilities: remoteDeclarations(model),
        metadata: {
          modelKey: model.key,
          runtimeId: model.runtimeId,
          runtimeKind: model.runtimeKind,
          inferenceOnly: catalog.safety.inferenceOnly
        }
      }
    })
    return {
      nodeId: catalog.node.id,
      nodeName: catalog.node.name,
      availability: {
        ok: true,
        checkedAt: catalog.generatedAt
      },
      ...(catalog.load.utilizationPercent !== undefined
        ? { currentLoadPercent: catalog.load.utilizationPercent }
        : {}),
      models
    }
  })
}

export function remoteNodeSource(
  discover: (signal: AbortSignal) => Promise<readonly RemoteNodeCatalog[]>
): RemoteCatalogSource {
  return async (signal) => remoteNodeCatalogSnapshots(await discover(signal))
}
