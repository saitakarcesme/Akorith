import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProjectLoopEvent,
  ProjectLoopRun,
  WorkspaceGoalSnapshot,
  WorkspaceGoalStatus
} from '../../../preload/index.d'
import { useDocumentVisible } from '../documentVisibility'
import type { WorkspaceGoalMessageMeta } from './chat-types'

interface WorkspaceLoopActivityProps {
  metadata: WorkspaceGoalMessageMeta
  active: boolean
  projectName?: string
}

interface GoalData {
  snapshot: WorkspaceGoalSnapshot
  events: ProjectLoopEvent[]
  runs: ProjectLoopRun[]
}

interface ProgressEntry {
  id: string
  title: string
  body?: string
  createdAt: number
}

const VISIBLE_EVENT_KINDS = new Set([
  'created',
  'goal_understood',
  'planned',
  'execution_started',
  'patch_applied',
  'validation_run',
  'committed',
  'analyzed',
  'replanned',
  'goal_completed',
  'run_failed',
  'paused',
  'resumed',
  'error',
  'note'
])

function compactText(value: string | undefined, maxLength = 420): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text
}

function readableDetail(value: string | undefined): string | undefined {
  const text = value?.trim()
  if (!text) return undefined
  if (!text.startsWith('{') && !text.startsWith('[')) return compactText(text)
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const scalarKeys = ['summary', 'objective', 'result', 'reason', 'nextStep', 'remainingGap']
    const scalar = scalarKeys
      .map((key) => parsed[key])
      .find((item): item is string => typeof item === 'string' && item.trim().length > 0)
    if (scalar) return compactText(scalar)
    const listKeys = ['completedEvidence', 'deliverables', 'acceptanceCriteria', 'remaining']
    for (const key of listKeys) {
      const items = Array.isArray(parsed[key])
        ? parsed[key].filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 3)
        : []
      if (items.length > 0) return compactText(items.join(' '))
    }
  } catch {
    return undefined
  }
  return undefined
}

function progressEntry(event: ProjectLoopEvent, projectName?: string): ProgressEntry {
  const fallbackTitles: Record<string, string> = {
    created: projectName ? `Goal scoped to ${projectName}` : 'Goal scoped to this project',
    goal_understood: 'The requested outcome is understood',
    planned: 'The next project action is planned',
    execution_started: 'The selected project action is running',
    patch_applied: 'The project changes were applied',
    validation_run: 'The latest project state was validated',
    committed: 'A verified local checkpoint was recorded',
    analyzed: 'The evidence was compared with the goal',
    replanned: 'The remaining project work was replanned',
    goal_completed: 'The complete goal was verified',
    run_failed: 'This cycle stopped before verification',
    paused: 'Work was paused with progress preserved',
    resumed: 'Work resumed from the durable checkpoint',
    error: 'The current blocker was recorded',
    note: 'Project progress was recorded'
  }
  const rawTitle = compactText(event.message, 150)
  const generic = !rawTitle || /^workspace \/loop|^goal (understood|completed)|^run |^cycle /i.test(rawTitle)
  const title = generic ? fallbackTitles[event.kind] ?? rawTitle ?? 'Project progress was recorded' : rawTitle
  const detail = readableDetail(event.detail)
  return {
    id: event.id,
    title,
    body: detail && detail !== title ? detail : undefined,
    createdAt: event.createdAt
  }
}

function statusCopy(status: WorkspaceGoalStatus, projectName?: string, error?: string): { label: string; body: string } {
  const project = projectName ? ` in ${projectName}` : ''
  if (status === 'completed') {
    return {
      label: 'Goal reached',
      body: `Akorith verified the complete requested outcome${project}. The result below is now final.`
    }
  }
  if (status === 'paused') {
    return {
      label: 'Paused',
      body: `Progress and evidence${project} are saved. Resume this goal to continue; no final result has been produced.`
    }
  }
  if (status === 'needs_review') {
    return {
      label: 'Not finished',
      body: error
        ? `Akorith preserved the completed work after reaching this blocker: ${error}`
        : `Akorith preserved the completed work${project}, but the full goal is not verified yet. Resume it for another cycle.`
    }
  }
  if (status === 'error') {
    return {
      label: 'Needs another cycle',
      body: error
        ? `The last cycle stopped before completion: ${error}`
        : 'The last cycle stopped before the full goal was verified. Progress remains saved and resumable.'
    }
  }
  return {
    label: 'Working until verified',
    body: `Akorith is planning, editing, and validating${project}. It will withhold the final result until the complete goal is reached.`
  }
}

function finalResult(goal: string, runs: ProjectLoopRun[], events: ProjectLoopEvent[]): string {
  const latest = runs[0]
  const completion = events.find((event) => event.kind === 'goal_completed')
  const evidenceChecks = events.filter((event) => event.kind === 'analyzed' || event.kind === 'goal_completed').length
  return [
    `Goal completed: ${goal}`,
    compactText(latest?.summary),
    latest?.validationResult ? `Validation: ${compactText(latest.validationResult)}` : undefined,
    readableDetail(completion?.detail) ? `Evidence: ${readableDetail(completion?.detail)}` : undefined,
    `Cycles: ${runs.length} · Files changed: ${runs.reduce((sum, run) => sum + run.filesChanged, 0)} · Evidence checks: ${evidenceChecks}`
  ].filter((line): line is string => Boolean(line)).join('\n\n')
}

function WorkspaceLoopActivity({ metadata, active, projectName }: WorkspaceLoopActivityProps): JSX.Element {
  const documentVisible = useDocumentVisible()
  const [snapshot, setSnapshot] = useState<WorkspaceGoalSnapshot | null>(null)
  const [events, setEvents] = useState<ProjectLoopEvent[]>([])
  const [runs, setRuns] = useState<ProjectLoopRun[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState(false)
  const [pollGeneration, setPollGeneration] = useState(0)
  const [copied, setCopied] = useState(false)
  const loadPromiseRef = useRef<Promise<GoalData | null> | null>(null)
  const liveStatusRef = useRef<WorkspaceGoalStatus>(metadata.status)
  liveStatusRef.current = snapshot?.status ?? metadata.status

  const loadGoal = useCallback((): Promise<GoalData | null> => {
    if (loadPromiseRef.current) return loadPromiseRef.current
    let request: Promise<GoalData | null>
    request = (async () => {
      const nextSnapshot = await window.api.projectLoop.getWorkspaceGoal(metadata.loopId)
      if (!nextSnapshot) return null
      const [nextEvents, nextRuns] = await Promise.all([
        window.api.projectLoop.listEvents(metadata.loopId),
        window.api.projectLoop.listRuns(metadata.loopId)
      ])
      return { snapshot: nextSnapshot, events: nextEvents, runs: nextRuns }
    })().finally(() => {
      if (loadPromiseRef.current === request) loadPromiseRef.current = null
    })
    loadPromiseRef.current = request
    return request
  }, [metadata.loopId])

  const applyGoal = useCallback((data: GoalData): void => {
    setSnapshot(data.snapshot)
    setEvents(data.events)
    setRuns(data.runs)
    setLoadError(null)
  }, [])

  useEffect(() => {
    if (!active || !documentVisible) return
    let disposed = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const data = await loadGoal()
        if (disposed) return
        if (!data) {
          setLoadError('This durable goal could not be loaded.')
          return
        }
        applyGoal(data)
        if (data.snapshot.status === 'running') {
          timer = window.setTimeout(() => void poll(), 1200)
        }
      } catch (error) {
        if (disposed) return
        setLoadError(error instanceof Error ? error.message : String(error))
        if (liveStatusRef.current === 'running') timer = window.setTimeout(() => void poll(), 2500)
      }
    }
    void poll()
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [active, applyGoal, documentVisible, loadGoal, metadata.status, pollGeneration])

  const status = liveStatusRef.current
  const error = snapshot?.error ?? metadata.error
  const copy = statusCopy(status, projectName, error)
  const attempts = Math.max(snapshot?.attempts ?? 0, metadata.attempts, runs.length)
  const progress = useMemo(() => {
    const seen = new Set<string>()
    return events
      .filter((event) => VISIBLE_EVENT_KINDS.has(event.kind))
      .slice(0, 10)
      .reverse()
      .map((event) => progressEntry(event, projectName))
      .filter((entry) => {
        const signature = `${entry.title}\n${entry.body ?? ''}`
        if (seen.has(signature)) return false
        seen.add(signature)
        return true
      })
      .slice(-7)
  }, [events, projectName])
  const latestRun = runs[0]
  const completionEvidence = readableDetail(events.find((event) => event.kind === 'goal_completed')?.detail)
  const evidenceChecks = events.filter(
    (event) => event.kind === 'analyzed' || event.kind === 'goal_completed'
  ).length
  const finalText = useMemo(
    () => finalResult(snapshot?.goal ?? metadata.goal, runs, events),
    [events, metadata.goal, runs, snapshot?.goal]
  )

  const pause = async (): Promise<void> => {
    setActionPending(true)
    try {
      const next = await window.api.projectLoop.pauseWorkspaceGoal(metadata.loopId)
      setSnapshot(next)
      setLoadError(null)
      setPollGeneration((value) => value + 1)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setActionPending(false)
    }
  }

  const resume = async (): Promise<void> => {
    setActionPending(true)
    try {
      const next = await window.api.projectLoop.resumeWorkspaceGoal(metadata.loopId)
      setSnapshot(next)
      setLoadError(null)
      setPollGeneration((value) => value + 1)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setActionPending(false)
    }
  }

  const copyResult = (): void => {
    void navigator.clipboard.writeText(finalText).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <section
      className={`workspace-loop-activity is-${status}`}
      aria-label="/loop goal progress"
      aria-live="polite"
      aria-busy={status === 'running'}
    >
      <header className="workspace-loop-head">
        <div>
          <span>/loop · {copy.label}</span>
          <h3>{snapshot?.goal ?? metadata.goal}</h3>
        </div>
        {status === 'running' ? (
          <button type="button" disabled={actionPending} onClick={() => void pause()}>
            {actionPending ? 'Pausing…' : 'Pause'}
          </button>
        ) : status !== 'completed' ? (
          <button type="button" disabled={actionPending} onClick={() => void resume()}>
            {actionPending ? 'Resuming…' : 'Resume'}
          </button>
        ) : (
          <button type="button" onClick={copyResult}>{copied ? 'Copied' : 'Copy result'}</button>
        )}
      </header>

      <p className="workspace-loop-state">{copy.body}</p>

      {progress.length > 0 ? (
        <ol className="workspace-loop-steps" aria-label="Project-specific loop progress">
          {progress.map((entry, index) => (
            <li key={entry.id}>
              <small>Step {index + 1}</small>
              <strong>{entry.title}</strong>
              {entry.body && <p>{entry.body}</p>}
              <time dateTime={new Date(entry.createdAt).toISOString()}>
                {new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
            </li>
          ))}
        </ol>
      ) : status === 'running' ? (
        <p className="workspace-loop-waiting">
          Akorith is translating this goal into project-specific acceptance criteria before the first verified change.
        </p>
      ) : null}

      {runs.length > 0 && (
        <div className="workspace-loop-evidence" aria-label="Recorded evidence">
          <span><strong>{attempts}</strong><small>{attempts === 1 ? 'cycle' : 'cycles'}</small></span>
          <span><strong>{runs.reduce((sum, run) => sum + run.filesChanged, 0)}</strong><small>files changed</small></span>
          <span><strong>{runs.reduce((sum, run) => sum + run.testsRun, 0)}</strong><small>validation runs</small></span>
          <span><strong>{evidenceChecks}</strong><small>evidence checks</small></span>
        </div>
      )}

      {status === 'completed' && (
        <div className="workspace-loop-final">
          <strong>{latestRun?.summary ?? 'The complete goal was verified against the current project state.'}</strong>
          {latestRun?.validationResult && <p>{latestRun.validationResult}</p>}
          {completionEvidence && <p>{completionEvidence}</p>}
        </div>
      )}

      {loadError && <p className="workspace-loop-error" role="alert">{loadError}</p>}
    </section>
  )
}

export default memo(WorkspaceLoopActivity)
