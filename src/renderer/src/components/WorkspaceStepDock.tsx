interface WorkspaceStepDockProps {
  step: number
  active: boolean
}

const STEPS = [
  ['Prepare', 'Load the project and selected local CLI.'],
  ['Understand', 'Connect the request to the current project state.'],
  ['Plan', 'Choose the next safe, bounded project action.'],
  ['Work', 'Inspect files, run tools, and make the requested changes.'],
  ['Validate', 'Check the result against the request and project constraints.'],
  ['Finish', 'Explain the outcome and preserve the conversation context.']
] as const

export default function WorkspaceStepDock({ step, active }: WorkspaceStepDockProps): JSX.Element {
  const current = Math.min(STEPS.length, Math.max(1, step))
  return (
    <div className={`workspace-step-dock ${active ? 'is-active' : ''}`}>
      <button type="button" className="workspace-step" aria-label={`Workspace step ${current} of ${STEPS.length}`} aria-haspopup="true">
        <i />Step {current} / {STEPS.length}
      </button>
      <div className="workspace-step-popover" role="tooltip">
        <span>PROJECT WORKFLOW</span>
        {STEPS.map(([label, description], index) => {
          const number = index + 1
          const state = number < current ? 'complete' : number === current ? active ? 'current' : 'complete' : 'waiting'
          return <div className={`is-${state}`} key={label}><i>{number}</i><p><strong>{label}</strong><small>{description}</small></p></div>
        })}
      </div>
    </div>
  )
}
