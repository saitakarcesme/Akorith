import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MacroSessionRow, MacroState, ProviderInfo } from '../../../preload/index.d'
import { LoopIcon, PlusIcon, ChevronIcon } from './icons'

// Phase 21: the Loop section. A deliberately non-technical home for auto-commit
// project generation. You describe a project in a sentence or two; Akorith
// scaffolds a git repo, builds it, and saves every change as a "Phase N" step.
// The macro/critic/token machinery from Phases 19–20 runs underneath — none of
// it is exposed here.

type View = 'list' | 'create' | 'detail'

interface AutoAction {
  type: string
  phase?: number
  message?: string
  reason?: string
  at?: number
}

// Logical executor terminal (t1 = Atlantis / Claude). Hidden from the user.
const EXECUTOR = 't1'
const EXECUTOR_KIND = 'claude'

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

  // Live one-second tick for elapsed timers.
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])

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

  // Ensure the (hidden) executor agent is running in the loop's folder.
  const ensureExecutor = useCallback(async (project: { id: string }, cwd: string): Promise<void> => {
    const key = projectKey(project.id)
    window.api.pty.setActiveProject(key)
    await window.api.pty.create(`${EXECUTOR}::${key}`, { cols: 120, rows: 32, cwd, commandKind: EXECUTOR_KIND })
  }, [])

  const createLoop = useCallback(async (): Promise<void> => {
    const text = description.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      setBusyNote('Choosing how to build it…')
      const providers = await window.api.chat.listProviders()
      const planner = providers.find((p: ProviderInfo) => p.available.ok)
      if (!planner) {
        setError('No AI engine is available yet. Start Ollama (or sign in to a coding CLI) and try again.')
        return
      }
      setBusyNote('Inventing and scaffolding your project…')
      const res = await window.api.macro.createWorkspaceProject({
        seed: text,
        plannerProvider: planner.id,
        plannerModel: planner.models[0] || undefined,
        targetTerminal: EXECUTOR
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setBusyNote('Waking up the builder…')
      await ensureExecutor(res.project, res.workspaceDir)
      await new Promise((r) => setTimeout(r, 3500))
      setBusyNote('Starting the loop…')
      await window.api.macro.startAuto(res.state.session.id)
      setDescription('')
      setSelectedId(res.state.session.id)
      setDetail(res.state)
      setView('detail')
      void refreshLoops()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setBusyNote('')
    }
  }, [description, busy, ensureExecutor, refreshLoops])

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

  const resumeLoop = useCallback(async (session: MacroSessionRow): Promise<void> => {
    if (!session.workspaceDir) return
    setBusy(true)
    try {
      // The executor may have exited (e.g. after a restart) — bring it back first.
      // Its terminal key comes from the project (matched by its folder), not the session.
      const projects = await window.api.projects.list()
      const proj = projects.find((p) => p.path === session.workspaceDir)
      if (proj) {
        await ensureExecutor({ id: proj.id }, session.workspaceDir)
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

  const selected = detail?.session ?? loops.find((l) => l.id === selectedId) ?? null

  // ---------- detail view ----------
  if (view === 'detail' && selected) {
    const f = friendlyStatus(selected)
    const commits = commitsOf(selected)
    const elapsed = fmtDuration(Date.now() - selected.createdAt)
    const isRunning = RUNNING.has(selected.status)
    const isPaused = PAUSED.has(selected.status)
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

          {selected.pauseReason && isPaused && (
            <div className="loop-note">Paused: {selected.pauseReason.replace(/_/g, ' ')}. Resume when you're ready.</div>
          )}
          {selected.status === 'error' && selected.stopReason && (
            <div className="loop-note is-error">{selected.stopReason}</div>
          )}

          <div className="loop-actions">
            {isRunning && (
              <button type="button" className="loop-btn is-stop" onClick={() => void stopLoop(selected.id)}>
                Pause loop
              </button>
            )}
            {(isPaused || selected.status === 'idle') && (
              <button type="button" className="loop-btn is-primary" disabled={busy} onClick={() => void resumeLoop(selected)}>
                {busy ? 'Resuming…' : 'Resume loop'}
              </button>
            )}
          </div>

          <h2 className="loop-section-title">Progress</h2>
          {commits.length === 0 ? (
            <div className="loop-empty">
              {isRunning ? 'Working on the first change… this can take a minute.' : 'No changes saved yet.'}
            </div>
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
    return (
      <div className="loops-page">
        <button type="button" className="loop-back" onClick={() => !busy && setView('list')}>
          <ChevronIcon size={16} direction="left" /> All loops
        </button>
        <div className="loop-create">
          <h1>Start a new loop</h1>
          <p className="loops-sub">Describe what you'd like to build in a sentence or two. That's it — Akorith does the rest.</p>
          <textarea
            className="loop-create-input"
            rows={4}
            autoFocus
            disabled={busy}
            value={description}
            placeholder="e.g. A little command-line tool that renames messy photo files by date. Keep it simple."
            onChange={(e) => setDescription(e.target.value)}
          />
          {error && <div className="loop-note is-error">{error}</div>}
          <div className="loop-actions">
            <button
              type="button"
              className="loop-btn is-primary is-big"
              disabled={!description.trim() || busy}
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
          Describe a small project in a sentence or two. Akorith builds it for you and saves every change as a step.
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
