import type { ChatActivity } from '../../preload/index.d'

const MAX_TASK_CHARS = 220
const MAX_DETAIL_CHARS = 180
const MAX_ACTIVITY_EVENTS = 4
const MAX_NARRATIVE_CHARS = 1_300

function clean(value: string | undefined, max: number): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function sentence(value: string): string {
  if (!value) return ''
  return /[.!?…]$/.test(value) ? value : `${value}.`
}

function activitySentence(item: ChatActivity, projectName: string): string {
  const label = clean(item.label, MAX_DETAIL_CHARS)
  const detail = clean(item.detail, MAX_DETAIL_CHARS)
  const reported = detail && detail.toLocaleLowerCase() !== label.toLocaleLowerCase()
    ? ` ${sentence(detail)}`
    : ''

  if (item.status === 'error' || item.kind === 'warning') {
    return `The CLI reported a problem in ${projectName} while handling “${label || 'the current action'}”.${reported}`
  }
  if (item.kind === 'file') {
    return item.status === 'complete'
      ? `The file action “${label}” finished in ${projectName}, so its actual result is available for the next decision.${reported}`
      : `The CLI is currently performing the file action “${label}” inside ${projectName}.${reported}`
  }
  if (item.kind === 'command') {
    return item.status === 'complete'
      ? `The command “${label}” finished inside ${projectName}.${reported || ' Its result is available for validation.'}`
      : `The command “${label}” is running inside ${projectName}.${reported}`
  }
  if (item.kind === 'reasoning' || item.kind === 'plan') {
    return `The model’s latest reported ${item.kind === 'plan' ? 'plan update' : 'reasoning update'} is: ${sentence(detail || label)}`
  }
  if (/starting the selected model|session started|inspecting the workspace/i.test(label)) {
    return `The selected CLI is connected to the trusted ${projectName} working directory and has started processing the request.`
  }
  if (/finished|complete/i.test(label) || item.status === 'complete') {
    return `The CLI completed “${label}” in ${projectName}.${reported}`
  }
  return `The CLI is reporting “${label || 'a workspace action'}” while it works in ${projectName}.${reported}`
}

function recentDistinctActivities(activities: ChatActivity[]): ChatActivity[] {
  const latest = new Map<string, ChatActivity>()
  for (const item of activities) {
    if (/^(workspace task complete|project step finished)$/i.test(item.label.trim())) continue
    const key = `${item.kind}:${item.label.replace(/\s+/g, ' ').trim().toLocaleLowerCase()}`
    latest.delete(key)
    latest.set(key, item)
  }
  return [...latest.values()].slice(-MAX_ACTIVITY_EVENTS)
}

export function buildWorkspaceActivityNarrative(input: {
  activities: ChatActivity[]
  projectName: string
  taskPrompt?: string
  active: boolean
  failed: boolean
}): string {
  const projectName = clean(input.projectName, 120) || 'the selected project'
  const task = clean(input.taskPrompt, MAX_TASK_CHARS)
  const state = input.failed ? 'stopped while working' : input.active ? 'is working' : 'worked'
  const lead = task
    ? `Akorith ${state} in ${projectName} on this request: “${task}”.`
    : `Akorith ${state} on the current request inside ${projectName}.`
  const scope = `The selected CLI is working from this project directory, and this live account is assembled from the file, command, reasoning, and validation events it actually reports.`
  const events = recentDistinctActivities(input.activities)
  const evidence = events.length > 0
    ? events.map((item) => activitySentence(item, projectName)).join(' ')
    : input.active
      ? `Akorith has passed the project-scoped request to the selected CLI and is waiting for its first concrete workspace event.`
      : `No additional workspace event was reported before this turn ended.`
  const tail = input.active
    ? `As another concrete event arrives, this paragraph will update in place; the final response will summarize only the resulting files, checks, and reported outcome.`
    : input.failed
      ? `The project remains available for review, and the reported problem can be used for a focused retry.`
      : `The completed response below carries the provider’s final result and any verified file-change evidence.`
  const narrative = `${lead} ${scope} ${evidence} ${tail}`.replace(/\s+/g, ' ').trim()
  return clean(narrative, MAX_NARRATIVE_CHARS)
}
