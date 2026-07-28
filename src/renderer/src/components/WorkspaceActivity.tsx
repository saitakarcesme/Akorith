import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatActivity } from '../../../preload/index.d'
import { useDocumentVisible } from '../documentVisibility'
import {
  buildWorkspaceActivityFeed,
  workspaceActivityDurationMs,
  type WorkspaceActivityFeedItem
} from '../workspaceActivityFeed'
import { buildWorkspaceActivityEventNarrative } from '../workspaceActivityNarrative'

interface WorkspaceActivityProps {
  activities: ChatActivity[]
  startedAt: number
  endedAt?: number
  active: boolean
  failed?: boolean
  projectName?: string
}

const NARRATIVE_REVEAL_INTERVAL_MS = 38
const NARRATIVE_REVEAL_STEPS = 12
const REDUNDANT_EVENT = /^(workspace task complete|project step finished)$/i

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

function sharedPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

function activityHeadline(item: ChatActivity): string {
  if (/^Created\s+/i.test(item.label)) return item.label
  if (item.kind === 'reasoning') return 'Reasoning about the next action'
  if (item.kind === 'plan') return 'Updating the plan'
  if (item.label === 'Starting the selected model') return 'Starting the selected CLI'
  return item.label
}

function ProgressiveNarrative({ text, animate }: { text: string; animate: boolean }): JSX.Element {
  const [visible, setVisible] = useState(animate ? '' : text)
  const visibleRef = useRef(visible)

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!animate || reducedMotion || document.hidden) {
      visibleRef.current = text
      setVisible(text)
      return
    }

    const current = visibleRef.current
    const start = text.startsWith(current) ? current.length : sharedPrefixLength(current, text)
    const initial = text.slice(0, start)
    visibleRef.current = initial
    setVisible(initial)
    if (start >= text.length) return

    const step = Math.max(10, Math.ceil((text.length - start) / NARRATIVE_REVEAL_STEPS))
    let cursor = start
    const timer = window.setInterval(() => {
      if (document.hidden) {
        visibleRef.current = text
        setVisible(text)
        window.clearInterval(timer)
        return
      }
      cursor = Math.min(text.length, cursor + step)
      const next = text.slice(0, cursor)
      visibleRef.current = next
      setVisible(next)
      if (cursor >= text.length) window.clearInterval(timer)
    }, NARRATIVE_REVEAL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [animate, text])

  return <>{visible}</>
}

function WorkspaceActivity({
  activities,
  startedAt,
  endedAt,
  active,
  failed = false,
  projectName = 'the selected project'
}: WorkspaceActivityProps): JSX.Element {
  const documentVisible = useDocumentVisible()
  const [now, setNow] = useState(Date.now())
  const [collapsed, setCollapsed] = useState(!active)

  useEffect(() => {
    if (!active || !documentVisible) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active, documentVisible])

  useEffect(() => {
    setCollapsed(!active)
  }, [active])

  const feed = useMemo(
    () => buildWorkspaceActivityFeed(activities).filter((item) => !REDUNDANT_EVENT.test(item.activity.label.trim())),
    [activities]
  )
  const recordedEnd = useMemo(
    () => feed.reduce((latest, item) => Math.max(latest, item.endedAt ?? item.activity.timestamp), startedAt),
    [feed, startedAt]
  )
  const elapsedUntil = active ? now : endedAt ?? recordedEnd
  const statusText = active
    ? `Working for ${elapsedLabel(elapsedUntil - startedAt)}`
    : failed
      ? `Stopped after ${elapsedLabel(elapsedUntil - startedAt)}`
      : `Worked for ${elapsedLabel(elapsedUntil - startedAt)}`
  const latest = feed.at(-1)
  const latestActivityAt = latest?.endedAt ?? latest?.activity.timestamp ?? startedAt
  const waiting = active && now - latestActivityAt >= 20_000
  const latestActivity = latest?.activity
  const liveAnnouncement = latestActivity
    ? `${latestActivity.label}${latestActivity.detail ? `. ${latestActivity.detail}` : ''}`
    : active
      ? `Akorith started working in ${projectName}.`
      : statusText

  return (
    <section className={`workspace-activity ${active ? 'is-active' : failed ? 'is-failed' : 'is-complete'}`}>
      <div className="workspace-activity-header">
        <button
          type="button"
          className="workspace-duration"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {statusText}<span aria-hidden="true">{collapsed ? '›' : '⌄'}</span>
        </button>
        {waiting && <span className="workspace-activity-last-update">Last activity {elapsedLabel(now - latestActivityAt)} ago</span>}
      </div>
      {!collapsed && <div className="workspace-activity-rule" />}
      {!collapsed && (
        <div className="workspace-activity-feed" aria-label="Workspace activity">
          {feed.map((item) => {
            const current = active && item.id === latest?.id
            const duration = eventDurationLabel(item, now)
            const narrative = buildWorkspaceActivityEventNarrative(item.activity, projectName)
            const state = item.activity.status === 'error' || item.activity.kind === 'warning'
              ? 'error'
              : item.activity.status ?? 'running'
            return (
              <article
                className={`workspace-activity-event is-${state}${current ? ' is-current' : ''}`}
                aria-current={current ? 'step' : undefined}
                key={item.id}
              >
                <div className="workspace-activity-event-line">
                  <strong>{activityHeadline(item.activity)}</strong>
                  {duration && <time>{duration}</time>}
                </div>
                <p className="workspace-activity-event-detail">
                  {current
                    ? <ProgressiveNarrative text={narrative} animate />
                    : narrative}
                </p>
              </article>
            )
          })}
          {feed.length === 0 && active && (
            <p className="workspace-activity-empty">
              I am connecting the selected CLI to {projectName} and waiting for its first concrete project action.
            </p>
          )}
          <span className="workspace-activity-sr" role="status" aria-live="polite" aria-atomic="true">
            {liveAnnouncement}
          </span>
        </div>
      )}
    </section>
  )
}

export default memo(WorkspaceActivity)
