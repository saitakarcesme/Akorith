import { useEffect, useMemo, useState } from 'react'
import type { ChatActivity } from '../../../preload/index.d'

interface WorkspaceActivityProps {
  activities: ChatActivity[]
  startedAt: number
  endedAt?: number
  active: boolean
  failed?: boolean
}

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`
}

function activityLabel(item: ChatActivity): string {
  if (item.label === 'Starting the selected model') return 'Preparing the workspace'
  if (item.label === 'Workspace task complete') return 'Finished the requested changes'
  return item.label
}

function activityExplanation(item: ChatActivity): string {
  if (item.status === 'error' || item.kind === 'warning') {
    return 'This step could not finish. Review the message, adjust the request or model if needed, then retry from the same project context.'
  }
  if (item.kind === 'command') {
    return item.status === 'complete'
      ? 'The command finished inside the selected project. Akorith keeps the result as evidence and uses it to decide whether another inspection, edit, or validation step is still necessary.'
      : 'This command is running only inside the selected project to inspect its current state or validate the requested result before any conclusion is reported.'
  }
  if (item.kind === 'file') {
    return item.status === 'complete'
      ? 'The relevant project file was inspected or updated. Its surrounding structure remains part of the context carried into the next project decision.'
      : 'Akorith is reading or updating this file inside the project boundary while preserving the surrounding code and the intent of the request.'
  }
  if (item.kind === 'reasoning' || item.kind === 'plan') {
    return 'The selected model is connecting the request to the current repository state, resolving dependencies between changes, and choosing the smallest useful action that can be checked afterward.'
  }
  if (/preparing|starting/i.test(item.label)) {
    return 'Akorith is loading the selected folder, its bounded project context, conversation memory, and the chosen local CLI before any project change is attempted.'
  }
  if (/finished|complete/i.test(item.label) || item.status === 'complete') {
    return 'This unit of work has finished. Its files, command results, and model explanation are now carried into the final response and the continuing project memory.'
  }
  return 'Akorith is keeping the project task moving while translating the selected model’s raw CLI activity into a concise, durable explanation of what is happening and why it matters.'
}

export function workspaceActivityStep(activities: ChatActivity[], active: boolean, failed = false): number {
  const completed = activities.filter((item) => item.status === 'complete').length
  return active
    ? Math.min(6, Math.max(1, completed + 1))
    : failed
      ? Math.min(6, Math.max(1, completed))
      : 6
}

function activityGlyph(kind: ChatActivity['kind']): JSX.Element {
  if (kind === 'command') {
    return <svg viewBox="0 0 18 18" aria-hidden="true"><rect x="2.5" y="3" width="13" height="12" rx="2" /><path d="m5.5 7 2 2-2 2M9.5 11h3" /></svg>
  }
  if (kind === 'file') {
    return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4 2.75h6l4 4V15H4z" /><path d="M10 2.75V7h4" /></svg>
  }
  if (kind === 'warning') {
    return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.5 16 15H2z" /><path d="M9 6.5v4M9 13h.01" /></svg>
  }
  if (kind === 'reasoning' || kind === 'plan') {
    return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.5a5 5 0 0 0-3.2 8.85V14h6.4v-2.65A5 5 0 0 0 9 2.5Z" /><path d="M7 16h4" /></svg>
  }
  return <svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="5.75" /><path d="M9 6v3.5l2 1.5" /></svg>
}

export default function WorkspaceActivity({
  activities,
  startedAt,
  endedAt,
  active,
  failed = false
}: WorkspaceActivityProps): JSX.Element {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])

  const visible = useMemo(() => {
    const compact: ChatActivity[] = []
    for (const item of activities) {
      const previous = compact.at(-1)
      if (previous && previous.kind === item.kind && previous.label === item.label && previous.status === item.status) continue
      compact.push(item)
    }
    return compact.slice(-9)
  }, [activities])
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
            <span className="workspace-activity-icon">{activityGlyph(item.kind)}</span>
            <span className="workspace-activity-copy">
              <strong>{activityLabel(item)}</strong>
              <p>{activityExplanation(item)}</p>
            </span>
          </div>
        ))}
        {visible.length === 0 && active && (
          <div className="workspace-activity-row is-status is-running">
            <span className="workspace-activity-icon">{activityGlyph('status')}</span>
            <span className="workspace-activity-copy"><strong>Akorithing…</strong><p>Preparing the first project-scoped action and waiting for a meaningful event from the selected model.</p></span>
          </div>
        )}
      </div>
    </section>
  )
}
