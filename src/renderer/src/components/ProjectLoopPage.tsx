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
import { ArchiveIcon, FolderOpenIcon, LoopIcon, PlusIcon, SendIcon, StopIcon } from './icons'
import { ComposerSendButton } from './CreationPrimitives'
import LoopPipeline, { type LoopCyclePhase } from './LoopPipeline'
import ModelPicker from './ModelPicker'
import { ProjectPreviewPanel } from './ProjectPreviewPanel'

interface ProjectLoopPageProps {
  active: boolean
  activeProject: ProjectRow | null
}

interface LoopTarget {
  path: string
  name: string
  isRepo: boolean
  repoUrl?: string
  githubOwner?: string
  githubName?: string
}

interface GoalContract {
  summary?: string
  deliverables?: string[]
  acceptanceCriteria?: string[]
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function loopProjectFolderName(prompt: string): string {
  const slug = prompt
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'akorith-loop-project'
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  return `${slug}-${stamp}`
}

function statusLabel(status: ProjectLoopStatus, running: boolean): string {
  if (running) return 'Running'
  if (status === 'needs_review') return 'Needs review'
  if (status === 'completed') return 'Goal reached'
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

function phaseFor(events: ProjectLoopEvent[], status: ProjectLoopStatus): LoopCyclePhase {
  if (status === 'completed') return 'analyze'
  const latest = [...events].reverse().find((event) => [
    'goal_understood', 'inspected', 'planned', 'run_started', 'execution_started', 'patch_proposed', 'patch_validated',
    'patch_applied', 'validation_run', 'committed', 'run_succeeded', 'analysis_started', 'analyzed', 'replanned'
  ].includes(event.kind))
  if (!latest || latest.kind === 'goal_understood') return 'understand'
  if (latest.kind === 'inspected' || latest.kind === 'planned' || latest.kind === 'run_started') return 'plan'
  if (latest.kind === 'analysis_started' || latest.kind === 'analyzed') return 'analyze'
  if (latest.kind === 'replanned') return 'replan'
  return 'execute'
}

function phaseCopy(phase: LoopCyclePhase, running: boolean): { title: string; body: string } {
  if (phase === 'understand') return { title: 'Understanding the Goal', body: 'Turning the request into a clear outcome and definition of done.' }
  if (phase === 'plan') return { title: 'Planning the next action', body: 'Choosing one useful step that can be checked afterward.' }
  if (phase === 'execute') return { title: running ? 'Executing the plan' : 'Execution checkpointed', body: 'Working inside the selected folder and recording concrete evidence.' }
  if (phase === 'analyze') return { title: 'Checking the result', body: 'Comparing the latest evidence with the complete Goal.' }
  return { title: 'Closing the remaining gap', body: 'Returning to Plan with the most important unfinished item.' }
}

function parseContract(raw?: string): GoalContract | null {
  if (!raw?.startsWith('{')) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    return {
      summary: typeof value.summary === 'string' ? value.summary : undefined,
      deliverables: Array.isArray(value.deliverables) ? value.deliverables.filter((item): item is string => typeof item === 'string').slice(0, 4) : undefined,
      acceptanceCriteria: Array.isArray(value.acceptanceCriteria) ? value.acceptanceCriteria.filter((item): item is string => typeof item === 'string').slice(0, 4) : undefined
    }
  } catch {
    return null
  }
}

function usefulEvents(events: ProjectLoopEvent[]): ProjectLoopEvent[] {
  return events.filter((event) => [
    'goal_understood', 'planned', 'execution_started', 'committed', 'pushed', 'analyzed', 'replanned', 'goal_completed', 'error', 'run_failed', 'note'
  ].includes(event.kind)).slice(-12)
}

interface LoopProgressStep {
  id: string
  kind: ProjectLoopEvent['kind']
  title: string
  body: string
  createdAt: number
}

function readableEvidence(value?: string): string | undefined {
  const text = value?.trim()
  if (!text) return undefined
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const candidates = [parsed.summary, parsed.objective, parsed.reason, parsed.result]
      const sentence = candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
      if (sentence) return sentence.trim()
      const evidence = Array.isArray(parsed.completedEvidence)
        ? parsed.completedEvidence.filter((item): item is string => typeof item === 'string').slice(0, 2)
        : []
      if (evidence.length) return evidence.join(' ')
    } catch {
      return undefined
    }
  }
  return text.replace(/\s+/g, ' ')
}

function progressStep(event: ProjectLoopEvent, iteration: number): LoopProgressStep {
  const titles: Partial<Record<ProjectLoopEvent['kind'], string>> = {
    goal_understood: 'Goal understood',
    planned: 'Plan prepared',
    execution_started: `Executing cycle ${iteration}`,
    committed: 'Checkpoint committed',
    pushed: 'Checkpoint pushed to GitHub',
    analyzed: 'Result analyzed',
    replanned: 'Remaining work replanned',
    goal_completed: 'Goal reached',
    error: 'Loop needs attention',
    run_failed: 'Cycle stopped',
    note: 'Progress update'
  }
  const defaults: Partial<Record<ProjectLoopEvent['kind'], string>> = {
    goal_understood: 'Akorith converted the request into a concrete outcome and a definition of done.',
    planned: 'The next verifiable action was selected from the remaining work.',
    execution_started: 'The selected model started working inside the scoped repository.',
    committed: 'Verified changes were saved as a local Git checkpoint.',
    pushed: 'The verified checkpoint was synchronized with the repository origin.',
    analyzed: 'The latest files, tests, and evidence were checked against the complete Goal.',
    replanned: 'The next cycle now focuses on the most important unfinished requirement.',
    goal_completed: 'All required evidence now matches the requested outcome.',
    error: 'Akorith preserved the completed work and recorded what needs review.',
    run_failed: 'The cycle ended before verification completed; existing checkpoints remain intact.',
    note: 'Akorith recorded a meaningful update from the current cycle.'
  }
  const detail = readableEvidence(event.detail)
  const message = readableEvidence(event.message)
  const body = detail ?? message ?? defaults[event.kind] ?? 'Akorith recorded progress for this Goal.'
  return {
    id: event.id,
    kind: event.kind,
    title: titles[event.kind] ?? 'Goal progress',
    body: body.length > 360 ? `${body.slice(0, 357).trimEnd()}…` : body,
    createdAt: event.createdAt
  }
}

export default function ProjectLoopPage({ active, activeProject }: ProjectLoopPageProps): JSX.Element {
  const [loops, setLoops] = useState<ProjectLoop[]>([])
  const [selectedLoopId, setSelectedLoopId] = useState<string | null>(null)
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set())
  const [creating, setCreating] = useState(false)
  const [target, setTarget] = useState<LoopTarget | null>(null)
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [repositoryFormOpen, setRepositoryFormOpen] = useState(false)
  const [cloningRepository, setCloningRepository] = useState(false)
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
    const [stored, activeIds] = await Promise.all([window.api.projectLoop.list(), window.api.projectLoop.runningIds()])
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
    void Promise.all([loadProviders(), refreshFleet()]).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
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

  useEffect(() => {
    setModel((current) => selectedProvider?.models.includes(current) ? current : selectedProvider?.models[0] ?? '')
  }, [selectedProvider])

  useEffect(() => {
    if (!selectedLoop?.localModelProvider || !providers?.length) return
    const nextProvider = providers.find((provider) => provider.id === selectedLoop.localModelProvider) ?? providers[0]
    setProviderId(nextProvider.id)
    setModel(nextProvider.models.includes(selectedLoop.localModel ?? '') ? selectedLoop.localModel ?? 'default' : nextProvider.models[0] ?? '')
  }, [providers, selectedLoop?.localModel, selectedLoop?.localModelProvider])

  const startNewLoop = (): void => {
    setCreating(true)
    setSelectedLoopId(null)
    setTarget(null)
    setRepositoryUrl('')
    setRepositoryFormOpen(false)
    setDraft('')
    setEvents([])
    setRuns([])
    setCommits([])
    setError(null)
  }

  const chooseCurrentTarget = async (): Promise<void> => {
    setError(null)
    try {
      const selectedPath = activeProject?.path ?? null
      if (!selectedPath) return
      const inspected = await window.api.projectLoop.inspectTarget(selectedPath)
      setTarget(inspected)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const cloneRepository = async (): Promise<void> => {
    setError(null)
    setCloningRepository(true)
    try {
      const cloned = await window.api.projectLoop.cloneRepository(repositoryUrl)
      setTarget(cloned)
      setRepositoryFormOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCloningRepository(false)
    }
  }

  const runLoop = useCallback((id: string): void => {
    setRunningIds((current) => new Set(current).add(id))
    setLoops((current) => current.map((loop) => loop.id === id ? { ...loop, status: 'active' } : loop))
    setError(null)
    void window.api.projectLoop.runGoal(id)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => {
        setRunningIds((current) => { const next = new Set(current); next.delete(id); return next })
        void refreshFleet()
        void refreshDetails(id)
      })
  }, [refreshDetails, refreshFleet])

  const submit = async (): Promise<void> => {
    const prompt = draft.trim()
    if (!prompt || !selectedProvider?.available.ok) return
    setDraft('')
    setError(null)
    try {
      if (selectedLoop && !creating) {
        if (selectedRunning) return
        await window.api.projectLoop.update(selectedLoop.id, { localModelProvider: providerId, localModel: model || 'default' })
        await window.api.projectLoop.editGoal(selectedLoop.id, prompt)
        runLoop(selectedLoop.id)
        return
      }
      if (!target) return
      const centralLoopRepository = target.githubOwner?.toLowerCase() === 'saitakarcesme' && target.githubName?.toLowerCase() === 'akorithloop'
      const workspaceFolder = centralLoopRepository ? loopProjectFolderName(prompt) : null
      const scopedPrompt = workspaceFolder
        ? `Work only inside the new \`${workspaceFolder}/\` folder in this repository. Do not modify other project folders.\n\nGoal: ${prompt}`
        : prompt
      const created = await window.api.projectLoop.create({
        title: prompt.replace(/\s+/g, ' ').slice(0, 80),
        mode: target.repoUrl ? 'github_loop' : target.isRepo ? 'repo_grower' : 'project_builder',
        localPath: target.path,
        repoUrl: target.repoUrl,
        githubOwner: target.githubOwner,
        githubName: target.githubName,
        idea: scopedPrompt,
        autonomy: 'assisted',
        safety: 'standard',
        scheduleKind: 'manual',
        localModelProvider: providerId,
        localModel: model || 'default',
        pushEnabled: Boolean(target.repoUrl)
      })
      await window.api.projectLoop.addBacklog(created.id, prompt.replace(/\s+/g, ' ').slice(0, 160), scopedPrompt)
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
    setRunningIds((current) => { const next = new Set(current); next.delete(id); return next })
    void refreshFleet()
    void refreshDetails(id)
  }

  const archiveSelected = async (): Promise<void> => {
    if (!selectedLoop) return
    if (selectedRunning) await window.api.projectLoop.pauseGoal(selectedLoop.id)
    await window.api.projectLoop.archive(selectedLoop.id)
    const remaining = loops.filter((loop) => loop.id !== selectedLoop.id)
    setLoops(remaining)
    setSelectedLoopId(remaining[0]?.id ?? null)
    setCreating(remaining.length === 0)
  }

  const phase = selectedLoop ? phaseFor(events, selectedLoop.status) : 'understand'
  const currentCopy = phaseCopy(phase, selectedRunning)
  const contract = parseContract(selectedLoop?.roadmapSummary)
  const lastRun = runs[0]
  const recentEvents = useMemo(() => usefulEvents(events), [events])
  const iteration = Math.max(1, lastRun?.runIndex ?? selectedLoop?.runCount ?? 1)
  const progressSteps = useMemo(() => {
    const seen = new Set<string>()
    return recentEvents
      .map((event) => progressStep(event, iteration))
      .filter((step) => {
        const signature = `${step.title}\n${step.body}`
        if (seen.has(signature)) return false
        seen.add(signature)
        return true
      })
  }, [iteration, recentEvents])
  const selectedElapsed = selectedLoop
    ? elapsedLabel(Math.max(0, (selectedRunning ? Date.now() : lastRun?.endedAt ?? selectedLoop.updatedAt) - (lastRun?.startedAt ?? selectedLoop.createdAt)))
    : '0s'
  const composerTarget = selectedLoop ? { path: selectedLoop.localPath, name: selectedLoop.githubName ?? projectName(selectedLoop.localPath), isRepo: selectedLoop.mode !== 'project_builder' } : target
  const canSend = Boolean(composerTarget && draft.trim() && selectedProvider?.available.ok && !selectedRunning)

  const composer = composerTarget ? (
    <div className="composer loop-composer">
      <div className="composer-box">
        <textarea
          className="composer-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }}
          placeholder={selectedLoop ? 'Refine this Goal or give it a new outcome…' : 'Describe one complete Goal…'}
          rows={2}
          spellCheck={false}
        />
        <div className="composer-controls">
          <div className="composer-controls-left">
            <ModelPicker providers={providers} providerId={providerId} model={model} disabled={selectedRunning} onSelect={(nextProvider, nextModel) => { setProviderId(nextProvider); setModel(nextModel) }} onRefresh={() => void loadProviders()} />
            <span className="composer-chip loop-target-chip"><FolderOpenIcon size={13} />{composerTarget.name}</span>
          </div>
          {selectedRunning && selectedLoop
            ? <ComposerSendButton stop onClick={() => void pauseLoop(selectedLoop.id)}><StopIcon size={16} /></ComposerSendButton>
            : <ComposerSendButton disabled={!canSend} onClick={() => void submit()}><SendIcon size={16} /></ComposerSendButton>}
        </div>
      </div>
      <div className="composer-info">Goal · {composerTarget.name} · local checkpointing · {selectedLoop?.pushEnabled || target?.repoUrl ? 'GitHub sync on' : 'local only'}</div>
    </div>
  ) : null

  return (
    <main className="loop-page loop-page-v2">
      <header className="loop-v2-header">
        <span className="loop-eyebrow">CONCURRENT GOALS</span>
        <button type="button" className="loop-new-button" onClick={startNewLoop}><PlusIcon size={15} />New tab</button>
      </header>

      {loops.length > 0 && (
        <nav className="loop-switcher" aria-label="Concurrent Goals">
          {loops.map((loop) => {
            const running = runningIds.has(loop.id)
            return <button type="button" className={loop.id === selectedLoopId && !creating ? 'is-selected' : ''} onClick={() => { setCreating(false); setSelectedLoopId(loop.id); setError(null) }} key={loop.id}><i className={`is-${running ? 'running' : loop.status}`} /><span>{loop.title}</span><em>{statusLabel(loop.status, running)}</em></button>
          })}
        </nav>
      )}

      <section className="loop-v2-surface">
        {creating ? (
          <div className="loop-v2-create">
            <div className="loop-v2-create-copy">
              <span className="loop-eyebrow">NEW GOAL</span>
              <h2>{target ? 'What should Akorith finish?' : 'Where should this Goal work?'}</h2>
              <p>{target ? 'Describe the finished result. Akorith will keep cycling until the evidence matches it.' : 'Use the current project or clone a GitHub repository. GitHub Loops checkpoint and push verified progress automatically.'}</p>
            </div>
            {!target ? <div className="loop-target-actions">
              {activeProject?.path && <button type="button" className="ws-hero-btn is-primary" onClick={() => void chooseCurrentTarget()}><FolderOpenIcon size={16} />Use {activeProject.name}</button>}
              <button type="button" className={`ws-hero-btn ${activeProject?.path ? '' : 'is-primary'}`} onClick={() => setRepositoryFormOpen(true)}><LoopIcon size={16} />Clone GitHub repository</button>
              {repositoryFormOpen && <form className="loop-repository-form" onSubmit={(event) => { event.preventDefault(); void cloneRepository() }}>
                <label htmlFor="loop-repository-url">GitHub repository URL</label>
                <div><input id="loop-repository-url" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/repository" autoFocus spellCheck={false} /><button type="submit" disabled={cloningRepository || !repositoryUrl.trim()}>{cloningRepository ? 'Cloning…' : 'Clone'}</button></div>
                <small>The repository is cloned into Akorith's managed Loop workspace. Commits are pushed only to the verified origin.</small>
              </form>}
            </div> : <div className="loop-v2-create-composer">{composer}</div>}
            {error && <div className="loop-inline-error">{error}</div>}
          </div>
        ) : selectedLoop ? (
          <div className="loop-v2-detail">
            <div className="loop-v2-goal-head">
              <div><span className={`loop-status is-${selectedRunning ? 'running' : selectedLoop.status}`}><i />{statusLabel(selectedLoop.status, selectedRunning)}</span><h2>{contract?.summary ?? selectedLoop.title}</h2><p>{selectedLoop.githubName ?? projectName(selectedLoop.localPath)} · cycle {iteration} · {selectedLoop.localModel ?? 'default'}</p></div>
              <div className="loop-v2-time"><span>{selectedRunning ? 'Working for' : 'Worked for'}</span><strong>{selectedElapsed}</strong>{!selectedRunning && <button type="button" className="loop-archive-button" title="Archive Loop" aria-label="Archive Loop" onClick={() => void archiveSelected()}><ArchiveIcon size={15} /></button>}</div>
            </div>

            <div className="loop-v2-steps">
              <LoopPipeline phase={phase} status={selectedLoop.status} iteration={iteration} />
            </div>

            <ProjectPreviewPanel projectPath={selectedLoop.localPath} projectName={selectedLoop.githubName ?? projectName(selectedLoop.localPath)} />

            <div className="loop-chat-thread" aria-live="polite">
              <div className="loop-user-message">{selectedLoop.title}</div>
              <div className={`loop-assistant-message ${selectedRunning ? 'is-running' : ''}`}>
                <div className="loop-assistant-state"><span className="loop-v2-current-orb" /><div><strong>{currentCopy.title}</strong><p>{currentCopy.body}</p></div></div>
                {progressSteps.length > 0 && <div className="loop-chat-events">{progressSteps.map((step, index) => <article key={step.id} className={`loop-progress-step is-${step.kind}`}><i /><div><span>Step {index + 1}</span><strong>{step.title}</strong><p>{step.body}</p></div><time>{new Date(step.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></article>)}</div>}
              </div>
            </div>

            {!selectedRunning && (selectedLoop.status === 'completed' || selectedLoop.error) && <div className={`loop-outcome ${selectedLoop.error ? 'is-error' : ''}`}><span>{selectedLoop.status === 'completed' ? 'GOAL REACHED' : 'REVIEW NEEDED'}</span><strong>{lastRun?.summary ?? selectedLoop.error}</strong><p>{lastRun?.filesChanged ?? 0} changed files · {commits.length} checkpoints · {selectedLoop.pushEnabled ? 'synced to GitHub' : 'local'}</p></div>}
            {error && <div className="loop-inline-error">{error}</div>}
            <div className="loop-focus-composer">{composer}</div>
          </div>
        ) : <div className="loop-v2-create"><h2>Start a new Loop</h2></div>}
      </section>
    </main>
  )
}
