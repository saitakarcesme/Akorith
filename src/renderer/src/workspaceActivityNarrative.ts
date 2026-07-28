import type { ChatActivity } from '../../preload/index.d'

const MAX_TASK_CHARS = 150
const MAX_NARRATIVE_CHARS = 380
const MAX_EVENT_NARRATIVE_CHARS = 240

function clean(value: string | undefined, max: number): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text
}

function clause(value: string): string {
  return value.replace(/[.!?]+$/, '').trim()
}

export function buildWorkspaceActivityEventNarrative(
  item: ChatActivity,
  projectName: string
): string {
  const project = clean(projectName, 120) || 'the selected project'
  const label = clean(item.label, 180) || 'the current workspace action'
  const detail = clean(item.detail, 180)
  const distinctDetail = detail && detail.toLocaleLowerCase() !== label.toLocaleLowerCase()
    ? clause(detail)
    : ''

  if (item.status === 'error' || item.kind === 'warning') {
    return clean(
      `I could not complete "${label}" in ${project}; ${distinctDetail || 'the reported problem remains available for a focused retry'}.`,
      MAX_EVENT_NARRATIVE_CHARS
    )
  }

  if (item.kind === 'reasoning' || item.kind === 'plan') {
    const action = item.status === 'complete' ? 'I finished this planning step' : 'I am planning the next safe action'
    return clean(`${action} in ${project}${distinctDetail ? `: ${distinctDetail}` : ''}.`, MAX_EVENT_NARRATIVE_CHARS)
  }

  if (item.kind === 'file') {
    if (/^Created\s+/i.test(label)) {
      return clean(`I created ${label.replace(/^Created\s+/i, '')} in ${project}; it is now available in Review.`, MAX_EVENT_NARRATIVE_CHARS)
    }
    if (/^(?:Reading|Inspecting)\s+/i.test(label)) {
      const file = label.replace(/^(?:Reading|Inspecting)\s+/i, '')
      return clean(
        `I am reading ${file} in ${project} to understand the existing implementation${distinctDetail ? `; ${distinctDetail}` : ''}.`,
        MAX_EVENT_NARRATIVE_CHARS
      )
    }
    if (/^(?:Updating|Editing|Writing|Applying)\s+/i.test(label)) {
      const file = label.replace(/^(?:Updating|Editing|Writing|Applying)\s+/i, '')
      return clean(`I am updating ${file} in ${project}; the change will appear in Review.`, MAX_EVENT_NARRATIVE_CHARS)
    }
    return clean(
      item.status === 'complete'
        ? `This file action finished in ${project}${distinctDetail ? `; ${distinctDetail}` : ''}.`
        : `I am working with this file in ${project}${distinctDetail ? `; ${distinctDetail}` : ''}.`,
      MAX_EVENT_NARRATIVE_CHARS
    )
  }

  if (item.kind === 'command') {
    if (item.status === 'complete') {
      const result = distinctDetail && !/^\(?no output\)?$/i.test(distinctDetail)
        ? `; it reported ${distinctDetail}`
        : distinctDetail
          ? '; it finished without output'
          : ''
      return clean(`The command finished in ${project}${result}.`, MAX_EVENT_NARRATIVE_CHARS)
    }
    return clean(
      `The command is running in ${project}${distinctDetail ? `; latest output: ${distinctDetail}` : ''}.`,
      MAX_EVENT_NARRATIVE_CHARS
    )
  }

  if (/^Searching for\s+/i.test(label)) {
    return clean(`I am searching ${project} to locate the files needed for the next action.`, MAX_EVENT_NARRATIVE_CHARS)
  }
  if (/session started|starting the selected (?:model|cli)/i.test(label)) {
    return clean(`I connected the selected CLI to ${project} and am waiting for its first concrete action.`, MAX_EVENT_NARRATIVE_CHARS)
  }
  if (/finish|complete|preparing the final result/i.test(label)) {
    return clean(`I finished this action in ${project} and am collecting its reported result.`, MAX_EVENT_NARRATIVE_CHARS)
  }
  return clean(
    item.status === 'complete'
      ? `I completed this action in ${project}${distinctDetail ? `; ${distinctDetail}` : ''}.`
      : `I am handling this action in ${project}${distinctDetail ? `; ${distinctDetail}` : ''}.`,
    MAX_EVENT_NARRATIVE_CHARS
  )
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
    ? `Akorith ${state} in ${projectName} on "${task}".`
    : `Akorith ${state} on the current request in ${projectName}.`
  const hasEvidence = input.activities.some((item) =>
    !/^(workspace task complete|project step finished)$/i.test(item.label.trim()))
  const tail = input.active && hasEvidence
    ? 'The live updates above reflect the CLI\'s reported actions and refresh with its next concrete event.'
    : input.active
      ? 'The selected CLI is connected and waiting for its first concrete project event.'
      : input.failed
        ? 'The reported state remains available for a focused retry.'
        : 'The final response below contains the reported result.'
  return clean(`${lead} ${tail}`.replace(/\s+/g, ' ').trim(), MAX_NARRATIVE_CHARS)
}
