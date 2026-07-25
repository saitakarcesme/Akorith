import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ContextInfo, ProjectRow, ProviderInfo, RouterSuggestion } from '../../../preload/index.d'
import { normalizeStoredOpenCodeMessage } from '../../../shared/opencode-output'
import type { ChatMode, HistorySelection } from '../App'
import { deriveWorkspaceWorkflow } from '../workspaceWorkflow'
import { FileIcon, FolderIcon, PaperclipIcon, PlanIcon, PlusIcon, QueueIcon, SendIcon, SparkIcon, StopIcon } from './icons'
import type { ChatMessage, ComposerAttachment, QueuedTurn } from './chat-types'
import { ComposerSendButton } from './CreationPrimitives'
import ModelPicker from './ModelPicker'
import WorkspaceStepDock from './WorkspaceStepDock'
import { ProjectPreviewPanel } from './ProjectPreviewPanel'

const loadChatMessageView = () => import('./ChatMessageView')
const ChatMessageView = lazy(loadChatMessageView)

interface ChatPanelProps {
  mode: ChatMode
  active: boolean
  historySel: HistorySelection | null
  activeProject: ProjectRow | null
  onOpenProject: () => void
  onCreateProject: () => void
  onHistoryChange: () => void
  onActiveSession: (sessionId: string | null) => void
  pendingSessions?: Set<string>
  onPendingChange?: (sessionId: string, pending: boolean) => void
}

const MAX_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024
const MAX_COMPOSER_HEIGHT = 192
const TOKEN_RENDER_INTERVAL_MS = 100
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'rtf', 'md', 'txt', 'csv', 'xls', 'xlsx', 'ppt', 'pptx'])
const CODE_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'css', 'scss', 'html', 'json', 'yaml', 'yml', 'toml', 'sql', 'sh'])

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function storageString(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}

function isLocalAutoStarting(provider?: ProviderInfo): boolean {
  return Boolean(provider?.id === 'local' && !provider.available.ok && /Akorith (is starting Ollama|tried to auto-start it)/i.test(provider.available.reason ?? ''))
}

function attachmentKind(file: File): ComposerAttachment['kind'] {
  if (IMAGE_TYPES.has(file.type)) return 'image'
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
  if (CODE_EXTENSIONS.has(extension) || file.type.startsWith('text/')) return 'code'
  return 'file'
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

export default function ChatPanel({
  mode,
  active,
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
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [intent, setIntent] = useState<'execute' | 'plan'>('execute')
  const [activeRequests, setActiveRequests] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null)
  const [digestEnabled, setDigestEnabled] = useState(false)
  const [suggestion, setSuggestion] = useState<RouterSuggestion | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [queueVersion, setQueueVersion] = useState(0)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionFiles, setMentionFiles] = useState<string[]>([])
  const [displayName] = useState(() => storageString('akorith.displayName', 'Ibrahim').trim() || 'Ibrahim')
  const [ollamaActive, setOllamaActive] = useState<{ label: string; baseUrl: string } | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)
  const activeSessionRef = useRef<string | null>(null)
  const messagesRef = useRef<ChatMessage[]>([])
  const sessionMessagesRef = useRef<Record<string, ChatMessage[]>>({})
  const queuedTurnsRef = useRef<Record<string, QueuedTurn[]>>({})
  const tokenBuffersRef = useRef<Record<string, string>>({})
  const tokenTimersRef = useRef<Record<string, number>>({})
  const historyHydrationRequestRef = useRef(0)
  const activeRef = useRef(active)
  activeRef.current = active
  const isWorkspace = mode === 'workspace'
  const hasProject = isWorkspace && Boolean(activeProject?.path)

  const resizeComposer = useCallback((): void => {
    const input = composerInputRef.current
    if (!input) return
    input.style.height = '0px'
    const scrollHeight = input.scrollHeight
    const nextHeight = Math.min(MAX_COMPOSER_HEIGHT, Math.max(48, scrollHeight))
    input.style.height = `${nextHeight}px`
    input.style.overflowY = scrollHeight > MAX_COMPOSER_HEIGHT ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(() => {
    resizeComposer()
  }, [draft, resizeComposer])

  useEffect(() => {
    window.addEventListener('resize', resizeComposer)
    return () => window.removeEventListener('resize', resizeComposer)
  }, [resizeComposer])

  // Plan is a workspace-only capability. A user who leaves a planned project
  // turn for General Chat must never carry the hidden read-only intent into a
  // normal conversation where there is no Plan control to turn it off.
  useEffect(() => {
    if (!isWorkspace) setIntent('execute')
  }, [isWorkspace])

  const publishMessages = useCallback((next: ChatMessage[]): void => {
    messagesRef.current = next
    if (activeRef.current) setMessages(next)
  }, [])

  const setSessionMessages = useCallback((sessionId: string, updater: (items: ChatMessage[]) => ChatMessage[]): void => {
    const base = sessionMessagesRef.current[sessionId] ?? (activeSessionRef.current === sessionId ? messagesRef.current : [])
    const next = updater(base)
    sessionMessagesRef.current[sessionId] = next
    if (activeSessionRef.current === sessionId) {
      messagesRef.current = next
      if (activeRef.current) setMessages(next)
    }
  }, [])

  // Streaming and activity events continue updating the canonical refs while
  // Workspace is hidden. Publish the accumulated transcript only once when the
  // user returns so hidden Markdown never reparses on every token batch.
  useLayoutEffect(() => {
    if (!active) return
    const sessionId = activeSessionRef.current
    const latest = sessionId
      ? sessionMessagesRef.current[sessionId] ?? messagesRef.current
      : messagesRef.current
    messagesRef.current = latest
    setMessages((current) => current === latest ? current : latest)
  }, [active])

  const loadProviders = useCallback(async (force = false): Promise<void> => {
    try {
      const list = await window.api.chat.listProviders(force)
      setProviders(list)
      setProviderId((current) => {
        const existing = list.find((provider) => provider.id === current)
        if (existing?.available.ok || isLocalAutoStarting(existing)) return current
        return list.find((provider) => provider.available.ok)?.id ?? ''
      })
      setLoadError(null)
    } catch (error) {
      setProviders([])
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const refreshContext = useCallback(async (sessionId: string | null): Promise<void> => {
    if (!sessionId) { setContextInfo(null); return }
    try { setContextInfo(await window.api.chat.contextInfo(sessionId)) } catch { setContextInfo(null) }
  }, [])

  useEffect(() => {
    void loadProviders()
    void window.api.digest.getSettings().then((settings) => setDigestEnabled(settings.enabled))
    void window.api.ollama.autoConnect().then((result) => {
      if (!result.ok) return
      setOllamaActive({ label: result.active.label, baseUrl: result.active.baseUrl })
      if (result.switched) void loadProviders()
    }).catch(() => {})
  }, [loadProviders])

  useEffect(() => {
    if (!moreOpen) return
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMoreOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [moreOpen])

  useEffect(() => {
    const requestNonce = ++historyHydrationRequestRef.current
    if (!historySel || historySel.mode !== mode) return
    if (activeSessionRef.current) sessionMessagesRef.current[activeSessionRef.current] = messagesRef.current
    nearBottomRef.current = true
    setConfirmingClear(false)
    setMentionQuery(null)
    setMentionFiles([])
    if (!historySel.sessionId) {
      publishMessages([])
      setActiveSessionId(null)
      activeSessionRef.current = null
      onActiveSession(null)
      setContextInfo(null)
      if (historySel.providerId) setProviderId(historySel.providerId)
      return
    }
    if (pendingSessions?.has(historySel.sessionId)) {
      const cached = sessionMessagesRef.current[historySel.sessionId] ?? []
      publishMessages(cached)
      setActiveSessionId(historySel.sessionId)
      activeSessionRef.current = historySel.sessionId
      onActiveSession(historySel.sessionId)
      return
    }
    const selectedSessionId = historySel.sessionId
    void window.api.history.messages(selectedSessionId).then((data) => {
      if (
        requestNonce !== historyHydrationRequestRef.current ||
        !data ||
        selectedSessionId !== data.session.id
      ) return
      const loaded: ChatMessage[] = data.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.role === 'assistant' && message.providerId === 'opencode'
          ? normalizeStoredOpenCodeMessage(message.content)
          : message.content,
        status: 'done',
        attachments: message.attachments,
        meta: message.role === 'assistant'
          ? { provider: message.providerId, model: message.model ?? 'default', usage: message.metadata?.usage, changes: message.metadata?.changes }
          : undefined,
        startedAt: message.role === 'assistant' ? message.metadata?.startedAt : undefined,
        endedAt: message.role === 'assistant' ? message.metadata?.endedAt : undefined
      }))
      sessionMessagesRef.current[data.session.id] = loaded
      publishMessages(loaded)
      setActiveSessionId(data.session.id)
      activeSessionRef.current = data.session.id
      onActiveSession(data.session.id)
      setProviderId(data.session.providerId)
      void refreshContext(data.session.id)
    })
    // A request completing changes pendingSessions, but must not reload this
    // transcript and discard its rich activity/usage state. Selection nonce is
    // the only lifecycle boundary for history hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historySel?.nonce, mode])

  const selected = providers?.find((provider) => provider.id === providerId)
  useEffect(() => { setModel((current) => selected?.models.includes(current) ? current : selected?.models[0] ?? '') }, [selected])
  useEffect(() => {
    const element = scrollRef.current
    if (element && nearBottomRef.current) element.scrollTop = element.scrollHeight
  }, [messages])

  useEffect(() => {
    if (!hasProject || !activeProject || mentionQuery === null) { setMentionFiles([]); return }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.api.projects.files(activeProject.id, mentionQuery).then((files) => {
        if (!cancelled) setMentionFiles(files.slice(0, 8))
      }).catch(() => { if (!cancelled) setMentionFiles([]) })
    }, 100)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [activeProject, hasProject, mentionQuery])

  const showToast = (message: string): void => {
    setToast(message)
    window.setTimeout(() => setToast((current) => current === message ? null : current), 2200)
  }

  const addFiles = useCallback(async (input: FileList | File[]): Promise<void> => {
    const available = Math.max(0, MAX_ATTACHMENTS - attachments.length)
    const inputFiles = Array.from(input)
    const files = inputFiles.slice(0, available)
    let totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
    const valid: File[] = []
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        showToast(`${file.name} is larger than 16 MB`)
        continue
      }
      if (file.size <= 0) continue
      if (totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        showToast('Attachments are limited to 40 MB per message')
        continue
      }
      totalBytes += file.size
      valid.push(file)
    }
    try {
      // Read sequentially so several large FileReader buffers are never held
      // concurrently before the already-bounded base64 payload crosses IPC.
      const next: ComposerAttachment[] = []
      for (const file of valid) {
        const kind = attachmentKind(file)
        next.push({
          id: newId(),
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          kind,
          dataBase64: await fileBase64(file),
          previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined
        })
      }
      setAttachments((current) => [...current, ...next])
      if (inputFiles.length > available) showToast(`Up to ${MAX_ATTACHMENTS} files can be attached`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [attachments])

  const removeAttachment = (id: string): void => {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return current.filter((item) => item.id !== id)
    })
  }

  const ensureSession = async (prompt: string, turnProviderId: string): Promise<string> => {
    if (activeSessionRef.current) return activeSessionRef.current
    const session = await window.api.history.create(turnProviderId, prompt.replace(/\s+/g, ' ').slice(0, 64), hasProject ? activeProject!.id : null)
    setActiveSessionId(session.id)
    activeSessionRef.current = session.id
    onActiveSession(session.id)
    onHistoryChange()
    return session.id
  }

  const flushToken = useCallback((requestId: string, sessionId: string, assistantId: string): void => {
    const token = tokenBuffersRef.current[requestId] ?? ''
    delete tokenBuffersRef.current[requestId]
    delete tokenTimersRef.current[requestId]
    if (!token) return
    setSessionMessages(sessionId, (current) => current.map((message) => message.id === assistantId
      ? { ...message, text: message.text + token }
      : message))
  }, [setSessionMessages])

  const executeTurnRef = useRef<(turn: QueuedTurn, requestedSessionId?: string | null) => Promise<void>>(async () => {})
  const executeTurn = useCallback(async (turn: QueuedTurn, requestedSessionId?: string | null): Promise<void> => {
    const sessionId = requestedSessionId ?? await ensureSession(turn.prompt, turn.providerId)
    const requestId = newId()
    const assistantId = newId()
    setActiveRequests((current) => ({ ...current, [sessionId]: requestId }))
    onPendingChange?.(sessionId, true)
    const startedAt = Date.now()
    let publicAttachments = turn.attachments.map(({ previewUrl: _previewUrl, dataBase64, ...item }) => ({ ...item, dataBase64 }))
    const visibleAttachments = publicAttachments.map((item) => item.kind === 'image'
      ? item
      : {
          id: item.id,
          name: item.name,
          mimeType: item.mimeType,
          size: item.size,
          kind: item.kind
        })
    setSessionMessages(sessionId, (current) => [
      ...current,
      { id: newId(), role: 'user', text: turn.prompt, status: 'done', attachments: visibleAttachments, intent: turn.intent },
      { id: assistantId, role: 'assistant', text: '', status: 'streaming', activities: isWorkspace ? [] : undefined, startedAt, intent: turn.intent }
    ])
    const offToken = window.api.chat.onToken(requestId, (token) => {
      tokenBuffersRef.current[requestId] = `${tokenBuffersRef.current[requestId] ?? ''}${token}`
      if (tokenTimersRef.current[requestId] === undefined) {
        tokenTimersRef.current[requestId] = window.setTimeout(
          () => flushToken(requestId, sessionId, assistantId),
          TOKEN_RENDER_INTERVAL_MS
        )
      }
    })
    const offActivity = isWorkspace
      ? window.api.chat.onActivity(requestId, (activity) => {
          setSessionMessages(sessionId, (current) => current.map((message) => message.id === assistantId
            ? { ...message, activities: [...(message.activities ?? []), activity].slice(-30) }
            : message))
        })
      : () => {}
    try {
      const responsePromise = window.api.chat.send({
        requestId,
        providerId: turn.providerId,
        model: turn.model || undefined,
        prompt: turn.prompt,
        sessionId,
        includeDigest: hasProject && digestEnabled,
        workspaceContext: hasProject ? { projectName: activeProject!.name, projectPath: activeProject!.path! } : undefined,
        attachments: publicAttachments,
        intent: turn.intent
      })
      // ipcRenderer.invoke clones its argument synchronously. Release the
      // renderer's non-display base64 copies while the provider is working.
      turn.attachments.length = 0
      publicAttachments = []
      const response = await responsePromise
      const timer = tokenTimersRef.current[requestId]
      if (timer !== undefined) window.clearTimeout(timer)
      delete tokenBuffersRef.current[requestId]
      delete tokenTimersRef.current[requestId]
      setSessionMessages(sessionId, (current) => current.map((message) => message.id === assistantId
        ? response.ok
          ? { ...message, text: response.result.text, status: 'done', endedAt: Date.now(), meta: { provider: turn.providerId, model: response.result.model, usage: response.result.usage, changes: response.result.changes } }
          : { ...message, text: response.error, status: 'error', endedAt: Date.now() }
        : message))
      if (response.ok) { onHistoryChange(); void refreshContext(sessionId) }
    } catch (error) {
      setSessionMessages(sessionId, (current) => current.map((message) => message.id === assistantId
        ? { ...message, text: error instanceof Error ? error.message : String(error), status: 'error', endedAt: Date.now() }
        : message))
    } finally {
      offToken()
      offActivity()
      const timer = tokenTimersRef.current[requestId]
      if (timer !== undefined) window.clearTimeout(timer)
      flushToken(requestId, sessionId, assistantId)
      setActiveRequests((current) => {
        if (current[sessionId] !== requestId) return current
        const next = { ...current }; delete next[sessionId]; return next
      })
      onPendingChange?.(sessionId, false)
      const next = queuedTurnsRef.current[sessionId]?.shift()
      setQueueVersion((version) => version + 1)
      if (next) window.setTimeout(() => { void executeTurnRef.current(next, sessionId) }, 0)
    }
  }, [activeProject, digestEnabled, flushToken, hasProject, isWorkspace, onHistoryChange, onPendingChange, refreshContext, setSessionMessages])
  executeTurnRef.current = executeTurn

  const makeTurn = (): QueuedTurn | null => {
    const prompt = draft.trim()
    if (!prompt || !selected?.available.ok || (isWorkspace && !hasProject)) return null
    return { id: newId(), prompt, providerId, model, attachments: attachments.map((item) => ({ ...item })), intent }
  }

  const clearComposerTurn = (): void => {
    for (const item of attachments) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    setDraft('')
    setAttachments([])
    setSuggestion(null)
    setMentionQuery(null)
  }

  const sendOrQueue = (): void => {
    const turn = makeTurn()
    if (!turn) return
    const sessionId = activeSessionRef.current
    const busy = sessionId ? activeRequests[sessionId] : undefined
    clearComposerTurn()
    if (busy && sessionId) {
      queuedTurnsRef.current[sessionId] = [...(queuedTurnsRef.current[sessionId] ?? []), turn]
      setQueueVersion((version) => version + 1)
      showToast('Follow-up queued')
      return
    }
    void executeTurn(turn)
  }

  const cancel = (): void => {
    const requestId = activeSessionRef.current ? activeRequests[activeSessionRef.current] : undefined
    if (requestId) window.api.chat.cancel(requestId)
  }

  const clearContext = async (): Promise<void> => {
    if (!activeSessionRef.current) return
    if (!confirmingClear) { setConfirmingClear(true); return }
    await window.api.history.clearMessages(activeSessionRef.current)
    publishMessages([])
    sessionMessagesRef.current[activeSessionRef.current] = []
    setConfirmingClear(false)
    void refreshContext(activeSessionRef.current)
    onHistoryChange()
  }

  const suggestTask = async (): Promise<void> => {
    if (!draft.trim()) return
    setSuggesting(true)
    try {
      const response = await window.api.router.suggest(draft.trim())
      if (response.ok) setSuggestion(response.suggestion)
      else showToast(response.error)
    } finally { setSuggesting(false) }
  }

  const acceptSuggestion = (): void => {
    if (!suggestion?.available) return
    setProviderId(suggestion.providerId)
    if (suggestion.model) setModel(suggestion.model)
    setSuggestion(null)
  }

  const updateDraft = (value: string): void => {
    setDraft(value)
    const match = isWorkspace ? value.match(/(?:^|\s)@([^\s@]*)$/) : null
    setMentionQuery(match ? match[1] : null)
  }

  const insertMention = (path: string): void => {
    setDraft((current) => current.replace(/@[^\s@]*$/, `@${path} `))
    setMentionQuery(null)
    setMentionFiles([])
  }

  const hasConversation = messages.length > 0
  const latestWorkspaceContext = useMemo(() => {
    if (!isWorkspace) return null
    let runIndex = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant' && messages[index].startedAt) {
        runIndex = index
        break
      }
    }
    if (runIndex < 0) return null
    const run = messages[runIndex]
    let prompt = ''
    for (let index = runIndex - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') {
        prompt = messages[index].text
        break
      }
    }
    return { run, prompt }
  }, [isWorkspace, messages])
  const latestWorkspaceRun = latestWorkspaceContext?.run
  const latestWorkspaceActivities = latestWorkspaceRun?.activities
  const latestWorkspacePrompt = latestWorkspaceContext?.prompt ?? ''
  const latestWorkspaceStatus = latestWorkspaceRun?.status
  const hasLatestWorkspaceRun = latestWorkspaceRun !== undefined
  const latestWorkspaceSteps = useMemo(
    () => hasLatestWorkspaceRun
      ? deriveWorkspaceWorkflow({
          prompt: latestWorkspacePrompt,
          projectName: activeProject?.name,
          activities: latestWorkspaceActivities ?? [],
          active: latestWorkspaceStatus === 'streaming',
          failed: latestWorkspaceStatus === 'error'
        })
      : [],
    [
      activeProject?.name,
      hasLatestWorkspaceRun,
      latestWorkspaceActivities,
      latestWorkspacePrompt,
      latestWorkspaceStatus
    ]
  )
  const busyRequestId = activeSessionId ? activeRequests[activeSessionId] : undefined
  const currentQueue = activeSessionId ? queuedTurnsRef.current[activeSessionId] ?? [] : []
  void queueVersion
  const canSubmit = Boolean(draft.trim() && selected?.available.ok && (!isWorkspace || hasProject))
  const contextCount = contextInfo?.totalMessages ?? 0
  const memoryLabel = contextCount > 0 ? `Memory: ${contextCount} messages` : hasProject ? 'Project memory on' : 'Session memory on'
  const quickActions = hasProject
    ? [
        { label: 'Build a feature', prompt: 'Build the next useful feature for this project and verify it end to end.', icon: SparkIcon, tone: 'blue' },
        { label: 'Fix an issue', prompt: 'Find the most important issue in this project, fix it, and run the relevant checks.', icon: PlanIcon, tone: 'purple' },
        { label: 'Improve the UI', prompt: 'Review the current interface and implement the highest-impact UI improvement.', icon: FileIcon, tone: 'green' },
        { label: 'Run a review', prompt: 'Review the project for correctness, reliability, and maintainability. Fix concrete findings.', icon: QueueIcon, tone: 'orange' }
      ]
    : []

  const composer = (
    <div className="composer" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void addFiles(event.dataTransfer.files) }}>
      {hasConversation && hasProject && activeProject?.path && (
        <div className="replica-feature-banner">
          <ProjectPreviewPanel
            projectPath={activeProject.path}
            projectName={activeProject.name}
            active={active}
            hideWhenUnavailable
            refreshKey={latestWorkspaceRun?.endedAt ?? latestWorkspaceRun?.startedAt}
          />
        </div>
      )}
      {suggestion && <div className="router-suggestion"><div className="router-suggestion-head"><span className={`tier-badge tier-${suggestion.tier}`}>{suggestion.rank} · {suggestion.tier}</span><span className="router-target">→ {suggestion.providerLabel}{suggestion.model ? ` · ${suggestion.model}` : ''}</span></div><div className="router-reason">{suggestion.reason}</div><div className="router-actions"><button type="button" className="router-accept" disabled={!suggestion.available} onClick={acceptSuggestion}>Use model</button><button type="button" className="router-ignore" onClick={() => setSuggestion(null)}>Dismiss</button></div></div>}
      {currentQueue.length > 0 && <div className="composer-queue"><QueueIcon size={14} /><span>{currentQueue.length} follow-up{currentQueue.length === 1 ? '' : 's'} queued</span><button type="button" onClick={() => { queuedTurnsRef.current[activeSessionId!] = []; setQueueVersion((version) => version + 1) }}>Clear</button></div>}
      <div className={`composer-box ${intent === 'plan' ? 'is-plan' : ''}`}>
        {attachments.length > 0 && <div className="composer-attachments">{attachments.map((item) => <div className={`composer-attachment is-${item.kind}`} key={item.id}>{item.previewUrl ? <img src={item.previewUrl} alt="" /> : <FileIcon size={15} />}<span>{item.name}</span><small>{Math.max(1, Math.round(item.size / 1024))} KB</small><button type="button" aria-label={`Remove ${item.name}`} onClick={() => removeAttachment(item.id)}>×</button></div>)}</div>}
        {mentionQuery !== null && mentionFiles.length > 0 && <div className="composer-mention-pop" role="listbox"><div className="composer-mention-head">Project files</div>{mentionFiles.map((path) => <button type="button" role="option" key={path} onClick={() => insertMention(path)}><FileIcon size={13} /><span>{path}</span></button>)}</div>}
        <textarea
          ref={composerInputRef}
          className="composer-input"
          placeholder={!selected?.available.ok ? 'Select an available model…' : hasProject ? `Ask Akorith to work in ${activeProject!.name}…` : isWorkspace ? 'Open a project to start…' : 'Ask Akorith anything…'}
          value={draft}
          onFocus={() => { void loadChatMessageView() }}
          onChange={(event) => updateDraft(event.target.value)}
          onPaste={(event) => { if (event.clipboardData.files.length) void addFiles(event.clipboardData.files) }}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendOrQueue() } }}
          rows={1}
          spellCheck
        />
        <div className="composer-controls">
          <div className="composer-controls-left">
            <input ref={fileInputRef} type="file" multiple className="composer-file-input" onChange={(event) => void addFiles(event.target.files ?? [])} />
            <button type="button" className="composer-chip" title="Attach files or images" onClick={() => fileInputRef.current?.click()}><PaperclipIcon size={13} /><span>Attach</span></button>
            {isWorkspace && <button type="button" className={`composer-chip ${intent === 'plan' ? 'is-active' : ''}`} title="Plan without editing files" onClick={() => setIntent((current) => current === 'plan' ? 'execute' : 'plan')}><PlanIcon size={13} /><span>Plan</span></button>}
            <div className="composer-more"><button type="button" className={`composer-chip ${moreOpen ? 'is-active' : ''}`} onClick={() => setMoreOpen((open) => !open)}><SparkIcon size={13} /><span>More</span></button>{moreOpen && <><div className="composer-more-backdrop" onClick={() => setMoreOpen(false)} /><div className="composer-more-pop" role="menu"><button type="button" className="composer-more-item" disabled={!draft.trim() || suggesting} onClick={() => { setMoreOpen(false); void suggestTask() }}><SparkIcon size={13} /><span>{suggesting ? 'Classifying…' : 'Suggest model'}</span></button>{hasProject && <><div className="composer-more-sep" /><label className="composer-more-toggle"><span>Repository context</span><input type="checkbox" checked={digestEnabled} onChange={() => { const next = !digestEnabled; setDigestEnabled(next); void window.api.digest.setEnabled(next) }} /></label></>}</div></>}</div>
          </div>
          <div className="composer-submit-group">
            <ModelPicker providers={providers} providerId={providerId} model={model} onSelect={(nextProvider, nextModel) => { setProviderId(nextProvider); setModel(nextModel) }} onRefresh={() => void loadProviders(true)} modelSource={(id) => id === 'local' ? ollamaActive?.label ?? 'Local' : undefined} />
            {busyRequestId && canSubmit && <button type="button" className="composer-queue-button" onClick={sendOrQueue}><QueueIcon size={14} />Queue</button>}
            {busyRequestId ? <ComposerSendButton stop onClick={cancel}><StopIcon size={16} /></ComposerSendButton> : <ComposerSendButton disabled={!canSubmit} onClick={sendOrQueue}><SendIcon size={16} /></ComposerSendButton>}
          </div>
        </div>
      </div>
      <div className="context-bar"><span className="context-chip"><span className="context-dot" />{memoryLabel}</span>{hasProject && <span className="context-hint">Type @ to add a project file</span>}{activeSessionId && hasConversation && <button type="button" disabled={Boolean(busyRequestId)} className={`context-clear ${confirmingClear ? 'is-confirm' : ''}`} onClick={() => void clearContext()}>{confirmingClear ? 'Reset context?' : 'Reset context'}</button>}</div>
    </div>
  )

  return (
    <main className="chat-panel">
      {isWorkspace && !hasProject ? (
        <div className="ws-hero replica-home">
          <div className="ws-hero-inner">
            <h1 className="ws-hero-title">What would you like to work on?</h1>
            <p className="ws-hero-sub">Open a project to start a fully connected workspace.</p>
            <div className="ws-hero-actions">
              <button type="button" className="ws-hero-btn is-primary" onClick={onOpenProject}><FolderIcon size={16} />Open Project</button>
              <button type="button" className="ws-hero-btn" onClick={onCreateProject}><PlusIcon size={16} />Create Project</button>
            </div>
          </div>
        </div>
      ) : !hasConversation ? (
        <div className="ws-hero replica-home">
          <div className="ws-hero-inner is-wide">
            <div className="replica-home-greeting">
              <h1 className="ws-hero-title">
                {hasProject ? (
                  <>What would you like to do in <button type="button" onClick={() => composerInputRef.current?.focus()}>{activeProject!.name}?</button></>
                ) : `Welcome back, ${displayName}`}
              </h1>
            </div>
            {composer}
            {hasProject && (
              <div className="replica-suggestion-grid" aria-label="Suggested project tasks">
                {quickActions.map(({ label, prompt, icon: Icon, tone }) => (
                  <button
                    type="button"
                    className="replica-suggestion-card"
                    key={label}
                    onClick={() => {
                      updateDraft(prompt)
                      window.setTimeout(() => composerInputRef.current?.focus(), 0)
                    }}
                  >
                    <Icon size={16} className={`is-${tone}`} />
                    <strong>{label}</strong>
                  </button>
                ))}
              </div>
            )}
            {selected && !selected.available.ok && <div className="chat-notice">{selected.label} unavailable: {selected.available.reason}</div>}
            {loadError && <div className="chat-notice">{loadError}</div>}
          </div>
        </div>
      )
          : <><div className="chat-messages" ref={scrollRef} onScroll={() => { const element = scrollRef.current; if (element) nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120 }}><div className="chat-messages-col"><Suspense fallback={<div className="chat-transcript-loading" role="status">Opening conversation...</div>}>{messages.map((message) => <ChatMessageView key={message.id} message={message} isWorkspace={isWorkspace} projectName={activeProject?.name} />)}</Suspense></div></div><div className="composer-dock">{latestWorkspaceSteps.length > 0 && <WorkspaceStepDock steps={latestWorkspaceSteps} active={latestWorkspaceRun?.status === 'streaming'} />}{composer}</div></>}
      {toast && <div className="bridge-toast ok">{toast}</div>}
    </main>
  )
}
