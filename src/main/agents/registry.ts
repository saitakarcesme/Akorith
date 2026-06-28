import { ipcMain } from 'electron'
import { claudeAgentAdapter } from './adapters/claude'
import { codexAgentAdapter } from './adapters/codex'
import { memoryAgentAdapter } from './adapters/memory'
import { ollamaAgentAdapter } from './adapters/ollama'
import { opencodeAgentAdapter } from './adapters/opencode'
import { isAgentId, type AgentAdapter, type AgentAdapterMetadata, type AgentDetectionResult, type AgentId } from './types'

const ADAPTERS: readonly AgentAdapter[] = [
  claudeAgentAdapter,
  codexAgentAdapter,
  ollamaAgentAdapter,
  opencodeAgentAdapter,
  memoryAgentAdapter
]

const ADAPTER_BY_ID = new Map<AgentId, AgentAdapter>(ADAPTERS.map((adapter) => [adapter.metadata.id, adapter]))

export function listAgentAdapters(): AgentAdapterMetadata[] {
  return ADAPTERS.map((adapter) => ({ ...adapter.metadata, capabilities: [...adapter.metadata.capabilities] }))
}

export function getAgentAdapter(id: AgentId): AgentAdapter | null {
  return ADAPTER_BY_ID.get(id) ?? null
}

export async function detectAgent(id: AgentId): Promise<AgentDetectionResult> {
  const adapter = getAgentAdapter(id)
  if (!adapter) throw new Error(`unknown agent adapter: ${id}`)
  return adapter.detect()
}

export async function detectAllAgents(): Promise<AgentDetectionResult[]> {
  return Promise.all(ADAPTERS.map((adapter) => adapter.detect()))
}

export function registerAgentRegistryIpc(): void {
  ipcMain.handle('agent:list', (): AgentAdapterMetadata[] => listAgentAdapters())
  ipcMain.handle('agent:detect', async (_event, args: { id?: unknown }): Promise<AgentDetectionResult> => {
    if (!isAgentId(args?.id)) throw new Error('invalid agent:detect payload')
    return detectAgent(args.id)
  })
  ipcMain.handle('agent:detectAll', async (): Promise<AgentDetectionResult[]> => detectAllAgents())
}
