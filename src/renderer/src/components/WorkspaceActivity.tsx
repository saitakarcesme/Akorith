import { memo, useEffect, useMemo, useState } from 'react'
import type { ChatActivity } from '../../../preload/index.d'

interface WorkspaceActivityProps {
  activities: ChatActivity[]
  startedAt: number
  endedAt?: number
  active: boolean
  failed?: boolean
  projectName?: string
}

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`
}

function activityLabel(item: ChatActivity): string {
  if (item.label === 'Starting the selected model') return 'Preparing the workspace'
  if (item.label === 'Workspace task complete') return 'Finished the requested changes'
  return item.label
}

function detailSentence(item: ChatActivity): string {
  const detail = item.detail?.replace(/\s+/g, ' ').trim()
  if (!detail || detail === item.label.trim()) return ''
  const bounded = detail.length > 180 ? `${detail.slice(0, 179).trimEnd()}…` : detail
  return /[.!?…]$/.test(bounded) ? bounded : `${bounded}.`
}

function activityExplanation(item: ChatActivity, projectName: string): string {
  const detail = detailSentence(item)
  if (item.status === 'error' || item.kind === 'warning') {
    return `This step could not finish inside ${projectName}, so Akorith preserved the current files and conversation context for review. Adjust the request or selected model if needed, then retry without losing the project state.${detail ? ` The provider reported: ${detail}` : ''}`
  }
  if (item.kind === 'command') {
    return item.status === 'complete'
      ? `The command finished inside ${projectName}, and its output is now recorded as project evidence. Akorith uses that result to decide whether another inspection, edit, or validation action is necessary.${detail ? ` It ran through ${detail}` : ''}`
      : `This command is running only inside ${projectName} to inspect the current state or validate the requested result. Its output will be checked before Akorith reports a conclusion or moves to another project action.${detail ? ` It is running through ${detail}` : ''}`
  }
  if (item.kind === 'file') {
    return item.status === 'complete'
      ? `The relevant file in ${projectName} was inspected or updated, and that result is now part of the task record. Its surrounding structure stays in context for the next project-specific decision.${detail ? ` The provider recorded: ${detail}` : ''}`
      : `Akorith is reading or updating this file inside the ${projectName} boundary while preserving the surrounding code. The change remains tied to the user's requested outcome and will be checked before completion.${detail ? ` The active tool is ${detail}` : ''}`
  }
  if (item.kind === 'reasoning' || item.kind === 'plan') {
    return `The selected model is connecting the request to the current state of ${projectName} and resolving dependencies between the required changes. It is choosing a concrete, bounded action that can be verified afterward instead of following a preset workflow.${detail ? ` Additional context: ${detail}` : ''}`
  }
  if (/session started/i.test(item.label)) {
    return `Akorith connected the selected local CLI to ${projectName} and established a project-scoped session. The request, bounded workspace context, and continuing conversation memory are now available to that provider.`
  }
  if (/preparing|starting/i.test(item.label)) {
    return `Akorith is loading ${projectName}, its bounded project context, conversation memory, and the selected local CLI. This prepares the provider to inspect or change only the intended project before any action is attempted.`
  }
  if (/finished|complete/i.test(item.label) || item.status === 'complete') {
    return `This recorded unit of work has finished inside ${projectName}. Its files, command results, and model explanation are now carried into the final response and continuing project memory.${detail ? ` Recorded detail: ${detail}` : ''}`
  }
  return `Akorith is keeping the task moving inside ${projectName} while translating the selected model's raw CLI activity into a durable explanation. This update records what is happening, why it matters, and how it relates to the requested result.${detail ? ` Provider detail: ${detail}` : ''}`
}

function WorkspaceActivity({
  activities,
  startedAt,
  endedAt,
  active,
  failed = false,
  projectName = 'the selected project'
}: WorkspaceActivityProps): JSX.Element {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])

  const visible = useMemo(() => {
    const compact: ChatActivity[] = []
    for (const item of activities) {
      const previous = compact.at(-1)
      if (previous && previous.kind === item.kind && previous.label === item.label && previous.status === item.status) continue
      compact.push(item)
    }
    return compact.slice(-9)
  }, [activities])
  const recordedEnd = useMemo(
    () => activities.reduce((latest, item) => Math.max(latest, item.timestamp), startedAt),
    [activities, startedAt]
  )
  const elapsedUntil = active ? now : endedAt ?? recordedEnd
  const statusText = active
    ? `Working for ${elapsedLabel(elapsedUntil - startedAt)}`
    : failed
      ? `Stopped after ${elapsedLabel(elapsedUntil - startedAt)}`
      : `Worked for ${elapsedLabel(elapsedUntil - startedAt)}`

  return (
    <section className={`workspace-activity ${active ? 'is-active' : failed ? 'is-failed' : 'is-complete'}`} aria-live="polite">
      <div className="workspace-duration">{statusText}</div>
      <div className="workspace-activity-rule" />
      <div className="workspace-activity-list">
        {visible.map((item) => (
          <div className={`workspace-activity-row is-${item.kind} is-${item.status ?? 'running'}`} key={`${item.timestamp}-${item.kind}-${item.label}`}>
            <div className="workspace-activity-copy">
              <strong>{activityLabel(item)}</strong>
              <p>{activityExplanation(item, projectName)}</p>
            </div>
          </div>
        ))}
        {visible.length === 0 && active && (
          <div className="workspace-activity-row is-status is-running">
            <div className="workspace-activity-copy">
              <strong>Akorithing…</strong>
              <p>Akorith is preparing the first project-scoped action in {projectName} and waiting for a meaningful event from the selected model. The request and bounded workspace context are already attached to this run.</p>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default memo(WorkspaceActivity)
