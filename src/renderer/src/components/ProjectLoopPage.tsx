import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProjectLoop,
  ProjectLoopCommit,
  ProjectLoopEvent,
  ProjectLoopRun,
  ProjectLoopStatus,
  ProjectRow,
  ProviderInfo
} from '../../../preload/index.d'
import { FolderOpenIcon, LoopIcon, PlusIcon, SendIcon, StopIcon } from './icons'
import { ComposerSendButton } from './CreationPrimitives'
import LoopPipeline from './LoopPipeline'
import ModelPicker from './ModelPicker'

interface ProjectLoopPageProps {
  active: boolean
  activeProject: ProjectRow | null
}

interface LoopTarget {
  path: string
  name: string
  isRepo: boolean
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function statusLabel(status: ProjectLoopStatus, running: boolean): string {
  if (running) return 'Running'
  if (status === 'needs_review') return 'Needs review'
  if (status === 'completed') return 'Completed'
  if (status === 'paused') return 'Paused'
  if (status === 'error') return 'Blocked'
  return 'Ready'
}

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function loopStep(events: ProjectLoopEvent[], status: ProjectLoopStatus): number {
  if (status === 'completed') return 6
  const kinds = new Set(events.map((event) => event.kind))
  if (kinds.has('committed') || kinds.has('run_succeeded')) return 6
  if (kinds.has('validation_run') || kinds.has('patch_applied')) return 5
  if (kinds.has('patch_validated')) return 4
  if (kinds.has('patch_proposed')) return 3
  if (kinds.has('planned')) return 2
  return 1
}

function estimatedLoopStep(loop: ProjectLoop, running: boolean): number {
  if (loop.status === 'completed' || loop.commitCount > 0) return 6
  if (loop.status === 'needs_review' || loop.status === 'error') return 4
  if (running) return 3
  if (loop.runCount > 0) return 2
  return 1
}

function eventExplanation(event: ProjectLoopEvent): string {
  if (event.detail) return event.detail
  if (event.kind === 'planned') return 'The loop translated the outcome into a concrete project change.'
  if (event.kind === 'patch_proposed') return 'A candidate patch was prepared inside the selected repository boundary.'
  if (event.kind === 'patch_validated') return 'The proposed edits passed the safety and structure review.'
  if (event.kind === 'patch_applied') return 'The approved project changes were written to the working tree.'
  if (event.kind === 'validation_run') return 'Project checks were run before keeping a local checkpoint.'
  if (event.kind === 'committed') return 'A local Git checkpoint preserves this verified unit of work; nothing was pushed.'
  if (event.kind === 'run_failed' || event.kind === 'error') return 'The loop stopped here and is waiting for a model change, a clearer goal, or manual review.'
  return 'This signal advances the long-running outcome while keeping the work local and observable.'
}

export default function ProjectLoopPage({ active, activeProject }: ProjectLoopPageProps): JSX.Element {
  const [loops, setLoops] = useState<ProjectLoop[]>([])
  const [selectedLoopId, setSelectedLoopId] = useState<string | null>(null)
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set())
  const [creating, setCreating] = useState(false)
  const [target, setTarget] = useState<LoopTarget | null>(null)
  const [draft, setDraft] = useState('')
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [events, setEvents] = useState<ProjectLoopEvent[]>([])
  const [runs, setRuns] = useState<ProjectLoopRun[]>([])
  const [commits, setCommits] = useState<ProjectLoopCommit[]>([])
  const [error, setError] = useState<string | null>(null)
  const selectionInitialized = useRef(false)

  const loadProviders = useCallback(async (): Promise<void> => {
    const list = await window.api.chat.listProviders()
    const executors = list.filter((provider) => provider.available.ok && provider.kind.includes('executor'))
    setProviders(executors)
    setProviderId((current) => executors.some((provider) => provider.id === current) ? current : executors[0]?.id ?? '')
  }, [])

  const refreshFleet = useCallback(async (): Promise<void> => {
    const [stored, activeIds] = await Promise.all([
      window.api.projectLoop.list(),
      window.api.projectLoop.runningIds()
    ])
    const visible = stored.filter((loop) => loop.status !== 'archived')
    setLoops(visible)
    setRunningIds(new Set(activeIds))
    if (!selectionInitialized.current) {
      selectionInitialized.current = true
      if (visible[0]) setSelectedLoopId(visible[0].id)
      else setCreating(true)
    }
  }, [])

  const refreshDetails = useCallback(async (id: string): Promise<void> => {
    const [nextEvents, nextRuns, nextCommits] = await Promise.all([
      window.api.projectLoop.listEvents(id),
      window.api.projectLoop.listRuns(id),
      window.api.projectLoop.listCommits(id)
    ])
    setEvents([...nextEvents].reverse())
    setRuns(nextRuns)
    setCommits(nextCommits)
  }, [])

  useEffect(() => {
    if (!active) return
    void Promise.all([loadProviders(), refreshFleet()])
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [active, loadProviders, refreshFleet])

  useEffect(() => {
    if (!active || !selectedLoopId) return
    setEvents([])
    setRuns([])
    setCommits([])
    void refreshDetails(selectedLoopId)
  }, [active, refreshDetails, selectedLoopId])

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => {
      void refreshFleet()
      if (selectedLoopId) void refreshDetails(selectedLoopId)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [active, refreshDetails, refreshFleet, selectedLoopId])

  const selectedProvider = providers?.find((provider) => provider.id === providerId)
  const selectedLoop = loops.find((loop) => loop.id === selectedLoopId) ?? null
  const selectedRunning = Boolean(selectedLoop && runningIds.has(selectedLoop.id))
  const selectedLoopProviderId = selectedLoop?.localModelProvider
  const selectedLoopModel = selectedLoop?.localModel

  useEffect(() => {
    setModel((current) => selectedProvider?.models.includes(current) ? current : selectedProvider?.models[0] ?? '')
  }, [selectedProvider])

  useEffect(() => {
    if (!selectedLoopProviderId || !providers?.length) return
    const nextProvider = providers.find((provider) => provider.id === selectedLoopProviderId) ?? providers[0]
    setProviderId(nextProvider.id)
    setModel(nextProvider.models.includes(selectedLoopModel ?? '') ? selectedLoopModel ?? 'default' : nextProvider.models[0] ?? '')
  }, [providers, selectedLoopModel, selectedLoopProviderId])

  const startNewLoop = (): void => {
    setCreating(true)
    setSelectedLoopId(null)
    setTarget(null)
    setDraft('')
    setEvents([])
    setRuns([])
    setCommits([])
    setError(null)
  }

  const selectLoop = (id: string): void => {
    setCreating(false)
    setTarget(null)
    setDraft('')
    setError(null)
    setSelectedLoopId(id)
  }

  const chooseTarget = async (kind: 'folder' | 'repo' | 'current'): Promise<void> => {
    setError(null)
    try {
      const selectedPath = kind === 'current' ? activeProject?.path ?? null : await window.api.projectLoop.pickFolder()
      if (!selectedPath) return
      const inspected = await window.api.projectLoop.inspectTarget(selectedPath)
      if (kind === 'repo' && !inspected.isRepo) {
        setError('Choose a folder that already contains a Git repository.')
        return
      }
      setTarget(inspected)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const runLoop = useCallback((id: string): void => {
    setRunningIds((current) => new Set(current).add(id))
    setLoops((current) => current.map((loop) => loop.id === id ? { ...loop, status: 'active' } : loop))
    setError(null)
    void window.api.projectLoop.runGoal(id)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => {
        setRunningIds((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
        void refreshFleet()
        if (selectedLoopId === id) void refreshDetails(id)
      })
  }, [refreshDetails, refreshFleet, selectedLoopId])

  const submit = async (): Promise<void> => {
    const prompt = draft.trim()
    if (!prompt || !selectedProvider?.available.ok) return
    setDraft('')
    setError(null)
    try {
      if (selectedLoop && !creating) {
        if (selectedRunning) return
        await window.api.projectLoop.update(selectedLoop.id, {
          localModelProvider: providerId,
          localModel: model || 'default'
        })
        await window.api.projectLoop.editGoal(selectedLoop.id, prompt)
        setLoops((current) => current.map((loop) => loop.id === selectedLoop.id
          ? { ...loop, idea: prompt, title: prompt.replace(/\s+/g, ' ').slice(0, 80), status: 'active' }
          : loop))
        runLoop(selectedLoop.id)
        return
      }
      if (!target) return
      const created = await window.api.projectLoop.create({
        title: prompt.replace(/\s+/g, ' ').slice(0, 80),
        mode: target.isRepo ? 'repo_grower' : 'project_builder',
        localPath: target.path,
        idea: prompt,
        autonomy: 'assisted',
        safety: 'standard',
        scheduleKind: 'manual',
        localModelProvider: providerId,
        localModel: model || 'default',
        pushEnabled: false
      })
      await window.api.projectLoop.addBacklog(created.id, prompt.replace(/\s+/g, ' ').slice(0, 160), prompt)
      setLoops((current) => [created, ...current])
      setSelectedLoopId(created.id)
      setCreating(false)
      setTarget(null)
      runLoop(created.id)
    } catch (reason) {
      setDraft(prompt)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const pauseLoop = async (id: string): Promise<void> => {
    await window.api.projectLoop.pauseGoal(id)
    setRunningIds((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
    void refreshFleet()
    if (selectedLoopId === id) void refreshDetails(id)
  }

  const archiveSelected = async (): Promise<void> => {
    if (!selectedLoop) return
    if (selectedRunning) await window.api.projectLoop.pauseGoal(selectedLoop.id)
    await window.api.projectLoop.archive(selectedLoop.id)
    const remaining = loops.filter((loop) => loop.id !== selectedLoop.id)
    setLoops(remaining)
    setSelectedLoopId(remaining[0]?.id ?? null)
    setCreating(remaining.length === 0)
    setError(null)
  }

  const activeCount = loops.filter((loop) => runningIds.has(loop.id)).length
  const reviewCount = loops.filter((loop) => loop.status === 'needs_review' || loop.status === 'error').length
  const completedCount = loops.filter((loop) => loop.status === 'completed').length
  const selectedStep = selectedLoop ? loopStep(events, selectedLoop.status) : 1
  const lastRun = runs[0]
  const selectedElapsed = selectedLoop
    ? elapsedLabel(Math.max(0, (selectedRunning ? Date.now() : lastRun?.endedAt ?? selectedLoop.updatedAt) - (lastRun?.startedAt ?? selectedLoop.createdAt)))
    : '0s'
  const composerTarget = selectedLoop
    ? { path: selectedLoop.localPath, name: projectName(selectedLoop.localPath), isRepo: selectedLoop.mode !== 'project_builder' }
    : target
  const canSend = Boolean(composerTarget && draft.trim() && selectedProvider?.available.ok && !selectedRunning)

  const composer = composerTarget ? (
    <div className="composer loop-composer">
      <div className="composer-box">
        <textarea
          className="composer-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }}
          placeholder={selectedLoop ? `Give ${composerTarget.name} another outcome…` : `Describe the first outcome for ${composerTarget.name}…`}
          rows={2}
          spellCheck={false}
        />
        <div className="composer-controls">
          <div className="composer-controls-left">
            <ModelPicker
              providers={providers}
              providerId={providerId}
              model={model}
              disabled={selectedRunning}
              onSelect={(nextProvider, nextModel) => { setProviderId(nextProvider); setModel(nextModel) }}
              onRefresh={() => void loadProviders()}
            />
            <span className="composer-chip loop-target-chip"><FolderOpenIcon size={13} />{composerTarget.name}</span>
          </div>
          {selectedRunning && selectedLoop
            ? <ComposerSendButton stop onClick={() => void pauseLoop(selectedLoop.id)}><StopIcon size={16} /></ComposerSendButton>
            : <ComposerSendButton disabled={!canSend} onClick={() => void submit()}><SendIcon size={16} /></ComposerSendButton>}
        </div>
      </div>
      <div className="composer-info">loop {composerTarget.name} · {selectedProvider?.label ?? 'model'} · concurrent local worker · push off</div>
    </div>
  ) : null

  return (
    <main className="loop-page">
      <header className="loop-board-header">
        <div>
          <span className="loop-eyebrow">AUTONOMOUS PROJECT LOOPS</span>
          <h1>Loop control</h1>
          <p>Run several durable outcomes at once. Each loop owns one folder, one model and an independent local history.</p>
        </div>
        <div className="loop-board-actions">
          <div className="loop-board-metrics" aria-label="Loop summary">
            <span><strong>{activeCount}</strong> running</span>
            <span><strong>{reviewCount}</strong> review</span>
            <span><strong>{completedCount}</strong> done</span>
          </div>
          <button type="button" className="loop-new-button" onClick={startNewLoop}><PlusIcon size={15} />New loop</button>
        </div>
      </header>

      <div className="loop-board">
        <aside className="loop-fleet" aria-label="Project loops">
          <div className="loop-fleet-title"><span>LOOP FLEET</span><em>{loops.length}</em></div>
          <div className="loop-card-list">
            {loops.map((loop) => {
              const isRunning = runningIds.has(loop.id)
              const isSelected = loop.id === selectedLoopId && !creating
              const cardStep = loop.id === selectedLoopId ? selectedStep : estimatedLoopStep(loop, isRunning)
              return (
                <button type="button" className={`loop-card ${isSelected ? 'is-selected' : ''}`} onClick={() => selectLoop(loop.id)} key={loop.id}>
                  <span className="loop-card-top"><span className={`loop-status is-${isRunning ? 'running' : loop.status}`}><i />{statusLabel(loop.status, isRunning)}</span><em>{projectName(loop.localPath)}</em></span>
                  <strong>{loop.title}</strong>
                  <LoopPipeline step={cardStep} status={loop.status} compact />
                  <span className="loop-card-foot"><span>{loop.commitCount} commits</span><span>{loop.runCount} runs</span><span>{loop.localModel ?? 'default'}</span></span>
                </button>
              )
            })}
            {loops.length === 0 && <div className="loop-fleet-empty">No loops yet. Start one from a local folder or repository.</div>}
          </div>
        </aside>

        <section className="loop-focus">
          {creating ? (
            !target ? (
              <div className="loop-target-picker">
                <span className="loop-eyebrow">NEW INDEPENDENT LOOP</span>
                <h2>Choose its project boundary</h2>
                <p>This loop can run beside every other loop without sharing its model, status or local history.</p>
                <div className="loop-target-actions">
                  {activeProject?.path && <button type="button" className="ws-hero-btn is-primary" onClick={() => void chooseTarget('current')}><FolderOpenIcon size={16} />Use {activeProject.name}</button>}
                  <button type="button" className={`ws-hero-btn ${activeProject?.path ? '' : 'is-primary'}`} onClick={() => void chooseTarget('folder')}><FolderOpenIcon size={16} />Choose folder</button>
                  <button type="button" className="ws-hero-btn" onClick={() => void chooseTarget('repo')}><LoopIcon size={16} />Choose repository</button>
                </div>
                {error && <div className="loop-inline-error">{error}</div>}
              </div>
            ) : (
              <div className="loop-create-ready">
                <span className="loop-eyebrow">{target.isRepo ? 'GIT REPOSITORY' : 'LOCAL FOLDER'} · {target.name}</span>
                <h2>What outcome should this loop own?</h2>
                <p>Start it below, then create another loop immediately. Both can keep working at the same time.</p>
                {error && <div className="loop-inline-error">{error}</div>}
                <div className="loop-focus-composer">{composer}</div>
              </div>
            )
          ) : selectedLoop ? (
            <>
              <div className="loop-focus-head">
                <div>
                  <span className={`loop-status is-${selectedRunning ? 'running' : selectedLoop.status}`}><i />{statusLabel(selectedLoop.status, selectedRunning)}</span>
                  <h2>{selectedLoop.title}</h2>
                  <p>{projectName(selectedLoop.localPath)} · {selectedLoop.localModelProvider} · {selectedLoop.localModel ?? 'default'}</p>
                </div>
                <div className="loop-focus-controls">
                  <span>{selectedRunning ? 'Working for' : 'Worked for'} <strong>{selectedElapsed}</strong></span>
                  {selectedRunning && <button type="button" onClick={() => void pauseLoop(selectedLoop.id)}>Pause</button>}
                  {!selectedRunning && <button type="button" onClick={() => void archiveSelected()}>Archive</button>}
                </div>
              </div>

              <div className="loop-map-panel">
                <div className="loop-panel-heading"><div><span>EXECUTION MAP</span><strong>Independent six-stage cycle</strong></div><em>Step {selectedStep} / 6</em></div>
                <LoopPipeline step={selectedStep} status={selectedLoop.status} />
              </div>

              <div className="loop-signal-panel">
                <div className="loop-panel-heading"><div><span>LIVE SIGNALS</span><strong>What this loop is doing</strong></div><em>{events.length} events</em></div>
                <div className="loop-signal-list" aria-live="polite">
                  {events.slice(-8).reverse().map((event) => (
                    <article className={`loop-signal is-${event.kind}`} key={event.id}>
                      <span className="loop-signal-node" />
                      <div><strong>{event.message}</strong><p>{eventExplanation(event)}</p></div>
                      <time>{new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                    </article>
                  ))}
                  {events.length === 0 && <div className="loop-signal-empty">Waiting for the first durable loop signal.</div>}
                </div>
              </div>

              {!selectedRunning && (lastRun?.summary || selectedLoop.error) && (
                <div className={`loop-outcome ${selectedLoop.status === 'error' || selectedLoop.status === 'needs_review' ? 'is-error' : ''}`}>
                  <span>OUTCOME</span>
                  <strong>{lastRun?.summary || selectedLoop.error}</strong>
                  <p>{commits.length} local commit{commits.length === 1 ? '' : 's'} · {lastRun?.filesChanged ?? 0} changed files · push off</p>
                </div>
              )}
              {error && <div className="loop-inline-error">{error}</div>}
              <div className="loop-focus-composer">{composer}</div>
            </>
          ) : (
            <div className="loop-target-picker"><h2>Select a loop or start a new one</h2></div>
          )}
        </section>
      </div>
    </main>
  )
}
