import type { ChatActivity } from '../../preload/index.d'

const MAX_TASK_CHARS = 150
const MAX_DETAIL_CHARS = 260
const MAX_NARRATIVE_CHARS = 380
const MAX_EVENT_NARRATIVE_CHARS = 420

function clean(value: string | undefined, max: number): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}...` : text
}

function sentence(value: string): string {
  if (!value) return ''
  return /[.!?]$/.test(value) ? value : `${value}.`
}

export function buildWorkspaceActivityEventNarrative(
  item: ChatActivity,
  projectName: string,
  taskPrompt = ''
): string {
  const project = clean(projectName, 120) || 'the selected project'
  const task = clean(taskPrompt, MAX_TASK_CHARS)
  const requestedResult = task ? `your request to "${task}"` : 'the requested result'
  const label = clean(item.label, 180) || 'the current workspace action'
  const detail = clean(item.detail, MAX_DETAIL_CHARS)
  const hasDistinctDetail = Boolean(detail && detail.toLocaleLowerCase() !== label.toLocaleLowerCase())
  let narrative: string

  if (item.status === 'error' || item.kind === 'warning') {
    narrative = `I could not complete "${label}" in ${project} while working on ${requestedResult}. ${
      hasDistinctDetail
        ? `The CLI reported ${sentence(detail)}`
        : 'The completed work remains available so this action can be inspected and retried safely.'
    }`
    return clean(narrative, MAX_EVENT_NARRATIVE_CHARS)
  }

  if (item.kind === 'reasoning' || item.kind === 'plan') {
    narrative = item.status === 'complete'
      ? `I finished this planning step for ${requestedResult} in ${project}. ${sentence(detail || label)}`
      : `I am deciding how to carry out ${requestedResult} safely in ${project}. ${sentence(detail || label)}`
    return clean(narrative, MAX_EVENT_NARRATIVE_CHARS)
  }

  if (item.kind === 'file') {
    if (/^Created\s+/i.test(label)) {
      narrative = `I created ${label.replace(/^Created\s+/i, '')} in ${project} as part of ${requestedResult}. ${
        hasDistinctDetail
          ? sentence(detail)
          : 'The new file is now visible in this task\'s working changes for review.'
      }`
    } else if (/^(?:Reading|Inspecting)\s+/i.test(label)) {
      narrative = `I am reading ${label.replace(/^(?:Reading|Inspecting)\s+/i, '')} in ${project} to understand the existing implementation before changing it for ${requestedResult}. ${
        hasDistinctDetail
          ? sentence(detail)
          : `This keeps the next edit grounded in the code already present in ${project}.`
      }`
    } else if (/^(?:Updating|Editing|Writing|Applying)\s+/i.test(label)) {
      narrative = `I am updating ${label.replace(/^(?:Updating|Editing|Writing|Applying)\s+/i, '')} in ${project} to implement ${requestedResult}. ${
        hasDistinctDetail
          ? sentence(detail)
          : 'The resulting file change will be shown in Review as soon as it is detected.'
      }`
    } else {
      narrative = item.status === 'complete'
        ? `I finished the file action "${label}" in ${project} for ${requestedResult}. ${
            hasDistinctDetail ? sentence(detail) : 'Its result is now available to the remaining project steps.'
          }`
        : `I am working with "${label}" in ${project} because it is relevant to ${requestedResult}. ${
            hasDistinctDetail ? sentence(detail) : 'Any resulting edit will be recorded in the live working changes.'
          }`
    }
    return clean(narrative, MAX_EVENT_NARRATIVE_CHARS)
  }

  if (item.kind === 'command') {
    narrative = item.status === 'complete'
      ? `I ran "${label}" in ${project} to inspect or validate the work for ${requestedResult}. ${
          hasDistinctDetail
            ? `The command reported ${sentence(detail)}`
            : 'It finished without additional output, and its completion is recorded for this run.'
        }`
      : `I am running "${label}" in ${project} to inspect or validate the work for ${requestedResult}. ${
          hasDistinctDetail
            ? `The latest command output is ${sentence(detail)}`
            : 'I will use its reported result to decide whether another change or check is needed.'
        }`
    return clean(narrative, MAX_EVENT_NARRATIVE_CHARS)
  }

  if (/^Searching for\s+/i.test(label)) {
    narrative = `I am searching ${project} for ${label.replace(/^Searching for\s+/i, '')} so I can locate the files or references needed for ${requestedResult}. ${
      hasDistinctDetail
        ? `The search reported ${sentence(detail)}`
        : 'The matches will identify the most relevant place to inspect or edit next.'
    }`
  } else if (/session started|starting the selected (?:model|cli)/i.test(label)) {
    narrative = `I am connecting the selected CLI to ${project} and giving it ${requestedResult}. ${
      hasDistinctDetail
        ? sentence(detail)
        : 'The next update will describe the first concrete project action it reports.'
    }`
  } else if (/finish|complete|preparing the final result/i.test(label)) {
    narrative = `I have reached "${label}" after working on ${requestedResult} in ${project}. ${
      hasDistinctDetail
        ? sentence(detail)
        : 'I am collecting the reported changes and checks into the final response.'
    }`
  } else {
    narrative = item.status === 'complete'
      ? `I completed "${label}" in ${project} while working on ${requestedResult}. ${
          hasDistinctDetail ? sentence(detail) : 'That result is now recorded in the chronological activity for this run.'
        }`
      : `I am handling "${label}" in ${project} because it contributes to ${requestedResult}. ${
          hasDistinctDetail ? sentence(detail) : 'I will update this entry when the CLI reports a concrete outcome.'
        }`
  }
  return clean(narrative, MAX_EVENT_NARRATIVE_CHARS)
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
