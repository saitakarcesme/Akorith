import { memo, useEffect, useMemo, useState } from 'react'
import type { ChatActivity } from '../../../preload/index.d'
import { useDocumentVisible } from '../documentVisibility'
import {
  buildWorkspaceActivityFeed,
  workspaceActivityDurationMs,
  type WorkspaceActivityFeedItem
} from '../workspaceActivityFeed'

interface WorkspaceActivityProps {
  activities: ChatActivity[]
  startedAt: number
  endedAt?: number
  active: boolean
  failed?: boolean
  projectName?: string
  taskPrompt?: string
}

const INTERNAL_STATUS = /^(preparing the project context|project context is ready|starting the selected model|codex session started|claude session started|inspecting the workspace|workspace task complete|preparing the final result|claude finished the workspace task|project step finished)$/i

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`
}

function eventDurationLabel(item: WorkspaceActivityFeedItem, now: number): string {
  const duration = workspaceActivityDurationMs(item, now)
  return duration === null ? '' : elapsedLabel(duration)
}

function activityHeadline(activity: ChatActivity): string {
  if (activity.kind === 'reasoning') return activity.label || 'Reasoning about the next action'
  if (activity.kind === 'plan') return activity.label || 'Updating the plan'
  if (activity.kind === 'file' && !/^(created|updated|deleted|renamed)\s/i.test(activity.label)) {
    return activity.status === 'running' ? `Editing ${activity.label}` : `Updated ${activity.label}`
  }
  return activity.label
}

function activityDetail(activity: ChatActivity): string | undefined {
  const detail = activity.detail?.trim()
  if (!detail || detail === activity.label.trim()) return undefined
  return detail
}

function WorkspaceActivity({
  activities,
  startedAt,
  endedAt,
  active,
  failed = false
}: WorkspaceActivityProps): JSX.Element {
  const documentVisible = useDocumentVisible()
  const [now, setNow] = useState(Date.now())
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!active || !documentVisible) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active, documentVisible])

  useEffect(() => {
    if (active) setExpanded(false)
  }, [active])

  const feed = useMemo(
    () => buildWorkspaceActivityFeed(activities).filter((item) => !INTERNAL_STATUS.test(item.activity.label.trim())),
    [activities]
  )
  const commentaries = useMemo(
    () => feed.filter((item) => item.activity.kind === 'commentary'),
    [feed]
  )
  const actions = useMemo(
    () => feed.filter((item) => item.activity.kind !== 'commentary'),
    [feed]
  )
  const latestCommentary = commentaries.at(-1)?.activity
  const latestAction = actions.at(-1)
  const recordedEnd = feed.reduce(
    (latest, item) => Math.max(latest, item.endedAt ?? item.activity.timestamp),
    startedAt
  )
  const elapsedUntil = active ? now : endedAt ?? recordedEnd
  const statusText = active
    ? `Working for ${elapsedLabel(elapsedUntil - startedAt)}`
    : failed
      ? `Stopped after ${elapsedLabel(elapsedUntil - startedAt)}`
      : `Worked for ${elapsedLabel(elapsedUntil - startedAt)}`
  const waiting = active && now - (latestAction?.endedAt ?? latestAction?.activity.timestamp ?? startedAt) >= 20_000
  const liveAnnouncement = latestAction
    ? `${activityHeadline(latestAction.activity)}${activityDetail(latestAction.activity) ? `. ${activityDetail(latestAction.activity)}` : ''}`
    : latestCommentary?.label ?? statusText

  return (
    <section className={`workspace-activity ${active ? 'is-active' : failed ? 'is-failed' : 'is-complete'}`}>
      <div className="workspace-activity-header">
        <button
          type="button"
          className="workspace-duration"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {statusText}<span aria-hidden="true">{expanded ? '⌄' : '›'}</span>
        </button>
        {waiting ? <span className="workspace-activity-last-update">Waiting for the selected CLI…</span> : null}
      </div>

      {active && latestCommentary ? (
        <p className="workspace-activity-narrative">{latestCommentary.label}</p>
      ) : null}

      {active && latestAction ? (
        <div className="workspace-activity-current" role="status" aria-live="polite">
          <span aria-hidden="true" />
          <div>
            <strong>{activityHeadline(latestAction.activity)}</strong>
            {activityDetail(latestAction.activity) ? <small>{activityDetail(latestAction.activity)}</small> : null}
          </div>
        </div>
      ) : null}

      {expanded ? (
        <div className="workspace-activity-feed" aria-label="Workspace activity">
          {feed.map((item) => {
            const current = active && item.id === (latestAction?.id ?? commentaries.at(-1)?.id)
            const state = item.activity.status === 'error' || item.activity.kind === 'warning'
              ? 'error'
              : item.activity.status ?? 'running'
            const duration = eventDurationLabel(item, now)
            return (
              <article
                className={`workspace-activity-event is-${state}${current ? ' is-current' : ''}`}
                aria-current={current ? 'step' : undefined}
                key={item.id}
              >
                <div className="workspace-activity-event-line">
                  <strong>{activityHeadline(item.activity)}</strong>
                  {duration ? <time>{duration}</time> : null}
                </div>
                {activityDetail(item.activity) ? (
                  <p className="workspace-activity-event-detail">{activityDetail(item.activity)}</p>
                ) : null}
              </article>
            )
          })}
          {feed.length === 0 ? <p className="workspace-activity-empty">Preparing the saved project context…</p> : null}
        </div>
      ) : null}

      <span className="workspace-activity-sr" role="status" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </span>
    </section>
  )
}

export default memo(WorkspaceActivity)
