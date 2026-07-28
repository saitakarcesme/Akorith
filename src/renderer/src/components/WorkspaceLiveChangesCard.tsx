import { memo } from 'react'
import type { WorkspaceChanges } from '../workspaceLiveChanges'
import { FileIcon } from './icons'

interface WorkspaceLiveChangesCardProps {
  changes: WorkspaceChanges
  onReview: () => void
}

const CARD_STYLE = { maxWidth: 760, margin: '0 0 8px' } as const

function changeLabel(status: string): string {
  if (status.includes('?') || status.includes('A')) return 'New'
  if (status.includes('D')) return 'Deleted'
  if (status.includes('R')) return 'Renamed'
  return 'Modified'
}

function WorkspaceLiveChangesCard({ changes, onReview }: WorkspaceLiveChangesCardProps): JSX.Element {
  const visibleFiles = changes.files.slice(0, 5)
  const remaining = Math.max(0, changes.files.length - visibleFiles.length)
  const countLabel = changes.files.length === 1 ? 'file' : 'files'

  return (
    <section className="chat-completion-summary" style={CARD_STYLE} aria-label="Live project changes">
      <header>
        <span className="chat-completion-title"><i aria-hidden="true">↗</i>Edited {changes.files.length} {countLabel}</span>
        <button type="button" className="composer-chip" onClick={onReview}>Review</button>
      </header>
      <div className="chat-completion-metrics">
        <span><strong>Working changes</strong><small>Updates from this task</small></span>
        <span className="is-addition"><strong>+{changes.additions}</strong><small>lines</small></span>
        <span className="is-deletion"><strong>−{changes.deletions}</strong><small>lines</small></span>
      </div>
      <ul className="chat-completion-files">
        {visibleFiles.map((file) => (
          <li key={file.path}>
            <FileIcon size={14} />
            <span title={file.path}>{file.path}</span>
            <small>{changeLabel(file.status)}</small>
            <code className="is-addition">+{file.additions}</code>
            <code className="is-deletion">−{file.deletions}</code>
          </li>
        ))}
        {remaining > 0 && <li className="is-more">+{remaining} more files</li>}
      </ul>
    </section>
  )
}

export default memo(WorkspaceLiveChangesCard)
