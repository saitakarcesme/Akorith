import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ActionAgent,
  ActionAgentArtifact,
  ActionAgentEvent,
  ActionAgentRun,
  AgentPermissionMode,
  AgentRunResult,
  AgentTemplateInfo,
  CreateActionAgentInput,
  LocalModelInfo,
  RuntimeStatus
} from '../../../preload/index.d'
import {
  CommandModal,
  FieldLabel,
  FormGrid,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PrimaryButton,
  SecondaryButton,
  DangerButton
} from './CreationPrimitives'

// Phase 53: Agents — reusable local action shortcuts. Act with Agents. Create a
// shortcut once, run it again with one click, behind a permission policy.

export default function AgentsPage({ active }: { active: boolean }): JSX.Element {
  const [agents, setAgents] = useState<ActionAgent[]>([])
  const [templates, setTemplates] = useState<AgentTemplateInfo[]>([])
  const [models, setModels] = useState<LocalModelInfo[]>([])
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState<AgentTemplateInfo | 'blank' | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [runResult, setRunResult] = useState<AgentRunResult | null>(null)
  const [runs, setRuns] = useState<ActionAgentRun[]>([])
  const [createdNotice, setCreatedNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setAgents((await window.api.actionAgent.list()) as ActionAgent[])
    setTemplates((await window.api.actionAgent.templates()) as AgentTemplateInfo[])
  }, [])

  useEffect(() => {
    if (!active) return
    void load()
    void window.api.localRuntime.status().then((s) => setRuntime(s as RuntimeStatus)).catch(() => setRuntime(null))
    void window.api.localRuntime.listModels().then((m) => setModels(m as LocalModelInfo[])).catch(() => setModels([]))
  }, [active, load])

  const selected = useMemo(() => agents.find((a) => a.id === selectedId) ?? null, [agents, selectedId])

  useEffect(() => {
    if (selectedId) void window.api.actionAgent.listRuns(selectedId).then((r) => setRuns(r as ActionAgentRun[]))
    setRunResult(null)
  }, [selectedId])

  const runAgent = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setRunResult(null)
    try {
      const res = (await window.api.actionAgent.run(selected.id, input.trim() || undefined)) as AgentRunResult
      setRunResult(res)
      setRuns((await window.api.actionAgent.listRuns(selected.id)) as ActionAgentRun[])
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="agents-page">
      <header className="agents-header">
        <div>
          <h1>Agents</h1>
          <p>Reusable local action shortcuts. Create once, run again with one click — behind a permission policy.</p>
        </div>
        <div className="agents-header-right">
          <span className={`runtime-pill is-${runtime?.readiness ?? 'setup'}`} title={runtime?.reason}>
            <span className="runtime-pill-dot" />
            {runtime?.ok ? 'Local' : 'Offline'}
          </span>
          <PrimaryButton onClick={() => setCreating('blank')}>+ Create agent</PrimaryButton>
        </div>
      </header>

      {createdNotice && <div className="agents-success">{createdNotice}</div>}

      <div className="agents-body">
        <aside className="agents-library">
          <div className="agents-lib-label">Your agents</div>
          {agents.length === 0 ? (
            <div className="agents-empty">No agents yet. Create one from a template below.</div>
          ) : (
            agents.map((a) => (
              <button key={a.id} type="button" className={`agent-lib-card ${a.id === selectedId ? 'is-active' : ''}`} onClick={() => setSelectedId(a.id)}>
                <span className="agent-lib-name">{a.name}</span>
                <span className="agent-lib-meta">{a.permissionMode.replace('_', ' ')} · {a.runCount} run(s)</span>
              </button>
            ))
          )}
          <div className="agents-lib-label">Templates</div>
          <div className="agent-templates">
            {templates.map((t) => (
              <button key={t.id} type="button" className="agent-template-card" onClick={() => setCreating(t)} title={t.description}>
                <span className="agent-template-name">{t.name}</span>
                <span className="agent-template-desc">{t.description}</span>
                {t.note && <span className="agent-template-note">⚠ {t.note}</span>}
              </button>
            ))}
          </div>
        </aside>

        <main className="agents-detail">
          {selected ? (
            <>
              <div className="agents-detail-head">
                <div>
                  <h2>{selected.name}</h2>
                  <p>{selected.description}</p>
                </div>
                <button type="button" className="is-danger" onClick={async () => { await window.api.actionAgent.remove(selected.id); setSelectedId(null); await load() }}>Delete</button>
              </div>

              <div className="agent-perm-card">
                <div className="agent-perm-row"><span>Permission</span><strong>{selected.permissionMode.replace('_', ' ')}</strong></div>
                <div className="agent-perm-row"><span>Folder</span><code>{selected.allowedRoot ?? 'none'}</code></div>
                <div className="agent-perm-row"><span>Commands</span><strong>{selected.allowCommands ? 'allowed (allowlist)' : 'off'}</strong></div>
                <div className="agent-perm-note">
                  {selected.permissionMode === 'preview'
                    ? 'Preview only: plans and previews changes, writes nothing and runs nothing.'
                    : 'This agent may write inside the chosen folder and/or run allowlisted commands. Nothing destructive runs silently; every action is logged.'}
                </div>
              </div>

              <div className="agent-run-form">
                <input value={input} placeholder="Optional input for this run…" onChange={(e) => setInput(e.target.value)} />
                <button type="button" className="is-primary" disabled={busy} onClick={() => void runAgent()}>
                  {busy ? 'Running…' : selected.permissionMode === 'preview' ? 'Preview' : 'Run agent'}
                </button>
              </div>

              {runResult && <RunResultView result={runResult} />}

              <section className="agent-history">
                <h3>Run history</h3>
                {runs.length === 0 ? (
                  <div className="agents-empty">No runs yet.</div>
                ) : (
                  <ul className="agent-run-list">
                    {runs.map((r) => (
                      <li key={r.id} className={`is-${r.status}`}>
                        <span className="agent-run-status">{r.status}</span>
                        <span className="agent-run-summary">{r.summary ?? r.input ?? '—'}</span>
                        <span className="agent-run-meta">{r.filesChanged}f · {r.commandsRun}c{r.riskLevel ? ` · ${r.riskLevel}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : (
            <div className="agents-empty-state">
              <div className="soon-card" style={{ maxWidth: 460 }}>
                <h2>Act with Agents</h2>
                <p className="soon-sub">Turn a repeatable computer/project task into a one-click shortcut, powered by local models and gated by permissions.</p>
                <PrimaryButton onClick={() => setCreating('blank')}>+ Create your first agent</PrimaryButton>
              </div>
            </div>
          )}
        </main>
      </div>

      {creating && (
        <CreateAgentModal
          template={creating === 'blank' ? null : creating}
          models={models}
          onClose={() => setCreating(null)}
          onCreated={async (agent) => {
            setCreating(null)
            await load()
            setSelectedId(agent.id)
            setCreatedNotice(`${agent.name} created and selected.`)
            window.setTimeout(() => setCreatedNotice(null), 3200)
          }}
        />
      )}
    </div>
  )
}

function RunResultView({ result }: { result: AgentRunResult }): JSX.Element {
  return (
    <section className="agent-run-result">
      <h3>
        {result.ok ? (result.previewOnly ? 'Preview complete' : 'Run complete') : 'Run failed'}
        {result.run?.riskLevel && <span className={`agent-risk is-${result.run.riskLevel}`}>{result.run.riskLevel} risk</span>}
      </h3>
      {result.error && <div className="agents-error">{result.error}</div>}
      <div className="agent-run-cols">
        <div>
          <div className="agent-run-col-label">Timeline</div>
          <ul className="agent-event-list">
            {result.events.map((e: ActionAgentEvent) => (
              <li key={e.id} className={`agent-event is-${e.kind}`}>
                <span className="agent-event-kind">{e.kind.replace('_', ' ')}</span>
                <span>{e.message}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="agent-run-col-label">Artifacts</div>
          {result.artifacts.length === 0 ? (
            <div className="agents-empty">No artifacts.</div>
          ) : (
            result.artifacts.map((a: ActionAgentArtifact) => (
              <details key={a.id} className="agent-artifact">
                <summary>{a.title} <span>({a.kind})</span></summary>
                <pre>{a.content}</pre>
              </details>
            ))
          )}
        </div>
      </div>
    </section>
  )
}

function CreateAgentModal({
  template,
  models,
  onClose,
  onCreated
}: {
  template: AgentTemplateInfo | null
  models: LocalModelInfo[]
  onClose: () => void
  onCreated: (agent: ActionAgent) => void | Promise<void>
}): JSX.Element {
  const [name, setName] = useState(template?.name ?? '')
  const [root, setRoot] = useState('')
  const [model, setModel] = useState('')
  const [permission, setPermission] = useState<AgentPermissionMode>(template?.defaultPermission ?? 'preview')
  const [allowCommands, setAllowCommands] = useState(template?.allowCommands ?? false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameInputRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const pick = async (): Promise<void> => {
    const p = (await window.api.actionAgent.pickFolder()) as string | null
    if (p) setRoot(p)
  }

  const create = async (): Promise<void> => {
    setErr(null)
    if (!name.trim()) return setErr('Name the agent.')
    if ((template?.needsRoot ?? true) && !root.trim()) return setErr('Choose a folder this agent may work in.')
    setBusy(true)
    try {
      const input: CreateActionAgentInput = {
        name: name.trim(),
        templateId: template?.id ?? 'blank',
        description: template?.description,
        allowedRoot: root.trim() || undefined,
        permissionMode: permission,
        allowCommands,
        localModel: model || undefined,
        icon: template?.icon,
        category: template?.category
      }
      const agent = (await window.api.actionAgent.create(input)) as ActionAgent
      await onCreated(agent)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <CommandModal ariaLabel="Create agent" onClose={onClose} safeToClose={!busy}>
      <div className="agent-create-modal">
        <ModalHeader
          title="Create agent"
          subtitle="Build a reusable local action shortcut with a folder boundary, local model, and permission policy."
          eyebrow={template ? template.name : 'Reusable shortcut'}
          onClose={onClose}
          closeDisabled={busy}
        />
        <ModalBody>
        {template?.note && <div className="agents-warn">⚠ {template.note}</div>}
        {template && (
          <div className="agent-template-summary">
            <span>Template</span>
            <strong>{template.name}</strong>
            <p>{template.description}</p>
          </div>
        )}
        <FieldLabel label="Name">
          <input ref={nameInputRef} value={name} onChange={(e) => setName(e.target.value)} />
        </FieldLabel>
        <FieldLabel label="Allowed folder or project" hint="The agent is constrained to this root when it previews or writes files.">
          <div className="field-row">
            <input value={root} placeholder="Choose a folder..." onChange={(e) => setRoot(e.target.value)} />
            <SecondaryButton onClick={() => void pick()}>Browse</SecondaryButton>
          </div>
        </FieldLabel>
        <FormGrid>
          <FieldLabel label="Local model">
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Auto (default)</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </FieldLabel>
          <FieldLabel label="Permission mode">
            <select value={permission} onChange={(e) => setPermission(e.target.value as AgentPermissionMode)}>
              <option value="preview">Preview only (safest)</option>
              <option value="ask_write">Ask before write</option>
              <option value="safe_writes">Allow safe writes</option>
              <option value="safe_commands">Allow safe commands</option>
              <option value="manual_each">Manual approval each step</option>
            </select>
          </FieldLabel>
        </FormGrid>
        <label className="loop-checkbox">
          <input type="checkbox" checked={allowCommands} onChange={(e) => setAllowCommands(e.target.checked)} />
          <span>Allow running allowlisted validation commands (typecheck/build/test/lint)</span>
        </label>
        <div className="agent-permission-explain">
          {permission === 'preview'
            ? 'Preview mode plans and reports without writing files or running commands.'
            : 'Higher permission modes stay inside the selected folder and log every action. Destructive commands remain blocked by Akorith safety checks.'}
        </div>
        {err && <div className="agents-error">{err}</div>}
        </ModalBody>
        <ModalFooter>
          <SecondaryButton disabled={busy} onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton disabled={busy} onClick={() => void create()}>{busy ? 'Creating...' : 'Create agent'}</PrimaryButton>
        </ModalFooter>
      </div>
    </CommandModal>
  )
}
