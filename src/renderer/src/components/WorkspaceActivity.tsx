import { useEffect, useMemo, useState } from 'react'
import type { ChatActivity } from '../../../preload/index.d'

interface WorkspaceActivityProps {
  activities: ChatActivity[]
  startedAt: number
  active: boolean
  failed?: boolean
}

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`
}

export default function WorkspaceActivity({ activities, startedAt, active, failed = false }: WorkspaceActivityProps): JSX.Element {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])

  const visible = activities.slice(-7)
  const completed = activities.filter((item) => item.status === 'complete').length
  const currentStep = active ? Math.min(6, Math.max(1, completed + 1)) : failed ? Math.min(6, Math.max(1, completed)) : 6
  const changedFiles = useMemo(
    () => [...new Set(activities.filter((item) => item.kind === 'file' && item.status === 'complete').map((item) => item.label))],
    [activities]
  )

  return (
    <section className={`workspace-activity ${active ? 'is-active' : 'is-complete'}`} aria-live="polite">
      <div className="workspace-activity-head">
        <div className="workspace-breath" aria-hidden="true"><span /></div>
        <strong>{active ? `Working for ${elapsedLabel(now - startedAt)}` : failed ? 'Task stopped' : 'Work completed'}</strong>
        <span className="workspace-step"><i />Step {currentStep} / 6</span>
      </div>
      {visible.length > 0 && (
        <div className="workspace-activity-list">
          {visible.map((item, index) => (
            <div
              className={`workspace-activity-row is-${item.kind} is-${item.status ?? 'running'}`}
              key={`${item.timestamp}-${item.kind}-${index}`}
            >
              <span className="workspace-activity-dot" />
              <span>{item.label}</span>
              {item.detail && <em>{item.detail}</em>}
            </div>
          ))}
        </div>
      )}
      {!active && changedFiles.length > 0 && (
        <div className="workspace-files">
          <span>Changed files</span>
          {changedFiles.map((file) => <code key={file}>{file}</code>)}
        </div>
      )}
    </section>
  )
}
