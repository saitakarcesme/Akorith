import type { ChatActivity } from '../../preload/index.d'

export type WorkspaceActivityPhase = 'plan' | 'actions' | 'result'

export interface WorkspaceActivityFeedItem {
  id: string
  phase: WorkspaceActivityPhase
  activity: ChatActivity
  startedAt: number
  endedAt?: number
}

type IdentifiedActivity = ChatActivity & {
  id?: string
  startedAt?: number
  endedAt?: number
}

function providedId(activity: ChatActivity): string | undefined {
  const id = (activity as IdentifiedActivity).id
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

function activityStartedAt(activity: ChatActivity): number {
  const startedAt = (activity as IdentifiedActivity).startedAt
  return typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : activity.timestamp
}

function activityEndedAt(activity: ChatActivity): number | undefined {
  const endedAt = (activity as IdentifiedActivity).endedAt
  return typeof endedAt === 'number' && Number.isFinite(endedAt) ? endedAt : undefined
}

function normalizedLabel(activity: ChatActivity): string {
  return activity.label.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function activityKey(activity: ChatActivity): string {
  return providedId(activity) ?? `${activity.kind}:${normalizedLabel(activity)}`
}

function phaseFor(activity: ChatActivity): WorkspaceActivityPhase {
  if (activity.kind === 'plan' || activity.kind === 'reasoning') return 'plan'
  if (/starting the selected (?:model|cli)|session started/i.test(activity.label.trim())) return 'plan'
  if (
    /(?:workspace task complete|preparing the final result|finished the workspace task|project step finished)$/i
      .test(activity.label.trim())
  ) {
    return 'result'
  }
  return 'actions'
}

/**
 * Maintains a bounded renderer transcript without losing lifecycle identity.
 * Stable provider IDs win; legacy providers fall back to the most-recent open
 * event with the same normalized kind and label.
 */
export function mergeWorkspaceActivityEvent(
  current: ChatActivity[],
  incoming: ChatActivity,
  max = 80
): ChatActivity[] {
  const incomingId = providedId(incoming)
  let match = -1
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const candidate = current[index]
    if (incomingId) {
      if (providedId(candidate) === incomingId) {
        match = index
        break
      }
    } else if (
      candidate.status === 'running' &&
      candidate.kind === incoming.kind &&
      normalizedLabel(candidate) === normalizedLabel(incoming)
    ) {
      match = index
      break
    }
  }

  let next: ChatActivity[]
  if (match >= 0) {
    const previous = current[match] as IdentifiedActivity
    const terminalAt = incoming.status && incoming.status !== 'running'
      ? incoming.timestamp
      : previous.endedAt
    const merged = {
      ...previous,
      ...incoming,
      id: incomingId ?? previous.id,
      detail: incoming.detail ?? previous.detail,
      timestamp: Math.min(previous.timestamp, incoming.timestamp),
      startedAt: previous.startedAt ?? previous.timestamp,
      ...(terminalAt === undefined ? {} : { endedAt: terminalAt })
    } as ChatActivity
    next = current.map((activity, index) => index === match ? merged : activity)
  } else {
    next = [...current, incoming]
  }

  const limit = Math.max(1, Math.trunc(max))
  return next.length > limit ? next.slice(-limit) : next
}

/**
 * Turns append-only provider events into stable feed entries. Providers commonly
 * report one tool call twice (running, then complete/error) without an ID. Only
 * that most-recent open call is merged; a later repetition remains a distinct
 * chronological event.
 */
export function buildWorkspaceActivityFeed(activities: ChatActivity[]): WorkspaceActivityFeedItem[] {
  const ordered = activities
    .map((activity, index) => ({ activity, index }))
    .sort((left, right) => activityStartedAt(left.activity) - activityStartedAt(right.activity) || left.index - right.index)
  const feed: WorkspaceActivityFeedItem[] = []
  const openByKey = new Map<string, number>()
  const indexByStableId = new Map<string, number>()
  const occurrences = new Map<string, number>()

  for (const { activity } of ordered) {
    const key = activityKey(activity)
    const stableId = providedId(activity)
    const stableIndex = stableId === undefined ? undefined : indexByStableId.get(stableId)
    if (stableIndex !== undefined) {
      const previous = feed[stableIndex]
      const startedAt = Math.min(previous.startedAt, activityStartedAt(activity))
      const suppliedEnd = activityEndedAt(activity)
      feed[stableIndex] = {
        ...previous,
        phase: phaseFor(activity),
        activity: {
          ...previous.activity,
          ...activity,
          detail: activity.detail ?? previous.activity.detail
        },
        startedAt,
        ...(suppliedEnd !== undefined || (activity.status && activity.status !== 'running')
          ? { endedAt: Math.max(suppliedEnd ?? activity.timestamp, startedAt) }
          : {})
      }
      if (activity.status && activity.status !== 'running') openByKey.delete(key)
      else openByKey.set(key, stableIndex)
      continue
    }
    const openIndex = openByKey.get(key)

    if (activity.status !== 'running' && openIndex !== undefined) {
      const open = feed[openIndex]
      feed[openIndex] = {
        ...open,
        phase: phaseFor(activity),
        activity: {
          ...open.activity,
          ...activity,
          detail: activity.detail ?? open.activity.detail
        },
        endedAt: Math.max(activityEndedAt(activity) ?? activity.timestamp, open.startedAt)
      }
      openByKey.delete(key)
      continue
    }

    if (activity.status === 'running' && openIndex !== undefined) {
      const open = feed[openIndex]
      feed[openIndex] = {
        ...open,
        activity: {
          ...open.activity,
          ...activity,
          detail: activity.detail ?? open.activity.detail,
          timestamp: open.activity.timestamp
        }
      }
      continue
    }

    const occurrence = (occurrences.get(key) ?? 0) + 1
    occurrences.set(key, occurrence)
    const startedAt = activityStartedAt(activity)
    const suppliedEnd = activityEndedAt(activity)
    const item: WorkspaceActivityFeedItem = {
      id: providedId(activity) ?? `${key}:${occurrence}`,
      phase: phaseFor(activity),
      activity,
      startedAt,
      ...(suppliedEnd !== undefined
        ? { endedAt: Math.max(suppliedEnd, startedAt) }
        : activity.status && activity.status !== 'running'
          ? { endedAt: activity.timestamp }
          : {})
    }
    feed.push(item)
    if (stableId) indexByStableId.set(stableId, feed.length - 1)
    if (!activity.status || activity.status === 'running') openByKey.set(key, feed.length - 1)
  }

  return feed
}

export function workspaceActivityDurationMs(
  item: WorkspaceActivityFeedItem,
  now: number
): number | null {
  const end = item.endedAt ?? (item.activity.status === 'running' ? now : null)
  if (end === null) return null
  return Math.max(0, end - item.startedAt)
}
