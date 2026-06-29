import { ipcMain } from 'electron'
import { ptyManager, type PtySessionSnapshot } from '../pty'
import { claudeAgentAdapter } from './adapters/claude'
import { codexAgentAdapter } from './adapters/codex'
import { memoryAgentAdapter } from './adapters/memory'
import { ollamaAgentAdapter } from './adapters/ollama'
import { opencodeAgentAdapter } from './adapters/opencode'
import { PLACEHOLDER_RUNTIME_CAPABILITY } from './runtime'
import { agentSessionManager } from './session-manager'
import {
  safeRuntimeError,
  type AgentRuntimeAttachment,
  type AgentRuntimeSnapshot
} from './observation'
import {
  isAgentSessionMode,
  isAgentSessionOrigin,
  type AgentSession,
  type AgentSessionCreateInput
} from './session'
import {
  isAgentId,
  type AgentAdapter,
  type AgentAdapterInfo,
  type AgentDetectionResult,
  type AgentId,
  type AgentIntegrationStage
} from './types'
import type { AgentSessionEvent } from './events'

const ADAPTERS: readonly AgentAdapter[] = [
  claudeAgentAdapter,
  codexAgentAdapter,
  ollamaAgentAdapter,
  opencodeAgentAdapter,
  memoryAgentAdapter
]

const ADAPTER_BY_ID = new Map<AgentId, AgentAdapter>(ADAPTERS.map((adapter) => [adapter.metadata.id, adapter]))

function integrationStage(adapter: AgentAdapter): AgentIntegrationStage {
  if (adapter.metadata.id === 'claude' || adapter.metadata.id === 'codex' || adapter.metadata.id === 'ollama') {
    return 'runtime-connected-existing-provider'
  }
  if (adapter.metadata.id === 'memory') return 'session-placeholder-ready'
  if (adapter.metadata.id === 'opencode') return 'detection-ready'
  return 'metadata-only'
}

export function listAgentAdapters(): AgentAdapterInfo[] {
  return ADAPTERS.map((adapter) => ({
    ...adapter.metadata,
    capabilities: [...adapter.metadata.capabilities],
    currentIntegrationNotes: [...adapter.metadata.currentIntegrationNotes],
    futureIntegrationNotes: [...adapter.metadata.futureIntegrationNotes],
    safetyNotes: [...adapter.metadata.safetyNotes],
    runtimeCapabilities: adapter.getRuntimeCapabilities?.() ?? PLACEHOLDER_RUNTIME_CAPABILITY,
    integrationStage: integrationStage(adapter)
  }))
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

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, max)
  return trimmed && !/[\0\r\n]/.test(trimmed) ? trimmed : undefined
}

function cleanMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const json = JSON.stringify(value)
    if (json.length > 4000) return undefined
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function parseCreatePlaceholderPayload(args: {
  agentId?: unknown
  mode?: unknown
  origin?: unknown
  projectPath?: unknown
  title?: unknown
  metadata?: unknown
}): AgentSessionCreateInput | null {
  if (!isAgentId(args?.agentId) || !isAgentSessionMode(args.mode) || !isAgentSessionOrigin(args.origin)) return null
  return {
    agentId: args.agentId,
    mode: args.mode,
    origin: args.origin,
    projectPath: cleanText(args.projectPath, 2000),
    title: cleanText(args.title, 200),
    metadata: cleanMetadata(args.metadata)
  }
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{1,80}$/.test(value)
}

function ptyAttachmentTitle(snapshot: PtySessionSnapshot): string {
  const terminal =
    snapshot.logicalId === 't2'
      ? 'Olympus'
      : snapshot.logicalId === 't3'
        ? 'Gaia'
        : snapshot.logicalId === 't1'
          ? 'Atlantis'
          : snapshot.logicalId
  const role =
    snapshot.agentId === 'codex'
      ? 'Codex'
      : snapshot.agentId === 'claude'
        ? 'Claude'
        : snapshot.agentId === 'opencode'
          ? 'OpenCode'
          : 'Shell'
  return `${terminal} ${role}`
}

function ptyAttachment(snapshot: PtySessionSnapshot): AgentRuntimeAttachment {
  return {
    id: `pty:${snapshot.id}`,
    kind: 'pty_session',
    agentId: snapshot.agentId,
    externalId: snapshot.id,
    status: snapshot.agentId ? 'active' : 'observed',
    sourceFile: 'src/main/pty.ts',
    projectPath: snapshot.cwd,
    title: ptyAttachmentTitle(snapshot),
    startedAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    lastActivityAt: snapshot.lastActivityAt,
    metadata: {
      terminalId: snapshot.id,
      logicalId: snapshot.logicalId,
      projectKey: snapshot.projectKey,
      commandKind: snapshot.started,
      requestedKind: snapshot.requestedKind,
      alive: snapshot.alive
    }
  }
}

function ptyRuntimeAttachments(): AgentRuntimeAttachment[] {
  return ptyManager.listSessionSnapshots().map(ptyAttachment)
}

async function ollamaRuntimeAttachment(): Promise<AgentRuntimeAttachment> {
  try {
    const detection = await detectAgent('ollama')
    return {
      id: 'ollama:connection',
      kind: 'ollama_connection',
      agentId: 'ollama',
      status:
        detection.status === 'available'
          ? 'observed'
          : detection.status === 'unknown'
            ? 'unknown'
            : 'failed',
      sourceFile: 'src/main/agents/adapters/ollama.ts',
      title: 'Ollama local runtime',
      updatedAt: detection.checkedAt,
      lastActivityAt: detection.checkedAt,
      metadata: {
        detectionStatus: detection.status,
        version: detection.version ?? null
      },
      error: detection.status === 'available' ? undefined : detection.message
    }
  } catch (err) {
    return {
      id: 'ollama:connection',
      kind: 'ollama_connection',
      agentId: 'ollama',
      status: 'unknown',
      sourceFile: 'src/main/agents/adapters/ollama.ts',
      title: 'Ollama local runtime',
      updatedAt: Date.now(),
      error: safeRuntimeError(err)
    }
  }
}

async function runtimeSnapshot(): Promise<AgentRuntimeSnapshot> {
  return agentSessionManager.getRuntimeSnapshot({
    activePtySessions: ptyRuntimeAttachments(),
    ollamaStatus: await ollamaRuntimeAttachment(),
    notes: ['Observation only: existing providers and terminals remain the active runtime.']
  })
}

export function registerAgentRegistryIpc(): void {
  ipcMain.handle('agent:list', (): AgentAdapterInfo[] => listAgentAdapters())
  ipcMain.handle('agent:detect', async (_event, args: { id?: unknown }): Promise<AgentDetectionResult> => {
    if (!isAgentId(args?.id)) throw new Error('invalid agent:detect payload')
    return detectAgent(args.id)
  })
  ipcMain.handle('agent:detectAll', async (): Promise<AgentDetectionResult[]> => detectAllAgents())
  ipcMain.handle('agent:listSessions', (): AgentSession[] => agentSessionManager.listSessions())
  ipcMain.handle('agent:getSession', (_event, args: { id?: unknown }): AgentSession | null => {
    if (!validSessionId(args?.id)) return null
    return agentSessionManager.getSession(args.id)
  })
  ipcMain.handle('agent:listSessionEvents', (_event, args: { sessionId?: unknown }): AgentSessionEvent[] => {
    if (!validSessionId(args?.sessionId)) return []
    return agentSessionManager.listSessionEvents(args.sessionId)
  })
  ipcMain.handle('agent:listRuntimeAttachments', (): AgentRuntimeAttachment[] => [
    ...agentSessionManager.listRuntimeAttachments(),
    ...ptyRuntimeAttachments()
  ])
  ipcMain.handle('agent:listRuntimeAttachmentsForSession', (_event, args: { sessionId?: unknown }): AgentRuntimeAttachment[] => {
    if (!validSessionId(args?.sessionId)) return []
    return agentSessionManager.listRuntimeAttachmentsForSession(args.sessionId)
  })
  ipcMain.handle('agent:getRuntimeSnapshot', async (): Promise<AgentRuntimeSnapshot> => runtimeSnapshot())
  ipcMain.handle('agent:refreshRuntimeSnapshot', async (): Promise<AgentRuntimeSnapshot> => runtimeSnapshot())
  ipcMain.handle('agent:createPlaceholderSession', (_event, args: unknown): AgentSession => {
    const input = parseCreatePlaceholderPayload(
      args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
    )
    if (!input) throw new Error('invalid agent:createPlaceholderSession payload')
    if (!getAgentAdapter(input.agentId)) throw new Error(`unknown agent adapter: ${input.agentId}`)
    return agentSessionManager.createPlaceholderSession(input)
  })
}
