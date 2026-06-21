import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MacroSessionRow, MacroState, ProviderInfo, PtyCommandKind } from '../../../preload/index.d'
import { LoopIcon, PlusIcon, ChevronIcon } from './icons'

// Phase 21: the Loop section. A deliberately non-technical home for auto-commit
// project generation. You describe a project in a sentence or two; Akorith
// scaffolds a git repo, builds it, and saves every change as a "Phase N" step.
// The macro/critic/token machinery from Phases 19–20 runs underneath — none of
// it is exposed here.

type View = 'list' | 'create' | 'detail'
type LoopIntent = 'continuous' | 'monitor' | 'daily-build' | 'custom'
type ExecutorTarget = 't1' | 't2'

interface AutoAction {
  type: string
  phase?: number
  message?: string
  reason?: string
  at?: number
}

const EXECUTORS: Array<{ target: ExecutorTarget; kind: PtyCommandKind; label: string; hint: string }> = [
  { target: 't1', kind: 'claude-auto', label: 'Claude / Atlantis', hint: 'best for coding agent work' },
  { target: 't2', kind: 'codex-auto', label: 'ChatGPT / Olympus', hint: 'use when Claude is busy' }
]

const LOOP_INTENTS: Array<{ id: LoopIntent; label: string; defaultMinutes: number }> = [
  { id: 'continuous', label: 'Continuous', defaultMinutes: 0 },
  { id: 'monitor', label: 'Every 5 min', defaultMinutes: 5 },
  { id: 'daily-build', label: 'Daily build', defaultMinutes: 1440 },
  { id: 'custom', label: 'Custom', defaultMinutes: 15 }
]

// Phase 23.1: Fully Active/Passive Loop Switch.
const LOOP_ACTIVITY = [
  { active: true, label: 'Active', hint: 'Akorith starts and keeps going' },
  { active: false, label: 'Passive', hint: 'You click Resume when it should move' }
]

function projectKey(id: string): string {
  return id.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 40)
}

function parseAutoActions(json: string | null): AutoAction[] {
  if (!json) return []
  try {
    const list = JSON.parse(json) as AutoAction[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function commitsOf(session: MacroSessionRow): AutoAction[] {
  return parseAutoActions(session.autoActions).filter((a) => a.type === 'auto_commit' && a.message)
}

function executorForTarget(target: string): { target: ExecutorTarget; kind: PtyCommandKind; label: string; hint: string } {
  return EXECUTORS.find((e) => e.target === target) ?? EXECUTORS[0]
}

function defaultExecutorForProvider(providerId: string): ExecutorTarget {
  return providerId === 'chatgpt' ? 't2' : 't1'
}

function providerLabel(providers: ProviderInfo[], id: string): string {
  return providers.find((p) => p.id === id)?.label ?? id
}

function selectedModel(provider: ProviderInfo | undefined, value: string): string {
  if (!provider) return ''
  if (value && provider.models.includes(value)) return value
  return provider.models[0] ?? ''
}

function normalizeCadence(intent: LoopIntent, minutes: number): number {
  if (intent === 'continuous') return 0
  if (intent === 'daily-build') return 1440
  const n = Number.isFinite(minutes) ? Math.floor(minutes) : 5
  return Math.min(Math.max(n, 1), 7 * 24 * 60)
}

function formatCadenceMinutes(minutes: number): string {
  if (!minutes) return 'continuous'
  if (minutes >= 1440 && minutes % 1440 === 0) return `every ${minutes / 1440} day${minutes === 1440 ? '' : 's'}`
  if (minutes >= 60 && minutes % 60 === 0) return `every ${minutes / 60} hour${minutes === 60 ? '' : 's'}`
  return `every ${minutes} min`
}

function cadenceSummary(session: MacroSessionRow): string {
  return formatCadenceMinutes(session.cadenceMinutes)
}

function activitySummary(session: MacroSessionRow): string {
  return session.mode === 'auto' ? 'fully active' : 'passive'
}

function parseStrArray(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** A short, readable "what happened" line from a turn's result summary. */
function resultLine(summary: string | null): string {
  if (!summary) return ''
  // The first line is the agent's current-status sentence; drop the folded-in
  // critic block and metrics for a clean timeline entry.
  const first = summary.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return first.replace(/^current status:?\s*/i, '').slice(0, 200)
}

const RUNNING = new Set(['auto_running', 'proposing', 'preparing_context', 'sending', 'summarizing'])
const PAUSED = new Set(['awaiting_permission', 'awaiting_executor_result', 'awaiting_approval'])

interface Friendly {
  label: string
  tone: 'running' | 'paused' | 'done' | 'stopped' | 'idle' | 'error'
}

function friendlyStatus(session: MacroSessionRow): Friendly {
  const s = session.status
  if (RUNNING.has(s)) return { label: 'Building…', tone: 'running' }
  if (s === 'completed') return { label: 'Finished', tone: 'done' }
  if (s === 'error') return { label: 'Needs attention', tone: 'error' }
  if (s === 'stopped') return { label: 'Stopped', tone: 'stopped' }
  if (PAUSED.has(s)) return { label: session.pauseReason ? 'Paused — needs you' : 'Waiting', tone: 'paused' }
  return { label: 'Ready', tone: 'idle' }
}

function loopTitle(session: MacroSessionRow): string {
  if (session.title && session.title.trim()) return session.title.trim()
  const goal = session.goal?.trim() ?? ''
  return goal ? goal.slice(0, 80) : 'Untitled loop'
}

function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export default function LoopsPage({ active }: { active: boolean }): JSX.Element {
  const [view, setView] = useState<View>('list')
  const [loops, setLoops] = useState<MacroSessionRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<MacroState | null>(null)
  const [description, setDescription] = useState('')
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [plannerProvider, setPlannerProvider] = useState('')
  const [plannerModel, setPlannerModel] = useState('')
  const [executorTarget, setExecutorTarget] = useState<ExecutorTarget>('t1')
  const [loopIntent, setLoopIntent] = useState<LoopIntent>('continuous')
  const [cadenceMinutes, setCadenceMinutes] = useState(5)
  const [fullyLoopActive, setFullyLoopActive] = useState(true)
  const [detailProvider, setDetailProvider] = useState('')
  const [detailModel, setDetailModel] = useState('')
  const [detailTarget, setDetailTarget] = useState<ExecutorTarget>('t1')
  const [savingPlanner, setSavingPlanner] = useState(false)
  const [busy, setBusy] = useState(false)
  const [busyNote, setBusyNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Ticks once per second so timers update live without re-fetching.
  const [, setTick] = useState(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshLoops = useCallback(async (): Promise<void> => {
    try {
      const list = await window.api.macro.list(50)
      setLoops(list.filter((s) => s.workspaceDir))
    } catch {
      /* keep last list */
    }
  }, [])

  const refreshProviders = useCallback(async (): Promise<ProviderInfo[]> => {
    const list = await window.api.chat.listProviders()
    setProviders(list)
    const firstAvailable = list.find((p) => p.available.ok) ?? list[0]
    if (firstAvailable) {
      setPlannerProvider((current) => (current && list.some((p) => p.id === current) ? current : firstAvailable.id))
      setPlannerModel((current) => (current ? current : firstAvailable.models[0] ?? ''))
      setExecutorTarget((current) => current || defaultExecutorForProvider(firstAvailable.id))
    }
    return list
  }, [])

  // Live one-second tick for elapsed timers.
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])

  useEffect(() => {
    if (!active) return
    void refreshProviders().catch(() => {
      /* provider state is best-effort */
    })
  }, [active, refreshProviders])

  // Poll the right thing for the current view.
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    if (!active) return
    if (view === 'detail' && selectedId) {
      const sid = selectedId
      const pull = (): void => {
        void window.api.macro.get(sid).then((d) => d && setDetail(d))
      }
      pull()
      pollRef.current = setInterval(pull, 2000)
    } else if (view === 'list') {
      void refreshLoops()
      pollRef.current = setInterval(() => void refreshLoops(), 3000)
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [active, view, selectedId, refreshLoops])

  const createPlanner = useMemo(() => providers.find((p) => p.id === plannerProvider), [providers, plannerProvider])
  const detailPlanner = useMemo(() => providers.find((p) => p.id === detailProvider), [providers, detailProvider])

  // Ensure the selected executor agent is running in the loop's folder.
  const ensureExecutor = useCallback(async (project: { id: string }, cwd: string, targetTerminal: string): Promise<void> => {
    const key = projectKey(project.id)
    const executor = executorForTarget(targetTerminal)
    window.api.pty.setActiveProject(key)
    await window.api.pty.create(`${executor.target}::${key}`, { cols: 120, rows: 32, cwd, commandKind: executor.kind })
  }, [])

  const createLoop = useCallback(async (): Promise<void> => {
    const text = description.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      setBusyNote('Checking the selected model…')
      const list = providers.length ? providers : await refreshProviders()
      const planner = list.find((p: ProviderInfo) => p.id === plannerProvider) ?? list.find((p: ProviderInfo) => p.available.ok)
      if (!planner?.available.ok) {
        setError('No AI engine is available yet. Start Ollama (or sign in to a coding CLI) and try again.')
        return
      }
      const model = selectedModel(planner, plannerModel)
      const target = executorTarget
      const cadence = normalizeCadence(loopIntent, cadenceMinutes)
      setBusyNote('Inventing and scaffolding your project…')
      const res = await window.api.macro.createWorkspaceProject({
        seed: text,
        plannerProvider: planner.id,
        plannerModel: model || undefined,
        targetTerminal: target,
        mode: fullyLoopActive ? 'auto' : 'approval',
        loopIntent,
        cadenceMinutes: cadence,
        maxIterations: cadence > 0 ? 200 : 30
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      let state = res.state
      if (fullyLoopActive) {
        setBusyNote('Waking up the builder…')
        await ensureExecutor(res.project, res.workspaceDir, target)
        await new Promise((r) => setTimeout(r, 3500))
        setBusyNote('Starting the loop…')
        const started = await window.api.macro.startAuto(res.state.session.id)
        if (started.ok) state = started.state
      }
      setDescription('')
      setSelectedId(state.session.id)
      setDetail(state)
      setView('detail')
      void refreshLoops()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setBusyNote('')
    }
  }, [description, busy, providers, refreshProviders, plannerProvider, plannerModel, executorTarget, loopIntent, cadenceMinutes, fullyLoopActive, ensureExecutor, refreshLoops])

  const openLoop = useCallback((id: string): void => {
    setSelectedId(id)
    setDetail(null)
    setView('detail')
  }, [])

  const stopLoop = useCallback(async (id: string): Promise<void> => {
    await window.api.macro.stop(id)
    const d = await window.api.macro.get(id)
    if (d) setDetail(d)
  }, [])

  const steerLoop = useCallback(async (id: string, choice: string): Promise<void> => {
    await window.api.macro.steer(id, choice)
    const d = await window.api.macro.get(id)
    if (d) setDetail(d)
  }, [])

  const resumeLoop = useCallback(async (session: MacroSessionRow): Promise<void> => {
    if (!session.workspaceDir) return
    setBusy(true)
    try {
      // The executor may have exited (e.g. after a restart) — bring it back first.
      // Its terminal key comes from the project (matched by its folder), not the session.
      const projects = await window.api.projects.list()
      const proj = projects.find((p) => p.path === session.workspaceDir)
      if (proj) {
        await ensureExecutor({ id: proj.id }, session.workspaceDir, session.targetTerminal)
        await new Promise((r) => setTimeout(r, 1500))
      }
      await window.api.macro.startAuto(session.id)
      const d = await window.api.macro.get(session.id)
      if (d) setDetail(d)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [ensureExecutor])

  const setLoopActivity = useCallback(async (session: MacroSessionRow, activeMode: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const mode = activeMode ? 'auto' : 'approval'
      const res = await window.api.macro.setMode(session.id, mode)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setDetail(res.state)
      if (activeMode && session.status !== 'completed' && session.status !== 'stopped' && !RUNNING.has(session.status)) {
        await resumeLoop(res.state.session)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [resumeLoop])

  const selected = detail?.session ?? loops.find((l) => l.id === selectedId) ?? null

  useEffect(() => {
    if (!selected) return
    setDetailProvider(selected.plannerProvider)
    setDetailModel(selected.plannerModel ?? '')
    setDetailTarget(executorForTarget(selected.targetTerminal).target)
  }, [selected?.id, selected?.plannerProvider, selected?.plannerModel, selected?.targetTerminal])

  const saveLoopPlanner = useCallback(async (session: MacroSessionRow): Promise<void> => {
    const list = providers.length ? providers : await refreshProviders()
    const planner = list.find((p) => p.id === detailProvider)
    if (!planner?.available.ok) {
      setError(planner?.available.reason || 'Selected model is not available right now.')
      return
    }
    setSavingPlanner(true)
    setError(null)
    try {
      const model = selectedModel(planner, detailModel)
      const target = detailTarget
      const res = await window.api.macro.setPlanner({
        sessionId: session.id,
        plannerProvider: planner.id,
        plannerModel: model || undefined,
        targetTerminal: target
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      if (session.workspaceDir) {
        const projects = await window.api.projects.list()
        const proj = projects.find((p) => p.path === session.workspaceDir)
        if (proj) await ensureExecutor({ id: proj.id }, session.workspaceDir, target)
      }
      setDetail(res.state)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingPlanner(false)
    }
  }, [providers, refreshProviders, detailProvider, detailModel, detailTarget, ensureExecutor])

  // ---------- detail view ----------
  if (view === 'detail' && selected) {
    const f = friendlyStatus(selected)
    const commits = commitsOf(selected)
    const elapsed = fmtDuration(Date.now() - selected.createdAt)
    const isRunning = RUNNING.has(selected.status)
    const isPaused = PAUSED.has(selected.status)
    const isActive = isRunning || isPaused
    const turns = detail?.turns ?? []
    const latest = turns.length ? turns[turns.length - 1] : null
    const activity = latest?.plannerRationale?.trim() || latest?.proposal?.trim() || ''
    const options = parseStrArray(latest?.nextOptions)
    const steered = selected.pendingSteering?.trim() ?? ''
    return (
      <div className="loops-page">
        <button type="button" className="loop-back" onClick={() => setView('list')}>
          <ChevronIcon size={16} direction="left" /> All loops
        </button>
        <div className="loop-detail">
          <div className="loop-detail-head">
            <h1>{loopTitle(selected)}</h1>
            <span className={`loop-pill is-${f.tone}`}>{f.label}</span>
          </div>

          <div className="loop-stats">
            <div className="loop-stat">
              <span className="loop-stat-num">{commits.length}</span>
              <span className="loop-stat-label">changes saved</span>
            </div>
            <div className="loop-stat">
              <span className="loop-stat-num">{elapsed}</span>
              <span className="loop-stat-label">{isRunning ? 'running' : 'since started'}</span>
            </div>
          </div>

          <div className="loop-control-panel">
            <div className="loop-activity-row">
              <div>
                <span className="loop-control-label">Fully loop</span>
                <strong>{selected.mode === 'auto' ? 'Active' : 'Passive'}</strong>
              </div>
              <div className="loop-segmented is-compact">
                {LOOP_ACTIVITY.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    className={(selected.mode === 'auto') === item.active ? 'is-selected' : ''}
                    disabled={busy || selected.status === 'completed' || selected.status === 'stopped'}
                    title={item.hint}
                    onClick={() => void setLoopActivity(selected, item.active)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="loop-control-row">
              <label className="loop-field">
                <span>Model</span>
                <select
                  value={detailProvider}
                  disabled={savingPlanner || providers.length === 0}
                  onChange={(e) => {
                    const id = e.target.value
                    const p = providers.find((item) => item.id === id)
                    setDetailProvider(id)
                    setDetailModel(p?.models[0] ?? '')
                    setDetailTarget(defaultExecutorForProvider(id))
                  }}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available.ok && p.id !== selected.plannerProvider}>
                      {p.label}{p.available.ok ? '' : ' (offline)'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="loop-field">
                <span>Variant</span>
                <select
                  value={detailModel}
                  disabled={savingPlanner || !detailPlanner || detailPlanner.models.length === 0}
                  onChange={(e) => setDetailModel(e.target.value)}
                >
                  {(detailPlanner?.models.length ? detailPlanner.models : ['']).map((m) => (
                    <option key={m || 'default'} value={m}>
                      {m || 'Default'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="loop-field">
                <span>Builder</span>
                <select
                  value={detailTarget}
                  disabled={savingPlanner}
                  onChange={(e) => setDetailTarget(executorForTarget(e.target.value).target)}
                >
                  {EXECUTORS.map((e) => (
                    <option key={e.target} value={e.target}>{e.label}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="loop-btn"
                disabled={savingPlanner || !detailProvider || !detailPlanner?.available.ok}
                onClick={() => void saveLoopPlanner(selected)}
              >
                {savingPlanner ? 'Saving…' : 'Save model'}
              </button>
            </div>
            <div className="loop-meta-strip">
              <span>{providerLabel(providers, selected.plannerProvider)} plans</span>
              <span>{executorForTarget(selected.targetTerminal).label} builds</span>
              <span>{cadenceSummary(selected)}</span>
              <span>{activitySummary(selected)}</span>
            </div>
            {detailPlanner && !detailPlanner.available.ok && (
              <div className="loop-field-hint">{detailPlanner.available.reason || 'This provider is unavailable right now.'}</div>
            )}
          </div>

          {/* What's happening right now — so you always know what the loop is doing. */}
          {isActive && (
            <div className="loop-now">
              <span className="loop-now-label">{isRunning ? 'Working on' : 'Up next'}</span>
              <p className="loop-now-text">{activity || 'Thinking about the next step…'}</p>
            </div>
          )}

          {/* Steer what comes next — pick a direction, the loop keeps running. */}
          {isActive && (steered || options.length > 0) && (
            <div className="loop-steer">
              {steered ? (
                <div className="loop-steer-chosen">Heading toward: <strong>{steered}</strong> next.</div>
              ) : (
                <>
                  <div className="loop-steer-q">Where should it go next?</div>
                  <div className="loop-steer-options">
                    {options.map((opt, i) => (
                      <button
                        key={i}
                        type="button"
                        className="loop-chip"
                        onClick={() => void steerLoop(selected.id, opt)}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                  <div className="loop-steer-hint">Or do nothing — it continues on the first option automatically.</div>
                </>
              )}
            </div>
          )}

          {selected.pauseReason && isPaused && (
            <div className="loop-note">Waiting on a decision ({selected.pauseReason.replace(/_/g, ' ')}). Resume to continue, or stop the loop.</div>
          )}
          {selected.status === 'error' && selected.stopReason && (
            <div className="loop-note is-error">{selected.stopReason}</div>
          )}
          {selected.status === 'completed' && <div className="loop-note">Finished — the loop reached its goal. 🎉</div>}
          {selected.status === 'stopped' && <div className="loop-empty">This loop has stopped. Start a new one anytime.</div>}

          <div className="loop-actions">
            {(isPaused || selected.status === 'idle') && (
              <button type="button" className="loop-btn is-primary" disabled={busy} onClick={() => void resumeLoop(selected)}>
                {busy ? 'Resuming…' : 'Resume'}
              </button>
            )}
            {isActive && (
              <button type="button" className="loop-btn is-stop" onClick={() => void stopLoop(selected.id)}>
                Stop loop
              </button>
            )}
          </div>

          {/* Detailed step-by-step timeline: what it set out to do, and what happened. */}
          <h2 className="loop-section-title">Steps</h2>
          {turns.length === 0 ? (
            <div className="loop-empty">
              {isActive ? 'Getting started… the first step takes a minute.' : 'No steps yet.'}
            </div>
          ) : (
            <ol className="loop-steps">
              {[...turns].reverse().map((t) => {
                const result = resultLine(t.executorResultSummary)
                const inProgress = !t.executorResultSummary && isRunning && t.turnIndex === turns.length
                return (
                  <li key={t.id} className="loop-step">
                    <div className="loop-step-head">
                      <span className="loop-step-n">Step {t.turnIndex}</span>
                      {t.criticScore != null ? (
                        <span className={`loop-pill is-${t.criticVerdict === 'regressed' ? 'error' : t.criticVerdict === 'complete' || t.criticVerdict === 'advanced' ? 'done' : 'paused'}`}>
                          {t.criticScore}/100
                        </span>
                      ) : inProgress ? (
                        <span className="loop-pill is-running">working…</span>
                      ) : null}
                    </div>
                    {t.plannerRationale && <div className="loop-step-plan">{t.plannerRationale}</div>}
                    {result && <div className="loop-step-result">{result}</div>}
                  </li>
                )
              })}
            </ol>
          )}

          <h2 className="loop-section-title">Saved changes</h2>
          {commits.length === 0 ? (
            <div className="loop-empty">Nothing committed yet.</div>
          ) : (
            <ol className="loop-commits">
              {[...commits].reverse().map((c, i) => (
                <li key={i} className="loop-commit">
                  <span className="loop-commit-dot" />
                  <span className="loop-commit-msg">{c.message}</span>
                </li>
              ))}
            </ol>
          )}

          {selected.workspaceDir && (
            <div className="loop-folder">
              Saved in <code>{selected.workspaceDir}</code>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ---------- create view ----------
  if (view === 'create') {
    const createModels = createPlanner?.models ?? []
    const createCadence = normalizeCadence(loopIntent, cadenceMinutes)
    return (
      <div className="loops-page">
        <button type="button" className="loop-back" onClick={() => !busy && setView('list')}>
          <ChevronIcon size={16} direction="left" /> All loops
        </button>
        <div className="loop-create">
          <h1>Start a new loop</h1>
          <p className="loops-sub">
            Describe the loop, choose the model, and pick how often Akorith should take the next step.
          </p>
          <textarea
            className="loop-create-input"
            rows={4}
            autoFocus
            disabled={busy}
            value={description}
            placeholder="e.g. Watch @ibrahimsait_ on X. Every 5 minutes, check for new posts, reposts, or replies, update FINDINGS.md, and notify me when something changed."
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="loop-examples">
            <button
              type="button"
              className="loop-chip"
              disabled={busy}
              onClick={() => {
                setLoopIntent('monitor')
                setCadenceMinutes(5)
                setDescription('Watch the X account @ibrahimsait_. Every 5 minutes, check for new posts, reposts, and replies, keep a seen-state, update FINDINGS.md, and notify me when something changed.')
              }}
            >
              X monitor
            </button>
            <button
              type="button"
              className="loop-chip"
              disabled={busy}
              onClick={() => {
                setLoopIntent('daily-build')
                setCadenceMinutes(1440)
                setDescription('Create a useful small project idea, build it, then every day find one strong feature idea, develop it, test it, commit it, and push the changes to GitHub.')
              }}
            >
              Daily project
            </button>
          </div>

          <div className="loop-create-controls">
            <div className="loop-activity-row">
              <div>
                <span className="loop-control-label">Fully loop</span>
                <strong>{fullyLoopActive ? 'Active' : 'Passive'}</strong>
              </div>
              <div className="loop-segmented is-compact">
                {LOOP_ACTIVITY.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    className={fullyLoopActive === item.active ? 'is-selected' : ''}
                    disabled={busy}
                    title={item.hint}
                    onClick={() => setFullyLoopActive(item.active)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="loop-field">
              <span>Rhythm</span>
              <div className="loop-segmented">
                {LOOP_INTENTS.map((intent) => (
                  <button
                    key={intent.id}
                    type="button"
                    className={loopIntent === intent.id ? 'is-selected' : ''}
                    disabled={busy}
                    onClick={() => {
                      setLoopIntent(intent.id)
                      setCadenceMinutes(intent.defaultMinutes || 5)
                    }}
                  >
                    {intent.label}
                  </button>
                ))}
              </div>
            </div>
            {(loopIntent === 'monitor' || loopIntent === 'custom') && (
              <label className="loop-field loop-field-small">
                <span>Minutes</span>
                <input
                  type="number"
                  min={1}
                  max={7 * 24 * 60}
                  value={cadenceMinutes}
                  disabled={busy}
                  onChange={(e) => setCadenceMinutes(Number(e.target.value))}
                />
              </label>
            )}
            <div className="loop-control-row">
              <label className="loop-field">
                <span>Model</span>
                <select
                  value={plannerProvider}
                  disabled={busy || providers.length === 0}
                  onChange={(e) => {
                    const id = e.target.value
                    const p = providers.find((item) => item.id === id)
                    setPlannerProvider(id)
                    setPlannerModel(p?.models[0] ?? '')
                    setExecutorTarget(defaultExecutorForProvider(id))
                  }}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available.ok}>
                      {p.label}{p.available.ok ? '' : ' (offline)'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="loop-field">
                <span>Variant</span>
                <select
                  value={plannerModel}
                  disabled={busy || !createPlanner || createModels.length === 0}
                  onChange={(e) => setPlannerModel(e.target.value)}
                >
                  {(createModels.length ? createModels : ['']).map((m) => (
                    <option key={m || 'default'} value={m}>
                      {m || 'Default'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="loop-field">
                <span>Builder</span>
                <select
                  value={executorTarget}
                  disabled={busy}
                  onChange={(e) => setExecutorTarget(executorForTarget(e.target.value).target)}
                >
                  {EXECUTORS.map((e) => (
                    <option key={e.target} value={e.target}>{e.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="loop-meta-strip">
              <span>{createPlanner ? `${createPlanner.label} plans` : 'no model selected'}</span>
              <span>{executorForTarget(executorTarget).label} builds</span>
              <span>{formatCadenceMinutes(createCadence)}</span>
              <span>{fullyLoopActive ? 'fully active' : 'passive'}</span>
            </div>
            {createPlanner && !createPlanner.available.ok && (
              <div className="loop-field-hint">{createPlanner.available.reason || 'This provider is unavailable right now.'}</div>
            )}
          </div>
          {error && <div className="loop-note is-error">{error}</div>}
          <div className="loop-actions">
            <button
              type="button"
              className="loop-btn is-primary is-big"
              disabled={!description.trim() || busy || !createPlanner?.available.ok}
              onClick={() => void createLoop()}
            >
              {busy ? busyNote || 'Setting up…' : 'Create loop'}
            </button>
          </div>
          {busy && <div className="loop-empty">This takes a little while — you can leave this page; the loop keeps running.</div>}
        </div>
      </div>
    )
  }

  // ---------- list view ----------
  return (
    <div className="loops-page">
      <header className="loops-head">
        <div className="loops-title">
          <LoopIcon size={22} />
          <h1>Loops</h1>
        </div>
        <p className="loops-sub">
          Tell Akorith a task in a sentence or two — research, monitoring, or building something. It
          works on it automatically, step by step, and you can steer it as it goes.
        </p>
      </header>

      {error && <div className="loop-note is-error">{error}</div>}

      <div className="loops-grid">
        <button
          type="button"
          className="loop-card loop-card-new"
          onClick={() => {
            setError(null)
            setView('create')
          }}
        >
          <span className="loop-plus">
            <PlusIcon size={28} />
          </span>
          <span className="loop-card-new-label">New loop</span>
        </button>

        {loops.map((loop) => {
          const f = friendlyStatus(loop)
          const commits = commitsOf(loop)
          return (
            <button key={loop.id} type="button" className="loop-card" onClick={() => openLoop(loop.id)}>
              <div className="loop-card-top">
                <span className={`loop-pill is-${f.tone}`}>{f.label}</span>
              </div>
              <div className="loop-card-title">{loopTitle(loop)}</div>
              <div className="loop-card-meta">
                {providerLabel(providers, loop.plannerProvider)} · {cadenceSummary(loop)} · {activitySummary(loop)}
              </div>
              <div className="loop-card-foot">
                <span>{commits.length} change{commits.length === 1 ? '' : 's'}</span>
                <span>{fmtDuration(Date.now() - loop.createdAt)}</span>
              </div>
            </button>
          )
        })}
      </div>

      {loops.length === 0 && (
        <div className="loop-empty loops-empty">No loops yet. Tap the ＋ card to start your first one.</div>
      )}
    </div>
  )
}
