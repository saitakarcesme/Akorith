import { memo, useState } from 'react'
import { formatModelLabel } from '../modelLabels'
import { CopyIcon, FileIcon } from './icons'
import ChatMarkdown from './ChatMarkdown'
import WorkspaceActivity from './WorkspaceActivity'
import type { ChatMessage } from './chat-types'

function usageLine(message: ChatMessage): string {
  const usage = message.meta?.usage
  if (!usage) return ''
  const parts: string[] = []
  if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) {
    parts.push(`${usage.promptTokens ?? '?'}→${usage.completionTokens ?? '?'} tok`)
  }
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`)
  return parts.join(' · ')
}

function formatElapsed(startedAt?: number, endedAt?: number): string {
  if (!startedAt || !endedAt || endedAt < startedAt) return ''
  const seconds = Math.max(1, Math.round((endedAt - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  if (minutes < 60) return `${minutes}m ${remaining}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function changeLabel(status: string): string {
  if (status.includes('?') || status.includes('A')) return 'New'
  if (status.includes('D')) return 'Deleted'
  if (status.includes('R')) return 'Renamed'
  return 'Modified'
}

function CompletionSummary({ message }: { message: ChatMessage }): JSX.Element | null {
  if (message.role !== 'assistant' || message.status !== 'done' || !message.meta) return null
  const elapsed = formatElapsed(message.startedAt, message.endedAt)
  const usage = message.meta.usage
  const totalTokens = usage && (usage.promptTokens !== undefined || usage.completionTokens !== undefined)
    ? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)
    : undefined
  const changes = message.meta.changes
  const visibleFiles = changes?.files.slice(0, 8) ?? []
  const moreFileCount = Math.max(0, (changes?.files.length ?? 0) - visibleFiles.length)

  return (
    <section className="chat-completion-summary" aria-label="Completed response summary">
      <header>
        <span className="chat-completion-title">
          <i aria-hidden="true">✓</i>
          Completed
        </span>
        {elapsed && <span>Worked for {elapsed}</span>}
      </header>
      <div className="chat-completion-metrics">
        <span><strong>{formatModelLabel(message.meta.model, message.meta.provider)}</strong><small>{message.meta.provider}</small></span>
        {totalTokens !== undefined && <span><strong>{totalTokens.toLocaleString()}</strong><small>{usage?.estimated ? 'estimated tokens' : 'tokens'}</small></span>}
        {changes && <span><strong>{changes.files.length}</strong><small>{changes.files.length === 1 ? 'file changed' : 'files changed'}</small></span>}
        {changes && <span className="is-addition"><strong>+{changes.additions}</strong><small>lines</small></span>}
        {changes && <span className="is-deletion"><strong>−{changes.deletions}</strong><small>lines</small></span>}
      </div>
      {visibleFiles.length > 0 && (
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
          {moreFileCount > 0 && <li className="is-more">+{moreFileCount} more files</li>}
        </ul>
      )}
    </section>
  )
}

function ChatMessageView({ message, isWorkspace }: { message: ChatMessage; isWorkspace: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const activityOwnsError = message.status === 'error' && (message.activities ?? []).some((activity) => activity.status === 'error')
  const showAssistantText = message.status === 'streaming' ? Boolean(message.text) : !activityOwnsError
  const images = message.attachments?.filter((item) => item.kind === 'image' && item.dataBase64) ?? []
  const files = message.attachments?.filter((item) => item.kind !== 'image') ?? []
  const copy = (): void => {
    void navigator.clipboard.writeText(message.text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <article className={`chat-msg ${message.role} ${message.status}`}>
      {images.length > 0 && <div className="chat-image-strip">{images.map((image) => <img key={image.id} src={`data:${image.mimeType};base64,${image.dataBase64}`} alt={image.name} />)}</div>}
      {files.length > 0 && <div className="chat-attachment-strip">{files.map((file) => <span className="chat-attachment" key={file.id}><FileIcon size={14} /><span>{file.name}</span><small>{Math.max(1, Math.round(file.size / 1024))} KB</small></span>)}</div>}
      {message.intent === 'plan' && <span className="chat-intent-badge">Plan</span>}
      {isWorkspace && message.role === 'assistant' && message.startedAt && (
        <WorkspaceActivity
          activities={message.activities ?? []}
          startedAt={message.startedAt}
          endedAt={message.endedAt}
          active={message.status === 'streaming'}
          failed={message.status === 'error'}
        />
      )}
      {message.role === 'assistant' && !showAssistantText ? null : message.role === 'assistant'
        ? <div className="chat-msg-text"><ChatMarkdown text={message.text} /></div>
        : <div className="chat-msg-text">{message.text}</div>}
      {isWorkspace && message.role === 'assistant' && showAssistantText && message.text && <CompletionSummary message={message} />}
      {message.role === 'assistant' && showAssistantText && message.text && (
        <div className="chat-msg-meta">
          {isWorkspace && <span>{message.status === 'done' && message.meta
            ? usageLine(message)
            : message.status === 'error' ? 'Task stopped' : ''}</span>}
          <button
            type="button"
            className={`chat-copy ${copied ? 'is-copied' : ''}`}
            aria-label={copied ? 'Copied' : 'Copy response'}
            title={copied ? 'Copied' : 'Copy response'}
            onClick={copy}
          >
            <CopyIcon size={15} />
          </button>
        </div>
      )}
    </article>
  )
}

export default memo(ChatMessageView)
