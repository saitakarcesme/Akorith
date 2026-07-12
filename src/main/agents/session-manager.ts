import { randomUUID } from 'crypto'
import type { AgentSessionEvent, AgentSessionEventInput } from './events'
import type {
  AgentRuntimeAttachment,
  AgentRuntimeAttachmentCreateInput,
  AgentRuntimeAttachmentPatch,
  AgentRuntimeSnapshot
} from './observation'
import type {
  AgentSession,
  AgentSessionCreateInput,
  AgentSessionId,
  AgentSessionPatch,
  AgentSessionStatus
} from './session'

const MAX_EVENTS = 500

function cloneSession(session: AgentSession): AgentSession {
  return {
    ...session,
    metadata: session.metadata ? { ...session.metadata } : undefined
  }
}

function cloneEvent(event: AgentSessionEvent): AgentSessionEvent {
  return {
    ...event,
    metadata: event.metadata ? { ...event.metadata } : undefined
  }
}

function cloneAttachment(attachment: AgentRuntimeAttachment): AgentRuntimeAttachment {
  return {
    ...attachment,
    metadata: attachment.metadata ? { ...attachment.metadata } : undefined
  }
}

export class AgentSessionManager {
  private readonly sessions = new Map<AgentSessionId, AgentSession>()
  private readonly events = new Map<AgentSessionId, AgentSessionEvent[]>()
  private readonly runtimeAttachments = new Map<string, AgentRuntimeAttachment>()

  createObservedSession(
    input: AgentSessionCreateInput & {
      status?: AgentSessionStatus
      lastActivityAt?: number
      error?: string
    }
  ): AgentSession {
    const now = Date.now()
    const session: AgentSession = {
      id: randomUUID(),
      agentId: input.agentId,
      mode: input.mode,
      origin: input.origin,
      status: input.status ?? 'running',
      projectPath: input.projectPath,
      title: input.title,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: input.lastActivityAt ?? now,
      metadata: {
        ...(input.metadata ?? {}),
        observed: true,
        runtime: 'phase-30-runtime-observation'
      },
      error: input.error
    }
    this.sessions.set(session.id, session)
    this.appendSessionEvent({
      sessionId: session.id,
      agentId: session.agentId,
      type: 'created',
      message: 'Observed AgentSession created from existing runtime activity.',
      metadata: { mode: session.mode, origin: session.origin, status: session.status }
    })
    return cloneSession(session)
  }

  listSessions(): AgentSession[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(cloneSession)
  }

  getSession(id: AgentSessionId): AgentSession | null {
    const session = this.sessions.get(id)
    return session ? cloneSession(session) : null
  }

  updateSessionStatus(id: AgentSessionId, status: AgentSessionStatus, patch: AgentSessionPatch = {}): AgentSession | null {
    const current = this.sessions.get(id)
    if (!current) return null
    const now = Date.now()
    const next: AgentSession = {
      ...current,
      ...patch,
      status,
      updatedAt: now,
      lastActivityAt: patch.lastActivityAt ?? now,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata
    }
    this.sessions.set(id, next)
    this.appendSessionEvent({
      sessionId: id,
      agentId: next.agentId,
      type: 'status_changed',
      message: `Session status changed to ${status}.`,
      metadata: { status }
    })
    return cloneSession(next)
  }

  appendSessionEvent(input: AgentSessionEventInput): AgentSessionEvent {
    const event: AgentSessionEvent = {
      id: randomUUID(),
      sessionId: input.sessionId,
      agentId: input.agentId,
      type: input.type,
      message: input.message,
      timestamp: Date.now(),
      metadata: input.metadata ? { ...input.metadata } : undefined
    }
    const list = this.events.get(input.sessionId) ?? []
    list.push(event)
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS)
    this.events.set(input.sessionId, list)
    return cloneEvent(event)
  }

  attachRuntime(sessionId: AgentSessionId, input: AgentRuntimeAttachmentCreateInput): AgentRuntimeAttachment | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const now = Date.now()
    const attachment: AgentRuntimeAttachment = {
      id: randomUUID(),
      sessionId,
      kind: input.kind,
      agentId: input.agentId ?? session.agentId,
      externalId: input.externalId,
      status: input.status,
      sourceFile: input.sourceFile,
      projectPath: input.projectPath,
      title: input.title,
      startedAt: input.startedAt ?? now,
      updatedAt: now,
      lastActivityAt: input.lastActivityAt ?? now,
      metadata: input.metadata ? { ...input.metadata } : undefined,
      error: input.error
    }
    this.runtimeAttachments.set(attachment.id, attachment)
    this.appendSessionEvent({
      sessionId,
      agentId: attachment.agentId ?? session.agentId,
      type: 'snapshot',
      message: `Observed ${attachment.kind}.`,
      metadata: { attachmentId: attachment.id, status: attachment.status }
    })
    return cloneAttachment(attachment)
  }

  updateRuntimeAttachment(id: string, patch: AgentRuntimeAttachmentPatch): AgentRuntimeAttachment | null {
    const current = this.runtimeAttachments.get(id)
    if (!current) return null
    const now = Date.now()
    const next: AgentRuntimeAttachment = {
      ...current,
      ...patch,
      updatedAt: now,
      lastActivityAt: patch.lastActivityAt ?? now,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata
    }
    this.runtimeAttachments.set(id, next)
    if (next.sessionId) {
      const session = this.sessions.get(next.sessionId)
      const agentId = next.agentId ?? current.agentId ?? session?.agentId
      if (!agentId) return cloneAttachment(next)
      this.appendSessionEvent({
        sessionId: next.sessionId,
        agentId,
        type: next.status === 'failed' ? 'error' : 'snapshot',
        message: `Runtime attachment ${next.kind} is ${next.status}.`,
        metadata: { attachmentId: next.id, status: next.status }
      })
    }
    return cloneAttachment(next)
  }

  listRuntimeAttachments(): AgentRuntimeAttachment[] {
    return [...this.runtimeAttachments.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(cloneAttachment)
  }

  listRuntimeAttachmentsForSession(sessionId: AgentSessionId): AgentRuntimeAttachment[] {
    return this.listRuntimeAttachments().filter((attachment) => attachment.sessionId === sessionId)
  }

  getRuntimeSnapshot(input: {
    activePtySessions?: AgentRuntimeAttachment[]
    ollamaStatus?: AgentRuntimeAttachment
    notes?: string[]
  } = {}): AgentRuntimeSnapshot {
    const attachments = this.listRuntimeAttachments()
    const activeProviderCalls = attachments.filter(
      (attachment) =>
        attachment.kind === 'provider_call' &&
        (attachment.status === 'active' || attachment.status === 'busy')
    )
    return {
      checkedAt: Date.now(),
      activeProviderCalls,
      activePtySessions: input.activePtySessions ?? [],
      ollamaStatus: input.ollamaStatus,
      observedSessions: this.listSessions().filter((session) => session.metadata?.observed === true),
      notes: input.notes
    }
  }

  markObservedSessionCompleted(sessionId: AgentSessionId, patch: AgentSessionPatch = {}): AgentSession | null {
    return this.updateSessionStatus(sessionId, 'completed', patch)
  }

  markObservedSessionFailed(sessionId: AgentSessionId, error: string): AgentSession | null {
    return this.updateSessionStatus(sessionId, 'failed', { error })
  }

  listSessionEvents(sessionId: AgentSessionId): AgentSessionEvent[] {
    return (this.events.get(sessionId) ?? []).map(cloneEvent)
  }

}

export const agentSessionManager = new AgentSessionManager()
