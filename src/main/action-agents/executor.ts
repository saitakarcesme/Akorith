import { sendStructured } from '../local-runtime'
import { runLocalValidationCommands } from '../local-executor'
import { checkCommand } from '../safety'
import { inspectProject, renderProjectContext } from '../project-loop/context'
import { getAgent, recordAgentRun } from './store'
import { startRun, updateRun, logAgentEvent, addArtifact, listEvents, listArtifacts } from './runs'
import { planAgent } from './planner'
import { capabilitiesFor } from './permissions'
import { applyFileWrite, previewWrites } from './files'
import { templateById } from './templates'
import type { ActionAgentRun, AgentAction, AgentActionFile } from './types'

// Phase 52: the agent executor. Plans, then (per permission mode) previews or
// applies file writes contained to the allowed root and runs allowlisted
// commands. Every step is logged; nothing destructive ever runs silently.

function validateAction(v: unknown): AgentAction | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const summary = typeof o.summary === 'string' ? o.summary.slice(0, 400) : ''
  const files: AgentActionFile[] = Array.isArray(o.files)
    ? (o.files as unknown[]).slice(0, 40).flatMap((f) => {
        if (!f || typeof f !== 'object') return []
        const fo = f as Record<string, unknown>
        const op = fo.operation
        if (op !== 'create' && op !== 'modify' && op !== 'delete') return []
        if (typeof fo.path !== 'string') return []
        return [{ operation: op, path: fo.path, content: typeof fo.content === 'string' ? fo.content : undefined }]
      })
    : []
  const commands = Array.isArray(o.commands)
    ? (o.commands as unknown[]).slice(0, 8).flatMap((c) => {
        if (!c || typeof c !== 'object') return []
        const co = c as Record<string, unknown>
        if (typeof co.cmd !== 'string') return []
        return [{ cmd: co.cmd, reason: typeof co.reason === 'string' ? co.reason : '' }]
      })
    : []
  const artifacts = Array.isArray(o.artifacts)
    ? (o.artifacts as unknown[]).slice(0, 8).flatMap((a) => {
        if (!a || typeof a !== 'object') return []
        const ao = a as Record<string, unknown>
        if (typeof ao.title !== 'string' || typeof ao.content !== 'string') return []
        const kind = ['report', 'file', 'checklist', 'summary', 'plan'].includes(ao.kind as string) ? (ao.kind as AgentAction['artifacts'][number]['kind']) : 'report'
        return [{ title: ao.title, kind, content: ao.content }]
      })
    : []
  return { type: 'agent_action', summary, files, commands, artifacts }
}

export interface AgentRunResult {
  ok: boolean
  run: ActionAgentRun | null
  events: ReturnType<typeof listEvents>
  artifacts: ReturnType<typeof listArtifacts>
  previewOnly: boolean
  error?: string
}

export async function runAgent(agentId: string, input?: string, signal?: AbortSignal): Promise<AgentRunResult> {
  const agent = getAgent(agentId)
  if (!agent) return { ok: false, run: null, events: [], artifacts: [], previewOnly: false, error: 'agent not found' }

  const run = startRun(agentId, input)
  recordAgentRun(agentId)
  const caps = capabilitiesFor(agent.permissionMode, agent.allowCommands)

  try {
    // 1) Plan (preview).
    const planned = await planAgent(agent, input)
    if (!planned.ok || !planned.plan) {
      logAgentEvent(run.id, agentId, 'failed', 'Planning failed', planned.error)
      const r = updateRun(run.id, { status: 'failed', endedAt: Date.now(), error: planned.error })
      return { ok: false, run: r, events: listEvents(run.id), artifacts: [], previewOnly: false, error: planned.error }
    }
    logAgentEvent(run.id, agentId, 'plan_generated', planned.plan.summary, JSON.stringify(planned.plan.steps))
    addArtifact(run.id, agentId, 'plan', 'Plan', `${planned.plan.summary}\n\n${planned.plan.steps.map((s) => `- (${s.kind}) ${s.title} — ${s.reason}`).join('\n')}`)
    updateRun(run.id, { riskLevel: planned.plan.riskLevel, summary: planned.plan.summary, status: caps.canWriteFiles ? 'running' : 'completed' })

    // 2) Preview-only agents stop here.
    if (!caps.canWriteFiles && !caps.canRunCommands) {
      logAgentEvent(run.id, agentId, 'completed', 'Preview complete (no changes made — preview permission).')
      const r = updateRun(run.id, { status: 'completed', endedAt: Date.now() })
      return { ok: true, run: r, events: listEvents(run.id), artifacts: listArtifacts(run.id), previewOnly: true }
    }

    // 3) Ask for the concrete action.
    const tpl = templateById(agent.templateId)
    const context = agent.allowedRoot ? renderProjectContext(inspectProject(agent.allowedRoot)) : '(no folder)'
    const actionPrompt = `You are ${agent.name}. Produce the concrete action for this task as JSON.

Task: ${tpl?.goal ?? agent.description}
${input ? `User input: ${input}\n` : ''}Working folder (all paths are relative to it): ${agent.allowedRoot ?? '(none)'}
Folder context:
${context}

Return:
{"type":"agent_action","summary":"...","files":[{"operation":"create|modify","path":"relative/path","content":"..."}],"commands":[{"cmd":"npm run typecheck","reason":"..."}],"artifacts":[{"title":"...","kind":"report","content":"..."}]}
Rules: relative paths only, never delete, never touch secrets/.env/.git/node_modules, prefer producing a report artifact when unsure.`
    const actionRes = await sendStructured<AgentAction>(actionPrompt, { model: agent.localModel, validate: validateAction, signal })
    if (!actionRes.ok || !actionRes.value) {
      logAgentEvent(run.id, agentId, 'failed', 'Action generation failed', actionRes.error)
      const r = updateRun(run.id, { status: 'failed', endedAt: Date.now(), error: actionRes.error })
      return { ok: false, run: r, events: listEvents(run.id), artifacts: listArtifacts(run.id), previewOnly: false, error: actionRes.error }
    }
    const action = actionRes.value

    // 4) Artifacts always saved (they're just text output).
    for (const a of action.artifacts) addArtifact(run.id, agentId, a.kind, a.title, a.content)

    // 5) Files: preview or apply within the root.
    let filesChanged = 0
    if (agent.allowedRoot && action.files.length) {
      if (caps.canWriteFiles && !caps.requiresStepApproval) {
        for (const f of action.files) {
          const res = applyFileWrite(agent.allowedRoot, f)
          logAgentEvent(run.id, agentId, res.ok ? 'file_written' : 'permission_requested', `${res.operation} ${res.path}`, res.reason)
          if (res.ok) filesChanged++
        }
      } else {
        for (const p of previewWrites(agent.allowedRoot, action.files)) {
          logAgentEvent(run.id, agentId, 'permission_requested', `Would ${p.operation} ${p.path}`, p.reason)
        }
      }
    }

    // 6) Commands: only allowlisted + only when the mode permits.
    let commandsRun = 0
    if (caps.canRunCommands && agent.allowedRoot && action.commands.length) {
      const safe = action.commands.filter((c) => checkCommand(c.cmd).ok)
      const results = await runLocalValidationCommands(agent.allowedRoot, safe, 120_000, signal)
      for (const r of results) {
        logAgentEvent(run.id, agentId, 'command_run', r.cmd, r.passed ? 'passed' : `exit ${r.exitCode}`)
        commandsRun++
      }
      for (const c of action.commands.filter((c) => !checkCommand(c.cmd).ok)) {
        logAgentEvent(run.id, agentId, 'permission_requested', `Command blocked: ${c.cmd}`, 'not on the validation allowlist')
      }
    }

    logAgentEvent(run.id, agentId, 'completed', action.summary || 'Agent run complete')
    const finished = updateRun(run.id, { status: 'completed', endedAt: Date.now(), summary: action.summary, filesChanged, commandsRun })
    return { ok: true, run: finished, events: listEvents(run.id), artifacts: listArtifacts(run.id), previewOnly: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logAgentEvent(run.id, agentId, 'failed', 'Run errored', message)
    const r = updateRun(run.id, { status: 'failed', endedAt: Date.now(), error: message })
    return { ok: false, run: r, events: listEvents(run.id), artifacts: listArtifacts(run.id), previewOnly: false, error: message }
  }
}
