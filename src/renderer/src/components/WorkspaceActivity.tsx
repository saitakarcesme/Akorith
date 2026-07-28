import React, { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatActivity } from '../../../preload/index.d'
import { useDocumentVisible } from '../documentVisibility'
import {
  buildWorkspaceActivityFeed,
  workspaceActivityDurationMs,
  type WorkspaceActivityFeedItem,
  type WorkspaceActivityPhase
} from '../workspaceActivityFeed'
import { buildWorkspaceActivityEventNarrative } from '../workspaceActivityNarrative'
import {
  FileIcon,
  GlobeIcon,
  PanelsIcon,
  PlanIcon,
  SearchIcon,
  SparkIcon,
  StopIcon
} from './icons'

interface WorkspaceActivityProps {
  activities: ChatActivity[]
  startedAt: number
  endedAt?: number
  active: boolean
  failed?: boolean
  projectName?: string
  taskPrompt?: string
}

const NARRATIVE_REVEAL_INTERVAL_MS = 38
const NARRATIVE_REVEAL_STEPS = 12

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

function statusLabel(item: ChatActivity): string {
  if (item.status === 'error' || item.kind === 'warning') return 'Failed'
  if (item.status === 'complete') return 'Done'
  return 'Running'
}

function ActivityIcon({ item }: { item: ChatActivity }): JSX.Element {
  if (item.kind === 'warning' || item.status === 'error') return <StopIcon size={14} />
  if (item.surface === 'browser' || item.surface === 'computer') return <GlobeIcon size={14} />
  if (item.kind === 'file') return <FileIcon size={14} />
  if (item.kind === 'command') return <PanelsIcon size={14} />
  if (item.kind === 'plan') return <PlanIcon size={14} />
  if (item.kind === 'reasoning') return <SparkIcon size={14} />
  if (/search/i.test(item.label)) return <SearchIcon size={14} />
  return <SparkIcon size={14} />
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

const PHASE_LABELS: Record<WorkspaceActivityPhase, string> = {
  plan: 'Plan',
  actions: 'Actions',
  result: 'Result'
}

function WorkspaceActivity({
  activities,
  startedAt,
  endedAt,
  active,
  failed = false,
  projectName = 'the selected project',
  taskPrompt = ''
}: WorkspaceActivityProps): JSX.Element {
  const documentVisible = useDocumentVisible()
  const [now, setNow] = useState(Date.now())
  const [collapsed, setCollapsed] = useState(!active)
  const [collapsedEvents, setCollapsedEvents] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!active || !documentVisible) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active, documentVisible])

  useEffect(() => {
    setCollapsed(!active)
  }, [active])

  useEffect(() => {
    setCollapsedEvents(new Set())
  }, [startedAt])

  const feed = useMemo(() => buildWorkspaceActivityFeed(activities), [activities])
  const byPhase = useMemo(() => {
    const groups: Record<WorkspaceActivityPhase, WorkspaceActivityFeedItem[]> = {
      plan: [],
      actions: [],
      result: []
    }
    for (const item of feed) groups[item.phase].push(item)
    return groups
  }, [feed])
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
  const latestFeedItem = feed.reduce<WorkspaceActivityFeedItem | undefined>((latest, item) => {
    if (!latest) return item
    const latestAt = latest.endedAt ?? latest.activity.timestamp
    const itemAt = item.endedAt ?? item.activity.timestamp
    return itemAt >= latestAt ? item : latest
  }, undefined)
  const latestActivity = latestFeedItem?.activity
  const latestActivityAt = latestFeedItem?.endedAt ?? latestActivity?.timestamp
  const lastActivityAgeMs = active
    ? Math.max(0, now - (latestActivityAt ?? startedAt))
    : 0
  const waiting = active && lastActivityAgeMs >= 20_000
  const lastActivityAge = latestActivity && active
    ? `Last activity ${elapsedLabel(lastActivityAgeMs)} ago`
    : active
      ? `Waiting ${elapsedLabel(lastActivityAgeMs)} for the first activity`
    : ''
  const liveAnnouncement = latestActivity
    ? `${latestActivity.label}${latestActivity.detail ? `. ${latestActivity.detail}` : ''}`
    : active
      ? `Akorith started working in ${projectName}.`
      : statusText
  const latestId = latestFeedItem?.id

  const toggleEvent = (id: string): void => {
    setCollapsedEvents((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const renderEvent = (item: WorkspaceActivityFeedItem): JSX.Element => {
    const eventCollapsed = collapsedEvents.has(item.id)
    const itemStatus = item.activity.status === 'error' || item.activity.kind === 'warning'
      ? 'error'
      : item.activity.status ?? 'running'
    const duration = eventDurationLabel(item, now)
    const narrative = buildWorkspaceActivityEventNarrative(item.activity, projectName, taskPrompt)

    return (
      <article
        className={`workspace-activity-event is-${itemStatus}${active && item.id === latestId ? ' is-current' : ''}`}
        key={item.id}
      >
        <button
          type="button"
          className="workspace-activity-event-toggle"
          aria-expanded={!eventCollapsed}
          onClick={() => toggleEvent(item.id)}
        >
          <span className="workspace-activity-event-icon" aria-hidden="true">
            <ActivityIcon item={item.activity} />
          </span>
          <strong>{activityHeadline(item.activity)}</strong>
          <span className={`workspace-activity-event-badge is-${itemStatus}`}>
            {statusLabel(item.activity)}
          </span>
          {duration && <time className="workspace-activity-event-duration">{duration}</time>}
          <span className="workspace-activity-event-chevron" aria-hidden="true">
            {eventCollapsed ? '›' : '⌄'}
          </span>
        </button>
        <div
          className={`workspace-activity-event-body ${eventCollapsed ? '' : 'is-open'}`}
          aria-hidden={eventCollapsed}
        >
          <div>
            <p className="workspace-activity-event-detail">
              {item.id === latestId
                ? <ProgressiveNarrative text={narrative} animate={active} />
                : narrative}
            </p>
            {item.activity.kind === 'command' && item.activity.detail && (
              <pre className="workspace-activity-command-output">{item.activity.detail}</pre>
            )}
          </div>
        </div>
      </article>
    )
  }

  return (
    <section className={`workspace-activity ${active ? `is-active${waiting ? ' is-waiting' : ''}` : failed ? 'is-failed' : 'is-complete'}`}>
      <div className="workspace-activity-header">
        <button
          type="button"
          className="workspace-duration"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {statusText}<span aria-hidden="true">{collapsed ? '›' : '⌄'}</span>
        </button>
        <span className={`workspace-activity-status is-${active ? waiting ? 'waiting' : 'running' : failed ? 'error' : 'complete'}`}>
          {active ? waiting ? 'Waiting' : 'Running' : failed ? 'Failed' : 'Completed'}
        </span>
        {lastActivityAge && <span className="workspace-activity-last-update">{lastActivityAge}</span>}
      </div>
      {!collapsed && <div className="workspace-activity-rule" />}
      {!collapsed && (
        <div className="workspace-activity-feed" aria-label="Workspace activity">
          {taskPrompt.trim() && (
            <section className="workspace-activity-phase is-prompt">
              <h3>Prompt</h3>
              <p>{taskPrompt.trim()}</p>
            </section>
          )}
          {(['plan', 'actions', 'result'] as const).map((phase) => {
            const items = byPhase[phase]
            if (items.length === 0) return null
            return (
              <section className={`workspace-activity-phase is-${phase}`} key={phase}>
                <h3>{PHASE_LABELS[phase]}</h3>
                <div className="workspace-activity-events">
                  {items.map(renderEvent)}
                </div>
              </section>
            )
          })}
          {feed.length === 0 && active && (
            <section className="workspace-activity-phase is-plan">
              <h3>Plan</h3>
              <p>I am connecting the selected CLI to {projectName} and waiting for its first concrete project action.</p>
            </section>
          )}
          {byPhase.result.length === 0 && !active && (
            <section className={`workspace-activity-phase is-result ${failed ? 'is-error' : 'is-complete'}`}>
              <h3>Result</h3>
              <p>
                {failed
                  ? 'The run stopped before a final result was saved. Its reported actions remain available for a focused retry.'
                  : 'The run finished, and the final response contains the resulting files, checks, and reported outcome.'}
              </p>
            </section>
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
