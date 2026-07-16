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
    <div className={`loop-cycle-simple ${completed ? 'is-complete' : blocked ? 'is-blocked' : 'is-active'}`} aria-label={`Goal cycle ${iteration}, ${completed ? 'complete' : STAGES[currentIndex].label}`}>
      <ol className="loop-step-dots" aria-label={`Cycle ${iteration} steps`}>
        {STAGES.map((stage, index) => {
          const state = completed
            ? index <= 3 || (stage.id === 'replan' && iteration > 1) ? 'complete' : 'waiting'
            : index < currentIndex ? 'complete' : index === currentIndex ? blocked ? 'blocked' : 'current' : 'waiting'
          return (
            <li className={`is-${state}`} key={stage.id} title={stage.label} aria-label={`${stage.label}: ${state}`}>
              <span>{state === 'complete' ? '✓' : index + 1}</span>
              <small>{stage.label}</small>
            </li>
          )
        })}
        <li className={completed ? 'is-complete' : 'is-waiting'} title="Complete" aria-label={`Complete: ${completed ? 'complete' : 'waiting'}`}><span>✓</span><small>Complete</small></li>
      </ol>
      <span className="loop-cycle-count">Cycle {iteration}</span>
    </div>
  )
}
