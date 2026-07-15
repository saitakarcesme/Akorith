import { useEffect, useMemo, useState } from 'react'
import type { ChatActivity } from '../../../preload/index.d'

interface WorkspaceActivityProps {
  activities: ChatActivity[]
  startedAt: number
  active: boolean
  failed?: boolean
  step?: number
}

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`
}

function activityLabel(item: ChatActivity): string {
  if (item.label === 'Starting the selected model') return 'Preparing the workspace'
  if (item.label === 'Workspace task complete') return 'Finished the requested changes'
  return item.label
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
  active,
  failed = false,
  step
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
  const completed = activities.filter((item) => item.status === 'complete').length
  const currentStep = step ?? (active ? Math.min(6, Math.max(1, completed + 1)) : failed ? Math.min(6, Math.max(1, completed)) : 6)
  const statusText = active
    ? `Working for ${elapsedLabel(now - startedAt)}`
    : failed
      ? `Stopped after ${elapsedLabel(now - startedAt)}`
      : `Worked for ${elapsedLabel(now - startedAt)}`

  return (
    <section className={`workspace-activity ${active ? 'is-active' : failed ? 'is-failed' : 'is-complete'}`} aria-live="polite">
      <div className="workspace-duration">{statusText}</div>
      <div className="workspace-activity-rule" />
      <div className="workspace-activity-list">
        {visible.map((item) => (
          <div className={`workspace-activity-row is-${item.kind} is-${item.status ?? 'running'}`} key={`${item.timestamp}-${item.kind}-${item.label}`}>
            <span className="workspace-activity-icon">{activityGlyph(item.kind)}</span>
            <span className="workspace-activity-copy">{activityLabel(item)}</span>
          </div>
        ))}
        {visible.length === 0 && active && (
          <div className="workspace-activity-row is-status is-running">
            <span className="workspace-activity-icon">{activityGlyph('status')}</span>
            <span className="workspace-activity-copy">Akorithing…</span>
          </div>
        )}
      </div>
      <div className="workspace-step-wrap">
        <span className="workspace-step"><i />Step {currentStep} / 6</span>
      </div>
    </section>
  )
}
