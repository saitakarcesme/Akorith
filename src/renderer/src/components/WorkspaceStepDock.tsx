import { memo } from 'react'
import type { WorkspaceWorkflowStep } from '../workspaceWorkflow'

interface WorkspaceStepDockProps {
  steps: WorkspaceWorkflowStep[]
  active: boolean
}

function currentStepIndex(steps: WorkspaceWorkflowStep[], active: boolean): number {
  const running = steps.findIndex((step) => step.state === 'running' || step.state === 'error')
  if (running >= 0) return running
  const firstWaiting = steps.findIndex((step) => step.state === 'waiting')
  if (firstWaiting >= 0) return firstWaiting
  return active ? Math.max(0, steps.length - 1) : steps.length - 1
}

function WorkspaceStepDock({ steps, active }: WorkspaceStepDockProps): JSX.Element | null {
  if (steps.length === 0) return null
  const currentIndex = currentStepIndex(steps, active)
  const current = currentIndex + 1

  return (
    <div className={`workspace-step-dock ${active ? 'is-active' : ''}`}>
      <button
        type="button"
        className="workspace-step"
        aria-label={`Project workflow step ${current} of ${steps.length}`}
        aria-haspopup="true"
      >
        Step {current} / {steps.length}
      </button>
      <div className="workspace-step-popover" role="tooltip">
        <span>Project workflow</span>
        {steps.map((step, index) => (
          <div className={`is-${step.state} ${index === currentIndex ? 'is-current' : ''}`} key={step.id}>
            <strong>{step.title}</strong>
            <small>{step.description}</small>
          </div>
        ))}
      </div>
    </div>
  )
}

export default memo(WorkspaceStepDock)
