import type { ProjectLoopStatus } from '../../../preload/index.d'

export type LoopCyclePhase = 'understand' | 'plan' | 'execute' | 'analyze' | 'replan'

interface LoopPipelineProps {
  phase: LoopCyclePhase
  status: ProjectLoopStatus
  iteration?: number
}

const STAGES: { id: LoopCyclePhase; label: string }[] = [
  { id: 'understand', label: 'Understand' },
  { id: 'plan', label: 'Plan' },
  { id: 'execute', label: 'Execute' },
  { id: 'analyze', label: 'Analyze' },
  { id: 'replan', label: 'Replan' }
]

export default function LoopPipeline({ phase, status, iteration = 1 }: LoopPipelineProps): JSX.Element {
  const currentIndex = Math.max(0, STAGES.findIndex((stage) => stage.id === phase))
  const completed = status === 'completed'
  const blocked = status === 'error' || status === 'needs_review'
  return (
    <div className={`loop-cycle ${completed ? 'is-complete' : blocked ? 'is-blocked' : 'is-active'}`} aria-label={`Goal cycle ${iteration}, ${completed ? 'complete' : STAGES[currentIndex].label}`}>
      <div className="loop-cycle-scroll">
        <div className="loop-cycle-canvas">
          <svg className="loop-cycle-connectors" viewBox="0 0 700 205" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <marker id="loop-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                <path d="M0 0 8 4 0 8Z" />
              </marker>
            </defs>
            <path d="M132 45H207" />
            <path d="M312 45H387" />
            <path d="M440 70V127" />
            <path className="is-review" d="M388 157H313" />
            <path className="is-return" d="M260 127V70" />
            <path className="is-finish" d="M493 157H564" />
          </svg>
          <span className="loop-cycle-branch-label is-review">Goal not reached</span>
          <span className="loop-cycle-branch-label is-return">Replan</span>
          <span className="loop-cycle-branch-label is-finish">Goal reached</span>
          <div className="loop-cycle-track" role="list">
        {STAGES.map((stage, index) => {
          const state = completed
            ? index <= 3 ? 'complete' : 'waiting'
            : index < currentIndex ? 'complete' : index === currentIndex ? blocked ? 'blocked' : 'current' : 'waiting'
          return (
            <div className={`loop-cycle-stage is-${state}`} role="listitem" key={stage.id}>
              <span className="loop-cycle-node">{state === 'complete' ? '✓' : index + 1}</span>
              <strong>{stage.label}</strong>
            </div>
          )
        })}
          </div>
          <div className={`loop-cycle-outcome ${completed ? 'is-reached' : ''}`}>
            <span>✓</span><strong>Complete</strong>
          </div>
        </div>
      </div>
      <p className={`loop-cycle-caption ${completed ? 'is-reached' : ''}`}>
        {completed ? 'Goal reached' : blocked ? 'Waiting for review' : `Cycle ${iteration} · analyze evidence, then finish or return to Plan`}
      </p>
    </div>
  )
}
