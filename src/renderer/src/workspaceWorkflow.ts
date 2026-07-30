import type { ChatActivity } from '../../preload/index.d'

export type WorkspaceWorkflowState = 'waiting' | 'running' | 'complete' | 'error'

export interface WorkspaceWorkflowStep {
  id: string
  title: string
  description: string
  state: WorkspaceWorkflowState
}

export interface WorkspaceWorkflowSnapshot {
  projectId: string
  sessionId: string
  prompt: string
  steps: WorkspaceWorkflowStep[]
  active: boolean
  failed: boolean
  updatedAt: number
}

interface DeriveWorkspaceWorkflowOptions {
  prompt: string
  projectName?: string
  activities: ChatActivity[]
  active: boolean
  failed?: boolean
}

const BOILERPLATE_ACTIVITY = /^(starting the selected model|preparing .+|preparing project context|project context is ready|(?:claude|codex) session started|workspace task complete|(?:claude|codex) finished the workspace task|preparing the final result|project step finished)$/i

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
    return `The selected CLI is carrying out the current request inside ${projectName}.`
  }
  return `Requested in ${projectName}: ${sentence(request)}`
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

function activityDescription(item: ChatActivity, projectName: string): string {
  const detail = item.detail && item.detail.trim() && item.detail.trim() !== item.label.trim()
    ? compact(item.detail, 120)
    : ''

  if (item.kind === 'command') {
    return item.status === 'complete'
      ? `The CLI finished this command in ${projectName}.${detail ? ` Reported output: ${sentence(detail)}` : ''}`
      : `The CLI is running this command in ${projectName}.${detail ? ` Current output: ${sentence(detail)}` : ''}`
  }
  if (item.kind === 'file') {
    return `The CLI reported this file action in ${projectName}.${detail ? ` ${sentence(detail)}` : ''}`
  }
  if (item.kind === 'plan' || item.kind === 'reasoning') {
    return sentence(detail || item.label)
  }
  if (item.kind === 'warning' || item.status === 'error') {
    return `The CLI could not complete this action in ${projectName}.${detail ? ` ${sentence(detail)}` : ''}`
  }
  if (/session started/i.test(item.label)) {
    return `The selected CLI connected to ${projectName} and received the project-scoped request.`
  }
  if (/prepar|starting/i.test(item.label)) {
    return `Akorith started the selected CLI in ${projectName} and is waiting for its first concrete action.`
  }
  if (/finish|complete/i.test(item.label) || item.status === 'complete') {
    return detail || `This CLI action finished in ${projectName}.`
  }
  return detail || `The CLI reported this live action while working in ${projectName}.`
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
  // Do not invent a plan from the user's sentence while the provider is still
  // connecting. The Steps tool shows a waiting state until a concrete
  // reasoning, file, command, or provider-plan event actually arrives.
  if (active && recorded.length === 0) return []
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
      description: activityDescription(item, projectName),
      state
    })
  })

  return steps
}
