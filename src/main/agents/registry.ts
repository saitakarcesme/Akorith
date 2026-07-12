import { ipcMain } from 'electron'
import { ptyManager, type PtySessionSnapshot } from '../pty'
import { ollamaAgentAdapter } from './adapters/ollama'
import { agentSessionManager } from './session-manager'
import {
  safeRuntimeError,
  type AgentRuntimeAttachment,
  type AgentRuntimeSnapshot
} from './observation'

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
    const detection = await ollamaAgentAdapter.detect()
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

export function registerRuntimeObservationIpc(): void {
  ipcMain.handle('agent:getRuntimeSnapshot', async (): Promise<AgentRuntimeSnapshot> => runtimeSnapshot())
}
