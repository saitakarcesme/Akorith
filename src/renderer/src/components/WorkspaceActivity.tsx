import { memo, useEffect, useMemo, useState } from 'react'
import type { ChatActivity } from '../../../preload/index.d'

interface WorkspaceActivityProps {
  activities: ChatActivity[]
  startedAt: number
  endedAt?: number
  active: boolean
  failed?: boolean
  projectName?: string
}

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`
}

function detailSentence(item: ChatActivity): string {
  const detail = item.detail?.replace(/\s+/g, ' ').trim()
  if (!detail || detail === item.label.trim()) return ''
  const bounded = detail.length > 180 ? `${detail.slice(0, 179).trimEnd()}…` : detail
  return /[.!?…]$/.test(bounded) ? bounded : `${bounded}.`
}

function activityExplanation(item: ChatActivity, projectName: string): string {
  const detail = detailSentence(item)
  if (item.status === 'error' || item.kind === 'warning') {
    return detail
      ? `The CLI could not complete this action in ${projectName}: ${detail}`
      : `The CLI could not complete this action in ${projectName}. The project remains available for review or retry.`
  }
  if (item.kind === 'command') {
    return item.status === 'complete'
      ? `The command finished in ${projectName}.${detail ? ` Last reported output: ${detail}` : ' Its result is available to the model for verification.'}`
      : `The CLI is running this command in ${projectName}.${detail ? ` Current output: ${detail}` : ''}`
  }
  if (item.kind === 'file') {
    return item.status === 'complete'
      ? `The CLI finished this file action in ${projectName}. The actual file contents or edit result are now available for its next decision.${detail ? ` ${detail}` : ''}`
      : `The CLI is performing this file action inside ${projectName}.${detail ? ` ${detail}` : ''}`
  }
  if (item.kind === 'reasoning' || item.kind === 'plan') {
    return detail || detailSentence({ ...item, detail: item.label }) || `The selected model is deciding the next concrete action from the current state of ${projectName}.`
  }
  if (/session started/i.test(item.label)) {
    return `The selected CLI is connected to ${projectName} and has received the project-scoped request.`
  }
  if (/starting the selected model|preparing|starting/i.test(item.label)) {
    return `Akorith started the selected CLI in ${projectName} and is waiting for its first concrete tool action.`
  }
  if (/finished|complete/i.test(item.label) || item.status === 'complete') {
    return detail || `This CLI action finished in ${projectName}.`
  }
  return detail || `The CLI reported this live action while working in ${projectName}.`
}

function WorkspaceActivity({
  activities,
  startedAt,
  endedAt,
  active,
  failed = false,
  projectName = 'the selected project'
}: WorkspaceActivityProps): JSX.Element {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])

  const visible = useMemo(() => {
    const compact: ChatActivity[] = []
    for (const item of activities) {
      if (/^(workspace task complete|project step finished)$/i.test(item.label.trim())) continue
      const key = `${item.kind}:${item.label.replace(/\s+/g, ' ').trim().toLocaleLowerCase()}`
      const existing = compact.findIndex((candidate) =>
        `${candidate.kind}:${candidate.label.replace(/\s+/g, ' ').trim().toLocaleLowerCase()}` === key
      )
      const displayItem = !active && !failed && item.status === 'running'
        ? { ...item, status: 'complete' as const }
        : item
      if (existing >= 0) compact[existing] = displayItem
      else compact.push(displayItem)
    }
    return compact.slice(-8)
  }, [active, activities, failed])
  const recordedEnd = useMemo(
    () => activities.reduce((latest, item) => Math.max(latest, item.timestamp), startedAt),
    [activities, startedAt]
  )
  const elapsedUntil = active ? now : endedAt ?? recordedEnd
  const statusText = active
    ? `Working for ${elapsedLabel(elapsedUntil - startedAt)}`
    : failed
      ? `Stopped after ${elapsedLabel(elapsedUntil - startedAt)}`
      : `Worked for ${elapsedLabel(elapsedUntil - startedAt)}`

  return (
    <section className={`workspace-activity ${active ? 'is-active' : failed ? 'is-failed' : 'is-complete'}`} aria-live="polite">
      <div className="workspace-duration">{statusText}</div>
      <div className="workspace-activity-rule" />
      <div className="workspace-activity-list">
        {visible.map((item) => (
          <div className={`workspace-activity-row is-${item.kind} is-${item.status ?? 'running'}`} key={`${item.timestamp}-${item.kind}-${item.label}`}>
            <div className="workspace-activity-copy">
              <strong>{item.kind === 'reasoning'
                ? 'Reasoning about the next action'
                : item.kind === 'plan'
                  ? 'Updating the plan'
                  : item.label === 'Starting the selected model'
                    ? 'Starting the selected CLI'
                    : item.label}</strong>
              <p>{activityExplanation(item, projectName)}</p>
            </div>
          </div>
        ))}
        {visible.length === 0 && active && (
          <div className="workspace-activity-row is-status is-running">
            <div className="workspace-activity-copy">
              <strong>Waiting for the first CLI action…</strong>
              <p>The request is running in {projectName}. Concrete file, command, and reasoning events will appear here as the CLI reports them.</p>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default memo(WorkspaceActivity)
