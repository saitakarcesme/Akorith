import type { ChatActivity } from '../../preload/index.d'

const MAX_TASK_CHARS = 150
const MAX_DETAIL_CHARS = 130
const MAX_NARRATIVE_CHARS = 380

function clean(value: string | undefined, max: number): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function sentence(value: string): string {
  if (!value) return ''
  return /[.!?…]$/.test(value) ? value : `${value}.`
}

export function buildWorkspaceActivityEventNarrative(
  item: ChatActivity,
  projectName: string
): string {
  const label = clean(item.label, MAX_DETAIL_CHARS) || 'the current workspace action'
  const detail = clean(item.detail, MAX_DETAIL_CHARS)
  if (item.status === 'error' || item.kind === 'warning') {
    return detail
      ? `The CLI reported: ${sentence(detail)}`
      : `The CLI could not complete “${label}” in ${projectName}.`
  }
  if (item.kind === 'reasoning' || item.kind === 'plan') {
    return sentence(detail || label)
  }
  if (item.kind === 'file') {
    if (/^Created\s+/i.test(label)) return `${sentence(label)} It is now visible in this task's working changes.`
    if (detail && detail.toLocaleLowerCase() !== label.toLocaleLowerCase()) return sentence(detail)
    return item.status === 'complete'
      ? `${sentence(label)} The result is ready for the next project step.`
      : `The CLI is working with “${label}” in ${projectName}.`
  }
  if (item.kind === 'command') {
    if (detail && detail.toLocaleLowerCase() !== label.toLocaleLowerCase()) {
      return `The command reported: ${sentence(detail)}`
    }
    return item.status === 'complete'
      ? `The command finished and its result is available for validation.`
      : `The CLI is running this command in ${projectName}.`
  }
  if (detail && detail.toLocaleLowerCase() !== label.toLocaleLowerCase()) return sentence(detail)
  return item.status === 'complete'
    ? `${sentence(label)} Akorith is using that result for the next step.`
    : `The selected CLI is handling “${label}” in ${projectName}.`
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
    ? `Akorith ${state} in ${projectName} on “${task}”.`
    : `Akorith ${state} on the current request in ${projectName}.`
  const hasEvidence = input.activities.some((item) =>
    !/^(workspace task complete|project step finished)$/i.test(item.label.trim()))
  const tail = input.active && hasEvidence
    ? `The live updates above reflect the CLI’s reported actions and refresh with its next concrete event.`
    : input.active
      ? `The selected CLI is connected and waiting for its first concrete project event.`
    : input.failed
      ? `The reported state remains available for a focused retry.`
      : `The final response below contains the reported result.`
  return clean(`${lead} ${tail}`.replace(/\s+/g, ' ').trim(), MAX_NARRATIVE_CHARS)
}
