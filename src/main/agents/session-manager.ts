import { randomUUID } from 'crypto'
import type { AgentSessionEvent, AgentSessionEventInput } from './events'
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

export class AgentSessionManager {
  private readonly sessions = new Map<AgentSessionId, AgentSession>()
  private readonly events = new Map<AgentSessionId, AgentSessionEvent[]>()

  createPlaceholderSession(input: AgentSessionCreateInput): AgentSession {
    const now = Date.now()
    const session: AgentSession = {
      id: randomUUID(),
      agentId: input.agentId,
      mode: input.mode,
      origin: input.origin,
      status: 'created',
      projectPath: input.projectPath,
      title: input.title,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      metadata: {
        ...(input.metadata ?? {}),
        placeholder: true,
        runtime: 'phase-29-session-plumbing'
      }
    }
    this.sessions.set(session.id, session)
    this.appendSessionEvent({
      sessionId: session.id,
      agentId: session.agentId,
      type: 'created',
      message: 'Placeholder AgentSession created. No runtime process was started.',
      metadata: { mode: session.mode, origin: session.origin }
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
      metadata: patch.metadata ? { ...patch.metadata } : current.metadata
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

  listSessionEvents(sessionId: AgentSessionId): AgentSessionEvent[] {
    return (this.events.get(sessionId) ?? []).map(cloneEvent)
  }

  stopSession(id: AgentSessionId): AgentSession | null {
    const stopped = this.updateSessionStatus(id, 'stopped', { error: undefined })
    if (!stopped) return null
    this.appendSessionEvent({
      sessionId: id,
      agentId: stopped.agentId,
      type: 'stopped',
      message: 'Placeholder AgentSession stopped. No runtime process was killed.'
    })
    return stopped
  }
}

export const agentSessionManager = new AgentSessionManager()
