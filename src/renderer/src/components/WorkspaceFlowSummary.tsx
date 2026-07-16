import type { ChatActivity } from '../../../preload/index.d'

interface WorkspaceFlowSummaryProps {
  activities: ChatActivity[]
  active: boolean
  failed: boolean
}

type FlowStage = 'Prepare' | 'Plan' | 'Inspect' | 'Change' | 'Validate' | 'Finish'

function stageFor(item: ChatActivity): FlowStage {
  const label = item.label.toLowerCase()
  if (/finish|complete|done/.test(label)) return 'Finish'
  if (/test|check|verify|build|lint|validat/.test(label)) return 'Validate'
  if (item.kind === 'file' && /edit|write|patch|creat|updat|remov/.test(label)) return 'Change'
  if (item.kind === 'file' || item.kind === 'command') return 'Inspect'
  if (item.kind === 'plan' || item.kind === 'reasoning') return 'Plan'
  return 'Prepare'
}

export default function WorkspaceFlowSummary({ activities, active, failed }: WorkspaceFlowSummaryProps): JSX.Element | null {
  const stages = activities.reduce<FlowStage[]>((result, item) => {
    const stage = stageFor(item)
    if (!result.includes(stage)) result.push(stage)
    return result
  }, [])

  // A one or two-event response is clearer as prose. The visual appears only
  // when a real multi-stage workflow has emerged from actual CLI activity.
  if (stages.length < 3) return null

  return (
    <div className={`workspace-flow-summary ${active ? 'is-active' : failed ? 'is-failed' : 'is-complete'}`} aria-label="Workspace execution flow">
      <ol>
        {stages.map((stage, index) => (
          <li className={index === stages.length - 1 && active ? 'is-current' : 'is-complete'} key={stage}>
            <span>{index + 1}</span>
            <strong>{stage}</strong>
          </li>
        ))}
      </ol>
    </div>
  )
}
