import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProjectLoop, ProjectLoopCommit, ProjectLoopEvent, ProjectLoopRun, ProjectRow } from '../../../preload/index.d'
import { PauseIcon, PlayIcon, SparkIcon, StopIcon } from './icons'
import { formatModelLabel } from '../modelLabels'

interface ProjectLoopPageProps {
  active: boolean
  activeProject: ProjectRow | null
}

interface GoalModelOption {
  id: string
  providerId: string
  model: string
  label: string
}

function statusLabel(status: ProjectLoop['status']): string {
  if (status === 'needs_review') return 'Needs review'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

export default function ProjectLoopPage({ active, activeProject }: ProjectLoopPageProps): JSX.Element {
  const [goal, setGoal] = useState('')
  const [models, setModels] = useState<GoalModelOption[]>([])
  const [model, setModel] = useState('')
  const [loop, setLoop] = useState<ProjectLoop | null>(null)
  const [events, setEvents] = useState<ProjectLoopEvent[]>([])
  const [runs, setRuns] = useState<ProjectLoopRun[]>([])
  const [commits, setCommits] = useState<ProjectLoopCommit[]>([])
  const [running, setRunning] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (id: string): Promise<void> => {
    const [nextLoop, nextEvents, nextRuns, nextCommits] = await Promise.all([
      window.api.projectLoop.get(id),
      window.api.projectLoop.listEvents(id),
      window.api.projectLoop.listRuns(id),
      window.api.projectLoop.listCommits(id)
    ])
    setLoop(nextLoop)
    setEvents(nextEvents)
    setRuns(nextRuns)
    setCommits(nextCommits)
    if (nextLoop && nextLoop.status !== 'active') setRunning(false)
  }, [])

  useEffect(() => {
    if (!active) return
    void Promise.all([window.api.chat.listProviders(), window.api.projectLoop.list()])
      .then(([providers, loops]) => {
        const available = providers
          .filter((provider) => provider.available.ok && provider.kind.includes('executor'))
          .flatMap((provider) => (provider.models.length ? provider.models : ['default']).map((modelId) => ({
            id: `${provider.id}::${modelId}`,
            providerId: provider.id,
            model: modelId,
            label: `${provider.label} · ${formatModelLabel(modelId, provider.id)}`
          })))
        setModels(available)
        setModel((current) => current || available[0]?.id || '')
        const restored = activeProject?.path
          ? loops.find((item) => item.localPath === activeProject.path && item.status !== 'archived') ?? null
          : null
        if (restored) {
          setLoop(restored)
          setGoal(restored.idea ?? restored.title)
          setModel(`${restored.localModelProvider}::${restored.localModel ?? 'default'}`)
          void refresh(restored.id)
        } else {
          setLoop(null)
          setEvents([])
          setRuns([])
          setCommits([])
        }
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [active, activeProject?.path, refresh])

  useEffect(() => {
    if (!active || !loop || (!running && loop.status !== 'active')) return
    const timer = window.setInterval(() => void refresh(loop.id), 1000)
    return () => window.clearInterval(timer)
  }, [active, loop?.id, loop?.status, running, refresh])

  const runGoal = useCallback((id: string): void => {
    setRunning(true)
    setError(null)
    void window.api.projectLoop.runGoal(id)
      .then(() => refresh(id))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setRunning(false))
  }, [refresh])

  const start = async (): Promise<void> => {
    const selectedModel = models.find((item) => item.id === model)
    if (!activeProject?.path || !goal.trim() || !selectedModel) return
    setError(null)
    try {
      const created = await window.api.projectLoop.create({
        title: goal.trim().replace(/\s+/g, ' ').slice(0, 80),
        mode: 'repo_grower',
        localPath: activeProject.path,
        idea: goal.trim(),
        autonomy: 'assisted',
        safety: 'standard',
        scheduleKind: 'manual',
        localModelProvider: selectedModel.providerId,
        localModel: selectedModel.model,
        pushEnabled: false
      })
      await window.api.projectLoop.addBacklog(created.id, goal.trim().replace(/\s+/g, ' ').slice(0, 160), goal.trim())
      setLoop(created)
      runGoal(created.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const pause = async (): Promise<void> => {
    if (!loop) return
    await window.api.projectLoop.pauseGoal(loop.id)
    setRunning(false)
    void refresh(loop.id)
  }

  const saveEdit = async (): Promise<void> => {
    if (!loop || !goal.trim()) return
    await window.api.projectLoop.editGoal(loop.id, goal.trim())
    setEditing(false)
    void refresh(loop.id)
  }

  const clear = async (): Promise<void> => {
    if (!loop) return
    await window.api.projectLoop.pauseGoal(loop.id)
    await window.api.projectLoop.archive(loop.id)
    setLoop(null)
    setGoal('')
    setEvents([])
    setRuns([])
    setCommits([])
    setRunning(false)
  }

  const visibleEvents = events.slice(-8)
  const completedSteps = events.filter((event) => ['inspected', 'planned', 'patch_proposed', 'patch_validated', 'patch_applied', 'committed'].includes(event.kind)).length
  const step = running ? Math.min(6, Math.max(1, completedSteps + 1)) : loop?.status === 'completed' ? 6 : Math.min(6, Math.max(1, completedSteps))
  const lastRun = runs.at(-1)
  const summary = useMemo(() => lastRun?.summary || events.at(-1)?.message || 'Waiting to begin', [events, lastRun])

  return (
    <main className="goal-page">
      <div className="goal-page-inner">
        <header className="goal-header">
          <div><span>LONG-RUNNING WORK</span><h1>Goal</h1><p>Give Akorith one concrete outcome. It keeps working locally until the result is complete or needs your review.</p></div>
          {activeProject?.path && <code>{activeProject.name}</code>}
        </header>

        {!activeProject?.path ? (
          <div className="goal-empty"><SparkIcon size={22} /><h2>Open a project first</h2><p>Goals are always scoped to one local project folder.</p></div>
        ) : !loop ? (
          <section className="goal-create">
            <label htmlFor="goal-input">What should Akorith finish?</label>
            <textarea id="goal-input" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Example: Add profile photo upload, verify it in Electron, and make all relevant tests pass." rows={5} />
            <div className="goal-create-footer">
              <label>Model · local CLI<select value={model} onChange={(event) => setModel(event.target.value)}>{models.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
              <button type="button" className="goal-primary" disabled={!goal.trim() || !model} onClick={() => void start()}><PlayIcon size={15} />Start goal</button>
            </div>
          </section>
        ) : (
          <>
            <section className={`goal-progress is-${loop.status}`}>
              <div className="goal-progress-top">
                <div className="goal-pulse"><span /></div>
                <div className="goal-progress-copy"><span>{running ? 'Akorithing…' : statusLabel(loop.status)}</span>{editing ? <textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} /> : <strong>{loop.idea ?? loop.title}</strong>}</div>
                <div className="goal-step"><i />Step {step} / 6</div>
              </div>
              <div className="goal-actions">
                {editing ? <button type="button" onClick={() => void saveEdit()}>Save goal</button> : <button type="button" onClick={() => setEditing(true)} disabled={running}>Edit</button>}
                {running ? <button type="button" onClick={() => void pause()}><PauseIcon size={13} />Pause</button> : loop.status !== 'completed' && <button type="button" onClick={() => runGoal(loop.id)}><PlayIcon size={13} />Resume</button>}
                <button type="button" className="is-danger" onClick={() => void clear()}><StopIcon size={13} />Clear</button>
              </div>
            </section>

            <section className="goal-live">
              <div className="goal-live-head"><div><span>LIVE PROGRESS</span><h2>{summary}</h2></div><em>{commits.length} commit{commits.length === 1 ? '' : 's'} · {runs.length} attempt{runs.length === 1 ? '' : 's'}</em></div>
              <div className="goal-event-list">
                {visibleEvents.map((event) => <div className={`goal-event is-${event.kind}`} key={event.id}><i /><div><strong>{event.message}</strong>{event.detail && <span>{event.detail}</span>}</div><time>{new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>)}
                {visibleEvents.length === 0 && <div className="goal-event is-waiting"><i /><div><strong>Preparing the first step</strong></div></div>}
              </div>
              {lastRun && <div className="goal-result"><span>Latest result</span><strong>{lastRun.status}</strong><em>{lastRun.filesChanged} files · {lastRun.commandsRun} checks</em>{lastRun.error && <p>{lastRun.error}</p>}</div>}
            </section>
          </>
        )}
        {error && <div className="goal-error">{error}</div>}
      </div>
    </main>
  )
}
