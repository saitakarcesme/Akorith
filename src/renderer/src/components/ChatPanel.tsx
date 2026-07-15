import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatActivity,
  ChatImageAttachment,
  ChatUsage,
  ContextInfo,
  ProjectRow,
  ProviderInfo,
  RouterSuggestion
} from '../../../preload/index.d'
import { normalizeStoredOpenCodeMessage } from '../../../shared/opencode-output'
import type { ChatMode, HistorySelection } from '../App'
import { formatModelLabel } from '../modelLabels'
import { FolderIcon, PlusIcon, SendIcon, SparkIcon, StopIcon } from './icons'
import { ComposerSendButton } from './CreationPrimitives'
import ModelPicker from './ModelPicker'
import WorkspaceActivity, { workspaceActivityStep } from './WorkspaceActivity'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: 'streaming' | 'done' | 'error'
  images?: ChatImageAttachment[]
  meta?: { provider: string; model: string; usage?: ChatUsage }
  activities?: ChatActivity[]
  startedAt?: number
  endedAt?: number
}

interface ComposerImage extends ChatImageAttachment {
  previewUrl: string
}

interface ChatPanelProps {
  mode: ChatMode
  historySel: HistorySelection | null
  activeProject: ProjectRow | null
  onOpenProject: () => void
  onCreateProject: () => void
  onHistoryChange: () => void
  onActiveSession: (sessionId: string | null) => void
  pendingSessions?: Set<string>
  onPendingChange?: (sessionId: string, pending: boolean) => void
}

interface Segment {
  type: 'text' | 'code'
  content: string
  lang?: string
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function storageString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function splitFences(text: string): Segment[] {
  const segments: Segment[] = []
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = fence.exec(text))) {
    if (match.index > last) segments.push({ type: 'text', content: text.slice(last, match.index) })
    segments.push({ type: 'code', lang: match[1].trim() || undefined, content: match[2].replace(/\n$/, '') })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ type: 'text', content: text.slice(last) })
  return segments
}

function renderInlineMarkdown(text: string, keyPrefix: string): JSX.Element[] {
  const nodes: JSX.Element[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let index = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(<span key={`${keyPrefix}-t-${index++}`}>{text.slice(last, match.index)}</span>)
    const token = match[0]
    nodes.push(token.startsWith('**')
      ? <strong key={`${keyPrefix}-b-${index++}`}>{token.slice(2, -2)}</strong>
      : <code key={`${keyPrefix}-c-${index++}`}>{token.slice(1, -1)}</code>)
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(<span key={`${keyPrefix}-t-${index}`}>{text.slice(last)}</span>)
  return nodes
}

function renderProse(text: string, keyPrefix: string): JSX.Element {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/).filter((block) => block.trim())
  return (
    <div className="chat-prose" key={keyPrefix}>
      {blocks.map((block, index) => {
        const lines = block.split('\n')
        if (lines.every((line) => /^[-*]\s+/.test(line.trim()))) {
          return <ul key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}>{renderInlineMarkdown(line.trim().replace(/^[-*]\s+/, ''), `${keyPrefix}-${index}-${lineIndex}`)}</li>)}</ul>
        }
        return <p key={index}>{renderInlineMarkdown(lines.join(' '), `${keyPrefix}-${index}`)}</p>
      })}
    </div>
  )
}

function usageLine(usage: ChatUsage): string {
  const parts: string[] = []
  if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) {
    parts.push(`${usage.promptTokens ?? '?'}→${usage.completionTokens ?? '?'} tok`)
  }
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`)
  return parts.join(' · ')
}

function isLocalAutoStarting(provider?: ProviderInfo): boolean {
  return Boolean(provider?.id === 'local' && !provider.available.ok && /Akorith (is starting Ollama|tried to auto-start it)/i.test(provider.available.reason ?? ''))
}

export default function ChatPanel({
  mode,
  historySel,
  activeProject,
  onOpenProject,
  onCreateProject,
  onHistoryChange,
  onActiveSession,
  pendingSessions,
  onPendingChange
}: ChatPanelProps): JSX.Element {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [attachedImages, setAttachedImages] = useState<ComposerImage[]>([])
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null)
  const [digestEnabled, setDigestEnabled] = useState(false)
  const [suggestion, setSuggestion] = useState<RouterSuggestion | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [displayName] = useState(() => storageString('akorith.displayName', 'Ibrahim').trim() || 'Ibrahim')
  const [ollamaActive, setOllamaActive] = useState<{ label: string; baseUrl: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const isWorkspace = mode === 'workspace'
  const hasProject = isWorkspace && Boolean(activeProject?.path)

  const loadProviders = useCallback(async (): Promise<void> => {
    try {
      const list = await window.api.chat.listProviders()
      setProviders(list)
      setProviderId((current) => {
        const existing = list.find((provider) => provider.id === current)
        if (existing?.available.ok || isLocalAutoStarting(existing)) return current
        return list.find((provider) => provider.available.ok)?.id ?? ''
      })
      setLoadError(null)
    } catch (err) {
      setProviders([])
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const refreshContext = useCallback(async (sessionId: string | null): Promise<void> => {
    if (!sessionId) {
      setContextInfo(null)
      return
    }
    try {
      setContextInfo(await window.api.chat.contextInfo(sessionId))
    } catch {
      setContextInfo(null)
    }
  }, [])

  useEffect(() => {
    void loadProviders()
    void window.api.digest.getSettings().then((settings) => setDigestEnabled(settings.enabled))
    void window.api.ollama.autoConnect().then((result) => {
      if (result.ok) {
        setOllamaActive({ label: result.active.label, baseUrl: result.active.baseUrl })
        if (result.switched) void loadProviders()
      }
    }).catch(() => {})
  }, [loadProviders])

  useEffect(() => {
    if (!moreOpen) return
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMoreOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [moreOpen])

  useEffect(() => {
    if (!historySel || historySel.mode !== mode) return
    if (historySel.sessionId && (pendingSessions?.has(historySel.sessionId) || (busyRequestId && historySel.sessionId === activeSessionId))) return
    nearBottomRef.current = true
    setConfirmingClear(false)
    if (!historySel.sessionId) {
      setMessages([])
      setActiveSessionId(null)
      onActiveSession(null)
      setContextInfo(null)
      if (historySel.providerId) setProviderId(historySel.providerId)
      return
    }
    void window.api.history.messages(historySel.sessionId).then((data) => {
      if (!data) return
      setMessages(data.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.role === 'assistant' && message.providerId === 'opencode'
          ? normalizeStoredOpenCodeMessage(message.content)
          : message.content,
        status: 'done',
        meta: message.role === 'assistant' ? { provider: message.providerId, model: message.model ?? 'default' } : undefined
      })))
      setActiveSessionId(data.session.id)
      onActiveSession(data.session.id)
      setProviderId(data.session.providerId)
      void refreshContext(data.session.id)
    })
  }, [historySel?.nonce, mode])

  const selected = providers?.find((provider) => provider.id === providerId)

  useEffect(() => {
    setModel((current) => selected?.models.includes(current) ? current : selected?.models[0] ?? '')
  }, [selected])

  useEffect(() => {
    const element = scrollRef.current
    if (element && nearBottomRef.current) element.scrollTop = element.scrollHeight
  }, [messages])

  const showToast = (message: string): void => {
    setToast(message)
    window.setTimeout(() => setToast((current) => current === message ? null : current), 1800)
  }

  const addImageFiles = async (files: FileList | null): Promise<void> => {
    if (!files) return
    const accepted = [...files].filter((file) => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)).slice(0, 4 - attachedImages.length)
    const next = await Promise.all(accepted.map(async (file): Promise<ComposerImage> => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return { name: file.name, mimeType: file.type, dataBase64: btoa(binary), previewUrl: URL.createObjectURL(file) }
    }))
    setAttachedImages((current) => [...current, ...next])
    if (imageInputRef.current) imageInputRef.current.value = ''
  }

  const ensureSession = async (prompt: string): Promise<string> => {
    if (activeSessionId) return activeSessionId
    const session = await window.api.history.create(providerId, prompt.replace(/\s+/g, ' ').slice(0, 64), hasProject ? activeProject!.id : null)
    setActiveSessionId(session.id)
    onActiveSession(session.id)
    onHistoryChange()
    return session.id
  }

  const sendPrompt = async (): Promise<void> => {
    const prompt = draft.trim()
    if (!prompt || !selected?.available.ok || busyRequestId || (isWorkspace && !hasProject)) return
    const requestId = newId()
    const assistantId = newId()
    const images = attachedImages.map(({ previewUrl: _previewUrl, ...image }) => image)
    const sessionId = await ensureSession(prompt)
    setDraft('')
    setAttachedImages([])
    setSuggestion(null)
    setBusyRequestId(requestId)
    onPendingChange?.(sessionId, true)
    setMessages((current) => [
      ...current,
      { id: newId(), role: 'user', text: prompt, status: 'done', images },
      { id: assistantId, role: 'assistant', text: '', status: 'streaming', activities: [], startedAt: Date.now() }
    ])

    const offToken = window.api.chat.onToken(requestId, (token) => {
      setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, text: message.text + token } : message))
    })
    const offActivity = window.api.chat.onActivity(requestId, (activity) => {
      setMessages((current) => current.map((message) => message.id === assistantId
        ? { ...message, activities: [...(message.activities ?? []), activity].slice(-30) }
        : message))
    })

    try {
      const response = await window.api.chat.send({
        requestId,
        providerId,
        model: model || undefined,
        prompt,
        sessionId,
        includeDigest: hasProject && digestEnabled,
        workspaceContext: hasProject ? { projectName: activeProject!.name, projectPath: activeProject!.path! } : undefined,
        images
      })
      setMessages((current) => current.map((message) => message.id === assistantId
        ? response.ok
          ? { ...message, text: response.result.text, status: 'done', endedAt: Date.now(), meta: { provider: providerId, model: response.result.model, usage: response.result.usage } }
          : { ...message, text: response.error, status: 'error', endedAt: Date.now() }
        : message))
      if (response.ok) {
        onHistoryChange()
        void refreshContext(sessionId)
      }
    } catch (err) {
      setMessages((current) => current.map((message) => message.id === assistantId
        ? { ...message, text: err instanceof Error ? err.message : String(err), status: 'error', endedAt: Date.now() }
        : message))
    } finally {
      offToken()
      offActivity()
      setBusyRequestId(null)
      onPendingChange?.(sessionId, false)
    }
  }

  const cancel = (): void => {
    if (busyRequestId) window.api.chat.cancel(busyRequestId)
  }

  const clearContext = async (): Promise<void> => {
    if (!activeSessionId) return
    if (!confirmingClear) {
      setConfirmingClear(true)
      return
    }
    await window.api.history.clearMessages(activeSessionId)
    setMessages([])
    setConfirmingClear(false)
    void refreshContext(activeSessionId)
    onHistoryChange()
  }

  const suggestTask = async (): Promise<void> => {
    if (!draft.trim()) return
    setSuggesting(true)
    try {
      const response = await window.api.router.suggest(draft.trim())
      if (response.ok) setSuggestion(response.suggestion)
      else showToast(response.error)
    } finally {
      setSuggesting(false)
    }
  }

  const acceptSuggestion = (): void => {
    if (!suggestion?.available) return
    setProviderId(suggestion.providerId)
    if (suggestion.model) setModel(suggestion.model)
    setSuggestion(null)
  }

  const copyButton = (text: string, key: string): JSX.Element => (
    <button type="button" className="chat-copy" onClick={() => void navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key)
      showToast('Copied')
    })}>{copiedKey === key ? 'Copied' : 'Copy'}</button>
  )

  const hasConversation = messages.length > 0
  const latestWorkspaceRun = isWorkspace
    ? [...messages].reverse().find((message) => message.role === 'assistant' && message.startedAt)
    : undefined
  const latestWorkspaceStep = latestWorkspaceRun
    ? workspaceActivityStep(latestWorkspaceRun.activities ?? [], latestWorkspaceRun.status === 'streaming', latestWorkspaceRun.status === 'error')
    : null
  const canSend = Boolean(draft.trim() && selected?.available.ok && !busyRequestId && (!isWorkspace || hasProject))
  const contextCount = contextInfo?.totalMessages ?? 0
  const memoryLabel = contextCount > 0 ? `Memory: ${contextCount} messages` : hasProject ? 'Project memory on' : 'Session memory on'

  const composer = (
    <div className="composer">
      {suggestion && (
        <div className="router-suggestion">
          <div className="router-suggestion-head"><span className={`tier-badge tier-${suggestion.tier}`}>{suggestion.rank} · {suggestion.tier}</span><span className="router-target">→ {suggestion.providerLabel}{suggestion.model ? ` · ${suggestion.model}` : ''}</span></div>
          <div className="router-reason">{suggestion.reason}</div>
          <div className="router-actions"><button type="button" className="router-accept" disabled={!suggestion.available} onClick={acceptSuggestion}>Use model</button><button type="button" className="router-ignore" onClick={() => setSuggestion(null)}>Dismiss</button></div>
        </div>
      )}
      <div className="composer-box">
        {attachedImages.length > 0 && <div className="composer-images">{attachedImages.map((image, index) => <div className="composer-image" key={`${image.name}-${index}`}><img src={image.previewUrl} alt={image.name} /><button type="button" onClick={() => setAttachedImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}</div>}
        <textarea
          className="composer-input"
          placeholder={!selected?.available.ok ? 'Select an available model…' : hasProject ? `Describe a task for ${activeProject!.name}…` : isWorkspace ? 'Open a project to start…' : 'Ask a model directly…'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendPrompt() } }}
          rows={2}
          spellCheck={false}
        />
        <div className="composer-controls">
          <div className="composer-controls-left">
            <ModelPicker providers={providers} providerId={providerId} model={model} onSelect={(nextProvider, nextModel) => { setProviderId(nextProvider); setModel(nextModel) }} onRefresh={() => void loadProviders()} modelSource={(id) => id === 'local' ? ollamaActive?.label ?? 'Local' : undefined} />
            <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="composer-file-input" onChange={(event) => void addImageFiles(event.target.files)} />
            <div className="composer-more">
              <button type="button" className={`composer-chip ${moreOpen ? 'is-active' : ''}`} onClick={() => setMoreOpen((open) => !open)}><SparkIcon size={13} />More</button>
              {moreOpen && <><div className="composer-more-backdrop" onClick={() => setMoreOpen(false)} /><div className="composer-more-pop" role="menu">
                <button type="button" className="composer-more-item" onClick={() => { setMoreOpen(false); imageInputRef.current?.click() }}><PlusIcon size={13} /><span>Attach image</span></button>
                <button type="button" className="composer-more-item" disabled={!draft.trim() || suggesting} onClick={() => { setMoreOpen(false); void suggestTask() }}><SparkIcon size={13} /><span>{suggesting ? 'Classifying…' : 'Suggest model'}</span></button>
                {hasProject && <><div className="composer-more-sep" /><label className="composer-more-toggle"><span>Repository context</span><input type="checkbox" checked={digestEnabled} onChange={() => { const next = !digestEnabled; setDigestEnabled(next); void window.api.digest.setEnabled(next) }} /></label></>}
              </div></>}
            </div>
          </div>
          {busyRequestId ? <ComposerSendButton stop onClick={cancel}><StopIcon size={16} /></ComposerSendButton> : <ComposerSendButton disabled={!canSend} onClick={() => void sendPrompt()}><SendIcon size={16} /></ComposerSendButton>}
        </div>
      </div>
      <div className="context-bar"><span className="context-chip"><span className="context-dot" />{memoryLabel}</span>{activeSessionId && hasConversation && <button type="button" className={`context-clear ${confirmingClear ? 'is-confirm' : ''}`} onClick={() => void clearContext()}>{confirmingClear ? 'Reset context?' : 'Reset context'}</button>}</div>
      <div className="composer-info">{hasProject ? `workspace ${activeProject!.name} · ${selected?.label ?? 'model'} · direct project editing` : `${selected?.label ?? 'model'} · ${model || 'default'}`}</div>
    </div>
  )

  return (
    <main className="chat-panel">
      {isWorkspace && !hasProject ? (
        <div className="ws-hero"><div className="ws-hero-inner"><h1 className="ws-hero-title">What should we work on?</h1><p className="ws-hero-sub">Open a project, choose one model, and develop it from this chat.</p><div className="ws-hero-actions"><button type="button" className="ws-hero-btn is-primary" onClick={onOpenProject}><FolderIcon size={16} />Open Project</button><button type="button" className="ws-hero-btn" onClick={onCreateProject}><PlusIcon size={16} />Create Project</button></div></div></div>
      ) : !hasConversation ? (
        <div className="ws-hero"><div className="ws-hero-inner is-wide"><h1 className="ws-hero-title">{hasProject ? `What should we build in ${activeProject!.name}?` : `Welcome back, ${displayName}`}</h1><p className="ws-hero-sub">{hasProject ? 'Choose a model and describe the outcome. Akorith works directly in the project and reports each step here.' : 'Pick a model and start a fresh conversation.'}</p>{composer}{selected && !selected.available.ok && <div className="chat-notice">{selected.label} unavailable: {selected.available.reason}</div>}{loadError && <div className="chat-notice">{loadError}</div>}</div></div>
      ) : (
        <>
          <div className="chat-messages" ref={scrollRef} onScroll={() => { const element = scrollRef.current; if (element) nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120 }}>
            <div className="chat-messages-col">
              {messages.map((message) => {
                const activityOwnsError = message.status === 'error' && (message.activities ?? []).some((activity) => activity.status === 'error')
                const showAssistantText = message.status === 'streaming' ? Boolean(message.text) : !activityOwnsError
                return (
                <article key={message.id} className={`chat-msg ${message.role} ${message.status}`}>
                  {message.images?.length ? <div className="chat-image-strip">{message.images.map((image, index) => <img key={index} src={`data:${image.mimeType};base64,${image.dataBase64}`} alt={image.name} />)}</div> : null}
                  {message.role === 'assistant' && message.startedAt && <WorkspaceActivity activities={message.activities ?? []} startedAt={message.startedAt} endedAt={message.endedAt} active={message.status === 'streaming'} failed={message.status === 'error'} />}
                  {message.role === 'assistant' && !showAssistantText ? null : message.role === 'assistant' ? (
                    <div className="chat-msg-text">{splitFences(message.text).map((segment, index) => segment.type === 'code' ? <div className="chat-code" key={index}><div className="chat-code-header"><span>{segment.lang ?? 'code'}</span>{copyButton(segment.content, `${message.id}-${index}`)}</div><pre>{segment.content}</pre></div> : renderProse(segment.content, `${message.id}-${index}`))}</div>
                  ) : <div className="chat-msg-text">{message.text}</div>}
                  {message.role === 'assistant' && showAssistantText && message.text && <div className="chat-msg-meta"><span>{message.meta ? `${message.meta.provider} · ${formatModelLabel(message.meta.model, message.meta.provider)}${message.meta.usage && usageLine(message.meta.usage) ? ` · ${usageLine(message.meta.usage)}` : ''}` : message.status === 'error' ? 'Task stopped' : ''}</span>{copyButton(message.text, `${message.id}-all`)}</div>}
                </article>
                )
              })}
            </div>
          </div>
          <div className="composer-dock">
            {latestWorkspaceStep !== null && (
              <div className={`workspace-step-dock ${latestWorkspaceRun?.status === 'streaming' ? 'is-active' : ''}`} aria-label={`Workspace step ${latestWorkspaceStep} of 6`}>
                <span className="workspace-step"><i />Step {latestWorkspaceStep} / 6</span>
              </div>
            )}
            {composer}
          </div>
        </>
      )}
      {toast && <div className="bridge-toast ok">{toast}</div>}
    </main>
  )
}
