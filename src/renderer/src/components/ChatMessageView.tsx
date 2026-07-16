import { memo, useState } from 'react'
import { formatModelLabel } from '../modelLabels'
import { FileIcon } from './icons'
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
      {message.role === 'assistant' && showAssistantText && message.text && (
        <div className="chat-msg-meta">
          <span>{message.meta
            ? `${message.meta.provider} · ${formatModelLabel(message.meta.model, message.meta.provider)}${usageLine(message) ? ` · ${usageLine(message)}` : ''}`
            : message.status === 'error' ? 'Task stopped' : ''}</span>
          <button type="button" className="chat-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}
    </article>
  )
}

export default memo(ChatMessageView)
