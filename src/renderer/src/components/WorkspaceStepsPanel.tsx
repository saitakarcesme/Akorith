import { memo } from 'react'
import type { WorkspaceWorkflowSnapshot } from '../workspaceWorkflow'
import { PlanIcon } from './icons'

function requestSummary(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 220 ? `${text.slice(0, 219).trimEnd()}…` : text
}

function WorkspaceStepsPanel({
  snapshot,
  projectName
}: {
  snapshot: WorkspaceWorkflowSnapshot | null
  projectName: string
}): JSX.Element {
  if (!snapshot) {
    return (
      <div className="workspace-steps-empty">
        <PlanIcon size={18} />
        <strong>No workspace run yet</strong>
        <p>Send a project request, then open Steps to inspect the provider’s real plan and actions.</p>
      </div>
    )
  }

  return (
    <section className={`workspace-steps-panel ${snapshot.active ? 'is-active' : snapshot.failed ? 'is-failed' : 'is-complete'}`}>
      <header>
        <div>
          <span>{snapshot.active ? 'Working' : snapshot.failed ? 'Stopped' : 'Completed'} · {projectName}</span>
          <h3>{requestSummary(snapshot.prompt) || 'Workspace request'}</h3>
        </div>
        <small>{snapshot.steps.length} {snapshot.steps.length === 1 ? 'recorded step' : 'recorded steps'}</small>
      </header>

      {snapshot.steps.length === 0 ? (
        <div className="workspace-steps-waiting" role="status" aria-live="polite">
          <i />
          <div>
            <strong>Thinking before opening steps</strong>
            <p>Akorith is waiting for the selected provider’s first concrete reasoning or tool event. It will not manufacture a plan from the prompt.</p>
          </div>
        </div>
      ) : (
        <ol className="workspace-steps-list">
          {snapshot.steps.map((step, index) => (
            <li className={`is-${step.state}`} key={step.id}>
              <span className="workspace-steps-index">
                {step.state === 'complete' ? '✓' : step.state === 'error' ? '!' : index + 1}
              </span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.description}</p>
              </div>
              <small>{step.state}</small>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export default memo(WorkspaceStepsPanel)
