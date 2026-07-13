import { randomUUID } from 'crypto'
import { getDb } from '../db'
import type {
  ActionAgentRun,
  ActionAgentEvent,
  ActionAgentArtifact,
  AgentRunStatus,
  AgentEventKind,
  AgentArtifactKind,
  AgentRiskLevel
} from './types'

// Phase 52: agent run ledger + event log + artifacts.

type Row = Record<string, unknown>

function rowToRun(r: Row): ActionAgentRun {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    status: String(r.status) as AgentRunStatus,
    startedAt: Number(r.started_at) || 0,
    endedAt: r.ended_at == null ? undefined : Number(r.ended_at),
    input: typeof r.input === 'string' ? r.input : undefined,
    summary: typeof r.summary === 'string' ? r.summary : undefined,
    riskLevel: typeof r.risk_level === 'string' ? (r.risk_level as AgentRiskLevel) : undefined,
    filesChanged: Number(r.files_changed) || 0,
    commandsRun: Number(r.commands_run) || 0,
    error: typeof r.error === 'string' ? r.error : undefined
  }
}

export function startRun(agentId: string, input?: string): ActionAgentRun {
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO action_agent_runs (id, agent_id, status, started_at, input) VALUES (?, ?, ?, ?, ?)')
    .run(id, agentId, 'planning', Date.now(), input ?? null)
  return getRun(id)!
}

export function updateRun(id: string, patch: Partial<ActionAgentRun> & { status?: AgentRunStatus }): ActionAgentRun | null {
  const cur = getRun(id)
  if (!cur) return null
  getDb()
    .prepare(
      `UPDATE action_agent_runs SET status=?, ended_at=?, summary=?, risk_level=?, files_changed=?, commands_run=?, error=? WHERE id=?`
    )
    .run(
      patch.status ?? cur.status,
      patch.endedAt ?? cur.endedAt ?? null,
      patch.summary ?? cur.summary ?? null,
      patch.riskLevel ?? cur.riskLevel ?? null,
      patch.filesChanged ?? cur.filesChanged,
      patch.commandsRun ?? cur.commandsRun,
      patch.error ?? cur.error ?? null,
      id
    )
  return getRun(id)
}

export function getRun(id: string): ActionAgentRun | null {
  const row = getDb().prepare('SELECT * FROM action_agent_runs WHERE id = ?').get(id) as Row | undefined
  return row ? rowToRun(row) : null
}

export function listRuns(agentId: string, limit = 30): ActionAgentRun[] {
  const rows = getDb()
    .prepare('SELECT * FROM action_agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(agentId, limit) as Row[]
  return rows.map(rowToRun)
}

export function logAgentEvent(runId: string, agentId: string, kind: AgentEventKind, message: string, detail?: string): ActionAgentEvent {
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO action_agent_events (id, run_id, agent_id, kind, message, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, runId, agentId, kind, message.slice(0, 500), detail ?? null, Date.now())
  return { id, runId, agentId, kind, message, detail, createdAt: Date.now() }
}

export function listEvents(runId: string): ActionAgentEvent[] {
  const rows = getDb().prepare('SELECT * FROM action_agent_events WHERE run_id = ? ORDER BY created_at ASC').all(runId) as Row[]
  return rows.map((r) => ({
    id: String(r.id),
    runId: String(r.run_id),
    agentId: String(r.agent_id),
    kind: String(r.kind) as AgentEventKind,
    message: String(r.message),
    detail: typeof r.detail === 'string' ? r.detail : undefined,
    createdAt: Number(r.created_at) || 0
  }))
}

export function addArtifact(runId: string, agentId: string, kind: AgentArtifactKind, title: string, content: string): ActionAgentArtifact {
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO action_agent_artifacts (id, run_id, agent_id, kind, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, runId, agentId, kind, title.slice(0, 200), content.slice(0, 200_000), Date.now())
  return { id, runId, agentId, kind, title, content, createdAt: Date.now() }
}

export function listArtifacts(runId: string): ActionAgentArtifact[] {
  const rows = getDb().prepare('SELECT * FROM action_agent_artifacts WHERE run_id = ? ORDER BY created_at ASC').all(runId) as Row[]
  return rows.map((r) => ({
    id: String(r.id),
    runId: String(r.run_id),
    agentId: String(r.agent_id),
    kind: String(r.kind) as AgentArtifactKind,
    title: String(r.title),
    content: String(r.content),
    createdAt: Number(r.created_at) || 0
  }))
}
