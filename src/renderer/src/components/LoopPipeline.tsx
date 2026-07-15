import type { ProjectLoopStatus } from '../../../preload/index.d'

export type LoopCyclePhase = 'understand' | 'plan' | 'execute' | 'analyze' | 'replan'

interface LoopPipelineProps {
  phase: LoopCyclePhase
  status: ProjectLoopStatus
  iteration?: number
}

const STAGES: { id: LoopCyclePhase; label: string; hint: string }[] = [
  { id: 'understand', label: 'Understand', hint: 'Define the whole Goal' },
  { id: 'plan', label: 'Plan', hint: 'Choose one verifiable action' },
  { id: 'execute', label: 'Execute', hint: 'Create or change the artifact' },
  { id: 'analyze', label: 'Analyze', hint: 'Compare evidence with the Goal' },
  { id: 'replan', label: 'Replan', hint: 'Close the largest remaining gap' }
]

export default function LoopPipeline({ phase, status, iteration = 1 }: LoopPipelineProps): JSX.Element {
  const currentIndex = Math.max(0, STAGES.findIndex((stage) => stage.id === phase))
  const completed = status === 'completed'
  const blocked = status === 'error' || status === 'needs_review'
  return (
    <div className={`loop-cycle ${completed ? 'is-complete' : blocked ? 'is-blocked' : 'is-active'}`} aria-label={`Goal cycle ${iteration}, ${completed ? 'complete' : STAGES[currentIndex].label}`}>
      <div className="loop-cycle-track" role="list">
        {STAGES.map((stage, index) => {
          const state = completed
            ? index <= 3 ? 'complete' : 'waiting'
            : index < currentIndex ? 'complete' : index === currentIndex ? blocked ? 'blocked' : 'current' : 'waiting'
          return (
            <div className={`loop-cycle-stage is-${state}`} role="listitem" key={stage.id}>
              <span className="loop-cycle-node"><i />{index + 1}</span>
              <strong>{stage.label}</strong>
              <small>{stage.hint}</small>
            </div>
          )
        })}
      </div>
      <div className="loop-cycle-branches" aria-hidden="true">
        <span className="loop-cycle-return"><i />Goal not reached · return to Plan</span>
        <span className={`loop-cycle-finish ${completed ? 'is-reached' : ''}`}><i />Goal reached</span>
      </div>
    </div>
  )
}
