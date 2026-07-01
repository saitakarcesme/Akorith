import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CreateProjectLoopInput,
  LocalModelInfo,
  ProjectLoop,
  ProjectLoopBacklogItem,
  ProjectLoopCommit,
  ProjectLoopEvent,
  ProjectLoopMode,
  ProjectLoopRun,
  ProjectLoopStatus,
  RuntimeStatus
} from '../../../preload/index.d'
import { formatLocalModelLabel } from '../modelLabels'
import {
  CommandModal,
  ModalHeader,
  ModalBody,
  ModalFooter,
  FormGrid,
  FieldLabel,
  PrimaryButton,
  SecondaryButton,
  DangerButton
} from './CreationPrimitives'

// Phase 49: Loop — project operations center. Autonomously grow local & GitHub
// projects with local models. Replaces the old generic loop page.

const MODE_LABEL: Record<ProjectLoopMode, string> = {
  project_builder: 'Project Builder',
  repo_grower: 'Repo Grower',
  github_loop: 'GitHub Repo Loop',
  maintenance: 'Maintenance'
}

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  needs_review: 'Needs review',
  error: 'Error',
  completed: 'Completed',
  archived: 'Archived'
}

function fmtTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

export default function ProjectLoopPage({ active }: { active: boolean }): JSX.Element {
  const [loops, setLoops] = useState<ProjectLoop[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [models, setModels] = useState<LocalModelInfo[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [runs, setRuns] = useState<ProjectLoopRun[]>([])
  const [commits, setCommits] = useState<ProjectLoopCommit[]>([])
  const [events, setEvents] = useState<ProjectLoopEvent[]>([])
  const [backlog, setBacklog] = useState<ProjectLoopBacklogItem[]>([])
  const [notice, setNotice] = useState<string | null>(null)

  const loadLoops = useCallback(async () => {
    try {
      const list = (await window.api.projectLoop.list()) as ProjectLoop[]
      setLoops(list)
      setSelectedId((cur) => cur ?? list[0]?.id ?? null)
    } catch {
      setLoops([])
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void loadLoops()
    void window.api.localRuntime.status().then((s) => setRuntime(s as RuntimeStatus)).catch(() => setRuntime(null))
    void window.api.localRuntime.listModels().then((m) => setModels(m as LocalModelInfo[])).catch(() => setModels([]))
  }, [active, loadLoops])

  const selected = useMemo(() => loops.find((l) => l.id === selectedId) ?? null, [loops, selectedId])

  const loadDetail = useCallback(async (id: string) => {
    const [r, c, e, b] = await Promise.all([
      window.api.projectLoop.listRuns(id) as Promise<ProjectLoopRun[]>,
      window.api.projectLoop.listCommits(id) as Promise<ProjectLoopCommit[]>,
      window.api.projectLoop.listEvents(id) as Promise<ProjectLoopEvent[]>,
      window.api.projectLoop.listBacklog(id) as Promise<ProjectLoopBacklogItem[]>
    ])
    setRuns(r)
    setCommits(c)
    setEvents(e)
    setBacklog(b)
  }, [])

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId)
  }, [selectedId, loadDetail])

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => {
      void loadLoops()
      if (selectedId) void loadDetail(selectedId)
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [active, selectedId, loadLoops, loadDetail])

  const filtered = useMemo(
    () => (filter === 'all' ? loops : loops.filter((l) => l.status === filter)),
    [loops, filter]
  )

  const runOnce = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setNotice('Running one cycle with the local model…')
    try {
      const res = (await window.api.projectLoop.runOnce(selected.id)) as { ok: boolean; committed: boolean; summary: string; error?: string }
      setNotice(res.error ? `Error: ${res.error}` : res.committed ? `Committed: ${res.summary}` : `No commit this cycle: ${res.summary || 'nothing to do'}`)
      await loadLoops()
      await loadDetail(selected.id)
    } finally {
      setBusy(false)
    }
  }

  const setStatus = async (status: ProjectLoopStatus): Promise<void> => {
    if (!selected) return
    await window.api.projectLoop.setStatus(selected.id, status)
    await loadLoops()
  }

  const removeLoop = async (): Promise<void> => {
    if (!selected) return
    await window.api.projectLoop.remove(selected.id)
    setSelectedId(null)
    await loadLoops()
  }

  return (
    <div className="loop-ops-page">
      <header className="loop-ops-header">
        <div>
          <h1>Loop</h1>
          <p>Autonomously grow your local and GitHub projects with local models.</p>
        </div>
        <div className="loop-ops-header-right">
          <span className={`runtime-pill is-${runtime?.readiness ?? 'setup'}`} title={runtime?.reason}>
            <span className="runtime-pill-dot" />
            {runtime?.ok ? `Local runtime · ${runtime.modelCount} model(s)` : 'Local runtime offline'}
          </span>
          <PrimaryButton onClick={() => setCreating(true)}>+ Create project loop</PrimaryButton>
        </div>
      </header>

      <div className="loop-ops-body">
        <aside className="loop-ops-list">
          <div className="loop-ops-filters">
            {['all', 'active', 'paused', 'needs_review', 'error', 'archived'].map((f) => (
              <button key={f} type="button" className={filter === f ? 'is-active' : ''} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : STATUS_LABEL[f] ?? f}
              </button>
            ))}
          </div>
          {filtered.length === 0 ? (
            <div className="loop-ops-empty-list">No loops{filter !== 'all' ? ' in this state' : ' yet'}.</div>
          ) : (
            filtered.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`loop-ops-card ${l.id === selectedId ? 'is-active' : ''}`}
                onClick={() => setSelectedId(l.id)}
              >
                <div className="loop-ops-card-top">
                  <span className="loop-ops-card-title">{l.title}</span>
                  <span className={`loop-status-badge is-${l.status}`}>{STATUS_LABEL[l.status] ?? l.status}</span>
                </div>
                <div className="loop-ops-card-meta">
                  {MODE_LABEL[l.mode]} · {l.autonomy} · {l.commitCount} commit(s) · {l.runCount} run(s)
                </div>
              </button>
            ))
          )}
        </aside>

        {selected ? (
          <main className="loop-ops-detail">
            <div className="loop-ops-detail-head">
              <div>
                <h2>{selected.title}</h2>
                <div className="loop-ops-detail-sub">
                  {MODE_LABEL[selected.mode]} · {selected.autonomy} · <code>{selected.localPath}</code>
                </div>
              </div>
              <div className="loop-ops-actions">
                <PrimaryButton disabled={busy} onClick={() => void runOnce()}>
                  {busy ? 'Running...' : selected.autonomy === 'auto' ? 'Run now' : 'Run one cycle'}
                </PrimaryButton>
                {selected.status === 'paused' ? (
                  <SecondaryButton onClick={() => void setStatus('active')}>Resume</SecondaryButton>
                ) : (
                  <SecondaryButton onClick={() => void setStatus('paused')}>Pause</SecondaryButton>
                )}
                <SecondaryButton onClick={() => void setStatus('archived')}>Archive</SecondaryButton>
                <DangerButton onClick={() => void removeLoop()}>Delete</DangerButton>
              </div>
            </div>

            {notice && <div className="loop-ops-notice">{notice}</div>}

            <div className="loop-ops-grid">
              <section className="loop-ops-section">
                <h3>Run timeline</h3>
                {runs.length === 0 ? (
                  <div className="loop-ops-empty">
                    {selected.autonomy === 'auto' ? 'No runs yet. Auto will start the first cycle shortly.' : 'No runs yet. Click "Run one cycle".'}
                  </div>
                ) : (
                  <ul className="loop-run-list">
                    {runs.map((r) => (
                      <li key={r.id} className={`loop-run is-${r.status}`}>
                        <span className="loop-run-idx">#{r.runIndex}</span>
                        <span className="loop-run-status">{r.status}</span>
                        <span className="loop-run-summary">{r.summary ?? r.objective ?? '—'}</span>
                        <span className="loop-run-meta">{r.filesChanged}f · {r.commitsCreated}c</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="loop-ops-section">
                <h3>Commit ledger</h3>
                {commits.length === 0 ? (
                  <div className="loop-ops-empty">No commits yet.</div>
                ) : (
                  <ul className="loop-commit-list">
                    {commits.map((c) => (
                      <li key={c.id}>
                        <code>{c.sha.slice(0, 8)}</code> {c.message}
                        <span className="loop-commit-meta">{c.filesChanged}f · {fmtTime(c.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="loop-ops-section">
                <h3>Event log</h3>
                {events.length === 0 ? (
                  <div className="loop-ops-empty">No events yet.</div>
                ) : (
                  <ul className="loop-event-list">
                    {events.map((e) => (
                      <li key={e.id} className={`loop-event is-${e.kind}`}>
                        <span className="loop-event-kind">{e.kind}</span>
                        <span className="loop-event-msg">{e.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="loop-ops-section">
                <h3>Backlog</h3>
                <BacklogEditor loopId={selected.id} items={backlog} onChange={() => void loadDetail(selected.id)} />
              </section>
            </div>
          </main>
        ) : (
          <main className="loop-ops-detail loop-ops-empty-state">
            <div className="soon-card" style={{ maxWidth: 460 }}>
              <h2>Build with Loop</h2>
              <p className="soon-sub">Give Akorith a project idea, a local repo, or a GitHub URL — local models grow it over time with safe, validated commits.</p>
              <PrimaryButton onClick={() => setCreating(true)}>+ Create your first loop</PrimaryButton>
            </div>
          </main>
        )}
      </div>

      {creating && (
        <CreateLoopModal
          models={models}
          onClose={() => setCreating(false)}
          onCreated={async (loop) => {
            setCreating(false)
            await loadLoops()
            setSelectedId(loop.id)
          }}
        />
      )}
    </div>
  )
}

function BacklogEditor({
  loopId,
  items,
  onChange
}: {
  loopId: string
  items: ProjectLoopBacklogItem[]
  onChange: () => void
}): JSX.Element {
  const [title, setTitle] = useState('')
  const add = async (): Promise<void> => {
    if (!title.trim()) return
    await window.api.projectLoop.addBacklog(loopId, title.trim())
    setTitle('')
    onChange()
  }
  return (
    <div className="loop-backlog">
      <div className="loop-backlog-add">
        <input value={title} placeholder="Add a feature / objective…" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        <button type="button" onClick={() => void add()}>Add</button>
      </div>
      {items.length === 0 ? (
        <div className="loop-ops-empty">No backlog items. The planner will pick objectives itself.</div>
      ) : (
        <ul className="loop-backlog-list">
          {items.map((i) => (
            <li key={i.id} className={`is-${i.status}`}>
              <span>{i.title}</span>
              <span className="loop-backlog-status">{i.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CreateLoopModal({
  models,
  onClose,
  onCreated
}: {
  models: LocalModelInfo[]
  onClose: () => void
  onCreated: (loop: ProjectLoop) => void | Promise<void>
}): JSX.Element {
  const [mode, setMode] = useState<ProjectLoopMode>('project_builder')
  const [title, setTitle] = useState('')
  const [idea, setIdea] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [model, setModel] = useState<string>('')
  const [autonomy, setAutonomy] = useState('assisted')
  const [safety, setSafety] = useState('standard')
  const [dailyTarget, setDailyTarget] = useState(1)
  const [pushEnabled, setPushEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Phase 55.071: focus the title on open, matching the Agents create modal.
  useEffect(() => {
    titleInputRef.current?.focus()
  }, [])

  const pick = async (): Promise<void> => {
    const p = (await window.api.projectLoop.pickFolder()) as string | null
    if (p) setLocalPath(p)
  }

  const create = async (): Promise<void> => {
    setErr(null)
    if (!title.trim()) return setErr('Give the loop a title.')
    if (!localPath.trim()) return setErr('Choose a project folder.')
    setBusy(true)
    try {
      const input: CreateProjectLoopInput = {
        title: title.trim(),
        mode,
        localPath: localPath.trim(),
        idea: idea.trim() || undefined,
        repoUrl: repoUrl.trim() || undefined,
        localModel: model || undefined,
        autonomy: autonomy as CreateProjectLoopInput['autonomy'],
        safety: safety as CreateProjectLoopInput['safety'],
        dailyCommitTarget: dailyTarget,
        pushEnabled
      }
      const loop = (await window.api.projectLoop.create(input)) as ProjectLoop
      await onCreated(loop)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const isDirty = Boolean(title || idea || localPath || repoUrl || model)

  return (
    <CommandModal ariaLabel="Create project loop" onClose={onClose} safeToClose={!busy && !isDirty}>
      <div className="loop-create-modal">
        <ModalHeader
          title="Create project loop"
          subtitle="Autonomously grow a local or GitHub project with local models — safe, validated commits."
          eyebrow={MODE_LABEL[mode]}
          onClose={onClose}
          closeDisabled={busy}
        />
        <ModalBody>
          <FieldLabel label="Mode">
            <select value={mode} onChange={(e) => setMode(e.target.value as ProjectLoopMode)}>
              <option value="project_builder">Project Builder — start from an idea</option>
              <option value="repo_grower">Repo Grower — improve an existing local repo</option>
              <option value="github_loop">GitHub Repo Loop — a cloned repo</option>
              <option value="maintenance">Maintenance — docs/tests/refactor/polish</option>
            </select>
          </FieldLabel>
          <FieldLabel label="Title">
            <input ref={titleInputRef} value={title} placeholder="My side project" onChange={(e) => setTitle(e.target.value)} />
          </FieldLabel>
          {(mode === 'project_builder' || mode === 'maintenance' || mode === 'repo_grower') && (
            <FieldLabel label="Idea / direction">
              <textarea value={idea} placeholder="What do you want this project to become?" onChange={(e) => setIdea(e.target.value)} />
            </FieldLabel>
          )}
          {mode === 'github_loop' && (
            <FieldLabel label="GitHub URL">
              <input value={repoUrl} placeholder="https://github.com/owner/name" onChange={(e) => setRepoUrl(e.target.value)} />
            </FieldLabel>
          )}
          <FieldLabel label="Project folder" hint="Loop reads and writes only inside this folder; it commits locally and never pushes unless enabled.">
            <div className="field-row">
              <input value={localPath} placeholder="Choose a working folder..." onChange={(e) => setLocalPath(e.target.value)} />
              <SecondaryButton onClick={() => void pick()}>Browse</SecondaryButton>
            </div>
          </FieldLabel>
          <FormGrid>
            <FieldLabel label="Local model">
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Auto (default)</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{formatLocalModelLabel(m.id, m.label)}</option>
                ))}
              </select>
            </FieldLabel>
            <FieldLabel label="Autonomy">
              <select value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
                <option value="manual">Manual</option>
                <option value="assisted">Assisted</option>
                <option value="auto">Auto</option>
              </select>
            </FieldLabel>
            <FieldLabel label="Safety">
              <select value={safety} onChange={(e) => setSafety(e.target.value)}>
                <option value="strict">Strict</option>
                <option value="standard">Standard</option>
                <option value="open">Open</option>
              </select>
            </FieldLabel>
            <FieldLabel label="Daily commit target">
              <input type="number" min={0} max={50} value={dailyTarget} onChange={(e) => setDailyTarget(Number(e.target.value))} />
            </FieldLabel>
          </FormGrid>
          <label className="loop-checkbox">
            <input type="checkbox" checked={pushEnabled} onChange={(e) => setPushEnabled(e.target.checked)} />
            <span>Allow pushing to GitHub — off by default. Local-only is safest; pushes are never forced.</span>
          </label>
          {err && <div className="agents-error">{err}</div>}
        </ModalBody>
        <ModalFooter>
          <SecondaryButton disabled={busy} onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton disabled={busy} onClick={() => void create()}>{busy ? 'Creating...' : 'Create loop'}</PrimaryButton>
        </ModalFooter>
      </div>
    </CommandModal>
  )
}
