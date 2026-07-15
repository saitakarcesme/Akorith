import type { ProjectLoopStatus } from '../../../preload/index.d'

interface LoopPipelineProps {
  step: number
  status: ProjectLoopStatus
  compact?: boolean
}

const STAGES = [
  { label: 'Scope', hint: 'Understand the outcome' },
  { label: 'Plan', hint: 'Choose the next change' },
  { label: 'Build', hint: 'Edit the project' },
  { label: 'Check', hint: 'Review the patch' },
  { label: 'Verify', hint: 'Run validation' },
  { label: 'Commit', hint: 'Keep a local checkpoint' }
] as const

export default function LoopPipeline({ step, status, compact = false }: LoopPipelineProps): JSX.Element {
  const currentStep = Math.min(STAGES.length, Math.max(1, step))
  return (
    <div
      className={`loop-pipeline ${compact ? 'is-compact' : ''}`}
      role="progressbar"
      aria-label={`Loop progress: step ${currentStep} of ${STAGES.length}`}
      aria-valuemin={1}
      aria-valuemax={STAGES.length}
      aria-valuenow={currentStep}
    >
      {STAGES.map((stage, index) => {
        const stageNumber = index + 1
        const state = stageNumber < currentStep || status === 'completed'
          ? 'complete'
          : stageNumber === currentStep
            ? status === 'error' || status === 'needs_review' ? 'blocked' : 'current'
            : 'waiting'
        return (
          <div className={`loop-stage is-${state}`} key={stage.label}>
            <span className="loop-stage-node">{stageNumber}</span>
            {!compact && <span className="loop-stage-copy"><strong>{stage.label}</strong><small>{stage.hint}</small></span>}
          </div>
        )
      })}
    </div>
  )
}
