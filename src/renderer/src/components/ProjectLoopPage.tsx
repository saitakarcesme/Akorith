import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatActivity,
  ProjectLoop,
  ProjectLoopCommit,
  ProjectLoopEvent,
  ProjectLoopRun,
  ProjectRow,
  ProviderInfo
} from '../../../preload/index.d'
import { FolderOpenIcon, LoopIcon, SendIcon, StopIcon } from './icons'
import { ComposerSendButton } from './CreationPrimitives'
import ModelPicker from './ModelPicker'
import WorkspaceActivity from './WorkspaceActivity'

interface ProjectLoopPageProps {
  active: boolean
  activeProject: ProjectRow | null
}

interface GoalTarget {
  path: string
  name: string
  isRepo: boolean
}

function goalActivities(events: ProjectLoopEvent[]): ChatActivity[] {
  return events.map((event): ChatActivity => {
    const isError = event.kind === 'error' || event.kind === 'run_failed'
    const isCommand = event.kind === 'validation_run'
    const isFile = event.kind === 'patch_applied' || event.kind === 'committed'
    const isReasoning = event.kind === 'planned' || event.kind === 'patch_proposed' || event.kind === 'patch_validated'
    return {
      kind: isError ? 'warning' : isCommand ? 'command' : isFile ? 'file' : isReasoning ? 'reasoning' : 'status',
      label: event.message,
      detail: event.detail,
      status: isError ? 'error' : event.kind === 'run_started' || event.kind === 'resumed' ? 'running' : 'complete',
      timestamp: event.createdAt
    }
  })
}

function goalStep(events: ProjectLoopEvent[], completed: boolean): number {
  if (completed) return 6
  const kinds = new Set(events.map((event) => event.kind))
  if (kinds.has('committed') || kinds.has('run_succeeded')) return 6
  if (kinds.has('patch_applied') || kinds.has('validation_run')) return 5
  if (kinds.has('patch_validated')) return 4
  if (kinds.has('patch_proposed')) return 3
  if (kinds.has('planned')) return 2
  return 1
}

export default function ProjectLoopPage({ active, activeProject }: ProjectLoopPageProps): JSX.Element {
  const [target, setTarget] = useState<GoalTarget | null>(null)
  const [draft, setDraft] = useState('')
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [loop, setLoop] = useState<ProjectLoop | null>(null)
  const [events, setEvents] = useState<ProjectLoopEvent[]>([])
  const [runs, setRuns] = useState<ProjectLoopRun[]>([])
  const [commits, setCommits] = useState<ProjectLoopCommit[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initialized = useRef(false)

  const loadProviders = useCallback(async (): Promise<ProviderInfo[]> => {
    const list = await window.api.chat.listProviders()
    const executors = list.filter((provider) => provider.available.ok && provider.kind.includes('executor'))
    setProviders(executors)
    setProviderId((current) => executors.some((provider) => provider.id === current) ? current : executors[0]?.id ?? '')
    return executors
  }, [])

  const refresh = useCallback(async (id: string): Promise<void> => {
    const [nextLoop, nextEvents, nextRuns, nextCommits] = await Promise.all([
      window.api.projectLoop.get(id),
      window.api.projectLoop.listEvents(id),
      window.api.projectLoop.listRuns(id),
      window.api.projectLoop.listCommits(id)
    ])
    setLoop(nextLoop)
    setEvents([...nextEvents].reverse())
    setRuns(nextRuns)
    setCommits(nextCommits)
    setRunning(nextLoop?.status === 'active')
  }, [])

  useEffect(() => {
    if (!active || initialized.current) return
    initialized.current = true
    void loadProviders()
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [active, loadProviders])

  const selectedProvider = providers?.find((provider) => provider.id === providerId)

  useEffect(() => {
    setModel((current) => selectedProvider?.models.includes(current) ? current : selectedProvider?.models[0] ?? '')
  }, [selectedProvider])

  useEffect(() => {
    if (!active || !loop || !running) return
    const timer = window.setInterval(() => void refresh(loop.id), 900)
    return () => window.clearInterval(timer)
  }, [active, loop?.id, running, refresh])

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

  const runGoal = useCallback((id: string): void => {
    setRunning(true)
    setError(null)
    void window.api.projectLoop.runGoal(id)
      .then(() => refresh(id))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setRunning(false))
  }, [refresh])

  const submit = async (): Promise<void> => {
    const prompt = draft.trim()
    if (!prompt || !target || !selectedProvider?.available.ok || running) return
    setDraft('')
    setError(null)
    try {
      if (loop) {
        const updated = await window.api.projectLoop.update(loop.id, {
          localModelProvider: providerId,
          localModel: model || 'default'
        })
        await window.api.projectLoop.editGoal(loop.id, prompt)
        setLoop((current) => current
          ? {
              ...(updated ?? current),
              idea: prompt,
              title: prompt.replace(/\s+/g, ' ').slice(0, 80),
              status: 'active'
            }
          : current)
        runGoal(loop.id)
        return
      }
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
      setLoop(created)
      runGoal(created.id)
    } catch (reason) {
      setDraft(prompt)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const pause = async (): Promise<void> => {
    if (!loop) return
    await window.api.projectLoop.pauseGoal(loop.id)
    setRunning(false)
    void refresh(loop.id)
  }

  const newGoal = async (keepTarget = true): Promise<void> => {
    if (loop) {
      if (running) await window.api.projectLoop.pauseGoal(loop.id)
      await window.api.projectLoop.archive(loop.id)
    }
    setLoop(null)
    setEvents([])
    setRuns([])
    setCommits([])
    setDraft('')
    setRunning(false)
    setError(null)
    if (!keepTarget) setTarget(null)
  }

  const activities = useMemo(() => goalActivities(events), [events])
  const lastRun = runs[0]
  const failed = loop?.status === 'error' || loop?.status === 'needs_review'
  const finished = loop?.status === 'completed'
  const canSend = Boolean(target && draft.trim() && selectedProvider?.available.ok && !running)
  const resultText = lastRun?.summary || (failed ? lastRun?.error || loop?.error : '')

  const composer = target ? (
    <div className="composer goal-composer">
      <div className="composer-box">
        <textarea
          className="composer-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }}
          placeholder={loop ? `Add a follow-up goal for ${target.name}…` : `Describe a goal for ${target.name}…`}
          rows={2}
          spellCheck={false}
        />
        <div className="composer-controls">
          <div className="composer-controls-left">
            <ModelPicker
              providers={providers}
              providerId={providerId}
              model={model}
              disabled={running}
              onSelect={(nextProvider, nextModel) => { setProviderId(nextProvider); setModel(nextModel) }}
              onRefresh={() => void loadProviders()}
            />
            <button type="button" className="composer-chip goal-target-chip" onClick={() => void newGoal(false)}>
              <FolderOpenIcon size={13} />{target.name}
            </button>
          </div>
          {running
            ? <ComposerSendButton stop onClick={() => void pause()}><StopIcon size={16} /></ComposerSendButton>
            : <ComposerSendButton disabled={!canSend} onClick={() => void submit()}><SendIcon size={16} /></ComposerSendButton>}
        </div>
      </div>
      <div className="context-bar">
        <span className="context-chip"><span className="context-dot" />{running ? 'Goal running locally' : finished ? 'Goal completed' : failed ? 'Goal needs review' : 'Goal ready'}</span>
        {loop && <button type="button" className="context-clear" onClick={() => void newGoal(true)}>New goal</button>}
      </div>
      <div className="composer-info">goal {target.name} · {selectedProvider?.label ?? 'model'} · local project · push off</div>
    </div>
  ) : null

  return (
    <main className="goal-page">
      {!target ? (
        <div className="goal-target-hero">
          <div className="goal-target-inner">
            <span className="goal-eyebrow">LONG-RUNNING WORK</span>
            <h1>Where should Akorith work?</h1>
            <p>Choose one local folder or Git repository. The Goal keeps working there until the outcome is complete or needs your review.</p>
            <div className="goal-target-actions">
              {activeProject?.path && <button type="button" className="ws-hero-btn is-primary" onClick={() => void chooseTarget('current')}><FolderOpenIcon size={16} />Use {activeProject.name}</button>}
              <button type="button" className={`ws-hero-btn ${activeProject?.path ? '' : 'is-primary'}`} onClick={() => void chooseTarget('folder')}><FolderOpenIcon size={16} />Choose folder</button>
              <button type="button" className="ws-hero-btn" onClick={() => void chooseTarget('repo')}><LoopIcon size={16} />Choose repository</button>
            </div>
            {error && <div className="goal-inline-error">{error}</div>}
          </div>
        </div>
      ) : (
        <>
          <div className="goal-transcript">
            <div className="goal-transcript-col">
              {!loop ? (
                <div className="goal-ready-state">
                  <span className="goal-eyebrow">{target.isRepo ? 'REPOSITORY' : 'FOLDER'} · {target.name}</span>
                  <h1>What should Akorith finish?</h1>
                  <p>Describe one concrete outcome below. Akorith will edit the project, verify its work, and keep a local commit history.</p>
                </div>
              ) : (
                <>
                  <article className="chat-msg user"><div className="chat-msg-text">{loop.idea ?? loop.title}</div></article>
                  <article className={`chat-msg assistant ${failed ? 'error' : ''}`}>
                    <WorkspaceActivity
                      activities={activities}
                      startedAt={lastRun?.startedAt ?? loop.createdAt}
                      active={running}
                      failed={failed}
                      step={goalStep(events, Boolean(finished))}
                    />
                    {!running && resultText && <div className="chat-msg-text goal-result-copy">{resultText}</div>}
                    {!running && (finished || commits.length > 0) && (
                      <div className="chat-msg-meta"><span>{commits.length} local commit{commits.length === 1 ? '' : 's'} · {lastRun?.filesChanged ?? 0} changed files · push off</span></div>
                    )}
                  </article>
                </>
              )}
              {error && <div className="goal-inline-error">{error}</div>}
            </div>
          </div>
          <div className="composer-dock goal-composer-dock">{composer}</div>
        </>
      )}
    </main>
  )
}
