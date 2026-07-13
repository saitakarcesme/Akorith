import { randomUUID } from 'crypto'
import { getDb } from '../db'
import { templateById } from './templates'
import { DEFAULT_PERMISSION_MODE } from './permissions'
import type { ActionAgent, AgentPermissionMode } from './types'

// Phase 52: agent records + creation from templates.

type Row = Record<string, unknown>

export function rowToAgent(r: Row): ActionAgent {
  return {
    id: String(r.id),
    name: String(r.name),
    description: String(r.description ?? ''),
    icon: String(r.icon ?? 'bolt'),
    category: String(r.category ?? 'general'),
    templateId: String(r.template_id ?? 'blank'),
    localModelProvider: String(r.local_model_provider ?? 'local'),
    localModel: typeof r.local_model === 'string' && r.local_model ? r.local_model : undefined,
    allowedRoot: typeof r.allowed_root === 'string' && r.allowed_root ? r.allowed_root : undefined,
    permissionMode: String(r.permission_mode) as AgentPermissionMode,
    allowCommands: Number(r.allow_commands) === 1,
    builtin: Number(r.builtin) === 1,
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0,
    lastRunAt: r.last_run_at == null ? undefined : Number(r.last_run_at),
    runCount: Number(r.run_count) || 0
  }
}

export interface CreateAgentInput {
  name: string
  description?: string
  templateId?: string
  allowedRoot?: string
  permissionMode?: AgentPermissionMode
  allowCommands?: boolean
  localModel?: string
  icon?: string
  category?: string
}

export function createAgent(input: CreateAgentInput): ActionAgent {
  const tpl = input.templateId ? templateById(input.templateId) : undefined
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO action_agents (id, name, description, icon, category, template_id, local_model_provider, local_model, allowed_root, permission_mode, allow_commands, builtin, created_at, updated_at, run_count)
       VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, 0, ?, ?, 0)`
    )
    .run(
      id,
      input.name.slice(0, 120),
      input.description ?? tpl?.description ?? '',
      input.icon ?? tpl?.icon ?? 'bolt',
      input.category ?? tpl?.category ?? 'general',
      input.templateId ?? 'blank',
      input.localModel ?? null,
      input.allowedRoot ?? null,
      input.permissionMode ?? tpl?.defaultPermission ?? DEFAULT_PERMISSION_MODE,
      (input.allowCommands ?? tpl?.allowCommands ?? false) ? 1 : 0,
      now,
      now
    )
  return getAgent(id)!
}

export function getAgent(id: string): ActionAgent | null {
  const row = getDb().prepare('SELECT * FROM action_agents WHERE id = ?').get(id) as Row | undefined
  return row ? rowToAgent(row) : null
}

export function listAgents(): ActionAgent[] {
  const rows = getDb().prepare('SELECT * FROM action_agents ORDER BY updated_at DESC').all() as Row[]
  return rows.map(rowToAgent)
}

const UPDATABLE: Record<string, string> = {
  name: 'name',
  description: 'description',
  allowedRoot: 'allowed_root',
  permissionMode: 'permission_mode',
  allowCommands: 'allow_commands',
  localModel: 'local_model',
  icon: 'icon',
  category: 'category'
}

export function updateAgent(id: string, patch: Partial<ActionAgent>): ActionAgent | null {
  const sets: string[] = []
  const params: Record<string, unknown> = { id, updated_at: Date.now() }
  for (const [key, col] of Object.entries(UPDATABLE)) {
    if (!(key in patch)) continue
    let v = (patch as Record<string, unknown>)[key]
    if (key === 'allowCommands') v = v ? 1 : 0
    sets.push(`${col} = @${col}`)
    params[col] = v ?? null
  }
  if (sets.length === 0) return getAgent(id)
  getDb().prepare(`UPDATE action_agents SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params)
  return getAgent(id)
}

export function deleteAgent(id: string): void {
  getDb().prepare('DELETE FROM action_agents WHERE id = ?').run(id)
}

export function recordAgentRun(id: string): void {
  getDb().prepare('UPDATE action_agents SET run_count = run_count + 1, last_run_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), id)
}
