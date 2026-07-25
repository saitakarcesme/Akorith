import type { ChatActivity } from '../../preload/index.d'

export type WorkspaceWorkflowState = 'waiting' | 'running' | 'complete' | 'error'

export interface WorkspaceWorkflowStep {
  id: string
  title: string
  description: string
  state: WorkspaceWorkflowState
}

interface DeriveWorkspaceWorkflowOptions {
  prompt: string
  projectName?: string
  activities: ChatActivity[]
  active: boolean
  failed?: boolean
}

const BOILERPLATE_ACTIVITY = /^(starting the selected model|(?:claude|codex) session started|workspace task complete|(?:claude|codex) finished the workspace task|preparing the final result|project step finished)$/i

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

function sentence(value: string): string {
  const normalized = value.trim()
  if (!normalized) return ''
  return /[.!?…]$/.test(normalized) ? normalized : `${normalized}.`
}

function headline(value: string): string {
  return value ? `${value[0].toLocaleUpperCase()}${value.slice(1)}` : value
}

function requestTitle(prompt: string, projectName: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
  const direct = firstLine
    .replace(/^(?:please\s+)?(?:i\s+)?(?:want|need|would like)(?:\s+you)?\s+to\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim()
  return headline(compact(direct || `Work on ${projectName}`, 68))
}

function requestDescription(prompt: string, projectName: string): string {
  const request = compact(prompt, 220)
  if (!request) {
    return `Akorith is carrying out the current request inside ${projectName}. The workflow below is built from recorded project activity rather than a fixed phase template.`
  }
  return `The requested outcome for ${projectName} is: ${sentence(request)} The remaining steps are built from the selected model's recorded project activity.`
}

function fileDisplay(label: string): string {
  const files = label
    .split(',')
    .map((entry) => entry.trim().split(/[\\/]/).filter(Boolean).at(-1) ?? entry.trim())
    .filter(Boolean)
  return compact(files.slice(0, 2).join(', ') || label, 58)
}

function activityTitle(item: ChatActivity, projectName: string, goal: string): string {
  const label = compact(item.label, 100)
  if (/^inspecting the workspace$/i.test(label)) return `Inspect ${projectName}`
  if (item.kind === 'file') return `Work on ${fileDisplay(label)}`
  if (item.kind === 'command') {
    const verb = /\b(?:test|check|verify|build|lint|typecheck)\b/i.test(label) ? 'Validate with' : 'Run'
    return `${verb} ${compact(label, 58)}`
  }
  if (item.kind === 'warning') return `Resolve ${compact(label, 58)}`
  if (item.kind === 'tool' && /^using\s+/i.test(label)) {
    return compact(`${label.replace(/^using\s+/i, 'Use ')} for ${goal}`, 68)
  }
  return compact(label, 68)
}

function activityDescription(item: ChatActivity, projectName: string, goal: string): string {
  const detail = item.detail && item.detail.trim() && item.detail.trim() !== item.label.trim()
    ? compact(item.detail, 120)
    : ''

  if (item.kind === 'command') {
    const purpose = /\b(?:test|check|verify|build|lint|typecheck)\b/i.test(item.label)
      ? 'It checks the current result against the project’s own validation path.'
      : 'Its output becomes evidence for the next project decision.'
    return `Akorith is running this command inside ${projectName}, within the selected project boundary. ${purpose}${detail ? ` The provider runs it through ${detail}.` : ''}`
  }
  if (item.kind === 'file') {
    return `This step reads or updates the recorded project file inside ${projectName}. It supports “${goal}” while keeping the surrounding project context available.${detail ? ` The provider reported: ${sentence(detail)}` : ''}`
  }
  if (item.kind === 'plan' || item.kind === 'reasoning') {
    return `The selected model identified this direction while connecting “${goal}” to the current state of ${projectName}. It is a task-specific decision captured from the live run, not a preset Akorith phase.${detail ? ` Additional context: ${sentence(detail)}` : ''}`
  }
  if (item.kind === 'warning' || item.status === 'error') {
    return `This recorded step needs attention before Akorith can safely finish “${goal}” in ${projectName}. The existing project context is preserved so the issue can be reviewed or retried.${detail ? ` Reported detail: ${sentence(detail)}` : ''}`
  }
  if (/session started/i.test(item.label)) {
    return `Akorith connected the selected local CLI to ${projectName} and established the project-scoped session. The request and its bounded workspace context are now available to that provider.`
  }
  if (/prepar|starting/i.test(item.label)) {
    return `Akorith is loading ${projectName}, its conversation memory, and the selected local CLI. This establishes the bounded context required before any project action begins.`
  }
  if (/finish|complete/i.test(item.label) || item.status === 'complete') {
    return `This recorded unit of work finished inside ${projectName}. Its files, command results, and provider explanation remain available to the final answer and continuing project memory.${detail ? ` Recorded detail: ${sentence(detail)}` : ''}`
  }
  return `Akorith recorded this action while working toward “${goal}” in ${projectName}. It describes the live provider activity that currently determines the project workflow.${detail ? ` Provider detail: ${sentence(detail)}` : ''}`
}

function meaningfulActivities(activities: ChatActivity[]): ChatActivity[] {
  const ordered: ChatActivity[] = []
  const positions = new Map<string, number>()

  for (const item of activities) {
    if (BOILERPLATE_ACTIVITY.test(item.label.trim())) continue
    const key = `${item.kind}:${item.label.replace(/\s+/g, ' ').trim().toLowerCase()}`
    const existing = positions.get(key)
    if (existing === undefined) {
      positions.set(key, ordered.length)
      ordered.push(item)
    } else {
      ordered[existing] = { ...ordered[existing], ...item }
    }
  }

  if (ordered.length <= 6) return ordered
  return [...ordered.slice(0, 4), ...ordered.slice(-2)]
}

export function deriveWorkspaceWorkflow({
  prompt,
  projectName = 'the selected project',
  activities,
  active,
  failed = false
}: DeriveWorkspaceWorkflowOptions): WorkspaceWorkflowStep[] {
  const goal = requestTitle(prompt, projectName)
  const recorded = meaningfulActivities(activities)
  const goalState: WorkspaceWorkflowState = failed && recorded.length === 0
    ? 'error'
    : active && recorded.length === 0
      ? 'running'
      : 'complete'
  const steps: WorkspaceWorkflowStep[] = [{
    id: 'request',
    title: goal,
    description: requestDescription(prompt, projectName),
    state: goalState
  }]

  recorded.forEach((item, index) => {
    let state: WorkspaceWorkflowState
    if (item.status === 'error' || item.kind === 'warning') state = 'error'
    else if (!active) state = failed && index === recorded.length - 1 ? 'error' : 'complete'
    else if (index < recorded.length - 1 || item.status === 'complete') state = 'complete'
    else state = 'running'

    steps.push({
      id: `${item.kind}:${compact(item.label, 80).toLowerCase()}`,
      title: activityTitle(item, projectName, goal),
      description: activityDescription(item, projectName, goal),
      state
    })
  })

  return steps
}
