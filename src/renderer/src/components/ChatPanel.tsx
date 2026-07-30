import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ContextInfo, GitStatusResult, ProjectRow, ProviderInfo, RouterSuggestion } from '../../../preload/index.d'
import type { ChatMode, HistorySelection } from '../App'
import { insertWorkspaceLoopCommand, parseWorkspaceLoopCommand, workspaceLoopHint } from '../workspaceLoopCommand'
import { deriveWorkspaceWorkflow, type WorkspaceWorkflowSnapshot } from '../workspaceWorkflow'
import { mergeWorkspaceActivityEvent } from '../workspaceActivityFeed'
import { liveWorkspaceChangesSince, newlyCreatedWorkspaceFiles } from '../workspaceLiveChanges'
import { workspaceRequestTimeoutMs } from '../workspaceRequestTimeout'
import { FileIcon, FolderIcon, PaperclipIcon, PlanIcon, PlusIcon, QueueIcon, SendIcon, SparkIcon, StopIcon } from './icons'
import type { ChatMessage, ComposerAttachment, QueuedTurn } from './chat-types'
import { ComposerSendButton } from './CreationPrimitives'
import ModelPicker from './ModelPicker'
import WorkspaceLiveChangesCard from './WorkspaceLiveChangesCard'
import type { WorkspaceToolId } from './WorkspaceToolsPanel'
import { hydrateStoredChatMessages } from './chat-history'

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
  onWorkspaceContentChange?: (projectId: string) => void
  onWorkspaceToolRequest?: (request: {
    projectId: string
    sessionId: string
    requestId: string
    tool: WorkspaceToolId
    reason: 'activity' | 'changes'
  }) => void
  onWorkspaceStepsChange?: (snapshot: WorkspaceWorkflowSnapshot | null) => void
}

const MAX_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024
const MAX_COMPOSER_HEIGHT = 192
const TOKEN_RENDER_INTERVAL_MS = 100
const FINAL_RESPONSE_REVEAL_INTERVAL_MS = 55
const FINAL_RESPONSE_REVEAL_STEPS = 9
const LIVE_CHANGE_POLL_MS = 2_000
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'rtf', 'md', 'txt', 'csv', 'xls', 'xlsx', 'ppt', 'pptx'])
const CODE_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'css', 'scss', 'html', 'json', 'yaml', 'yml', 'toml', 'sql', 'sh'])

interface ComposerNotice {
  id: string
  message: string
  tone: 'error' | 'success'
}

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
  onPendingChange,
  onWorkspaceContentChange,
  onWorkspaceToolRequest,
  onWorkspaceStepsChange
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
  const [toast, setToast] = useState<ComposerNotice | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [queueVersion, setQueueVersion] = useState(0)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionFiles, setMentionFiles] = useState<string[]>([])
  const [displayName] = useState(() => storageString('akorith.displayName', 'Ibrahim').trim() || 'Ibrahim')
  const [ollamaActive, setOllamaActive] = useState<{ label: string; baseUrl: string } | null>(null)
  const [loopStarting, setLoopStarting] = useState(false)
  const [startingTurn, setStartingTurn] = useState<QueuedTurn | null>(null)
  const [stoppingRequests, setStoppingRequests] = useState<Record<string, boolean>>({})
  const [showLatestActivity, setShowLatestActivity] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const scrollFrameRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)
  const activeSessionRef = useRef<string | null>(null)
  const activeSessionProviderRef = useRef<string | null>(null)
  const activeSessionProjectRef = useRef<string | null>(null)
  const messagesRef = useRef<ChatMessage[]>([])
  const sessionMessagesRef = useRef<Record<string, ChatMessage[]>>({})
  const queuedTurnsRef = useRef<Record<string, QueuedTurn[]>>({})
  const tokenBuffersRef = useRef<Record<string, string>>({})
  const tokenTimersRef = useRef<Record<string, number>>({})
  const revealGenerationRef = useRef<Record<string, number>>({})
  const historyHydrationRequestRef = useRef(0)
  const activeRef = useRef(active)
  const loopStartingRef = useRef(false)
  const cancelledStartingTurnsRef = useRef(new Set<string>())
  activeRef.current = active
  const isWorkspace = mode === 'workspace'
  const hasProject = isWorkspace && Boolean(activeProject?.path)

  useEffect(() => () => {
    activeRef.current = false
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    for (const requestId of Object.keys(revealGenerationRef.current)) {
      revealGenerationRef.current[requestId] += 1
    }
  }, [])

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

  useEffect(() => {
    if (!isWorkspace) return
    const requestFileEdit = (event: Event): void => {
      const path = (event as CustomEvent<{ path?: unknown }>).detail?.path
      if (typeof path !== 'string' || !path.trim()) return
      setIntent('execute')
      setDraft(`Please edit @${path}.\n\nRequested change: `)
      window.requestAnimationFrame(() => {
        resizeComposer()
        composerInputRef.current?.focus()
        composerInputRef.current?.setSelectionRange(
          composerInputRef.current.value.length,
          composerInputRef.current.value.length
        )
      })
    }
    const requestGitAction = (): void => {
      setIntent('execute')
      setDraft('Review the current Git changes, summarize the important diff, then commit and push the finished work safely. ')
      window.requestAnimationFrame(() => {
        resizeComposer()
        composerInputRef.current?.focus()
        composerInputRef.current?.setSelectionRange(
          composerInputRef.current.value.length,
          composerInputRef.current.value.length
        )
      })
    }
    window.addEventListener('akorith:request-file-edit', requestFileEdit)
    window.addEventListener('akorith:request-git-action', requestGitAction)
    return () => {
      window.removeEventListener('akorith:request-file-edit', requestFileEdit)
      window.removeEventListener('akorith:request-git-action', requestGitAction)
    }
  }, [isWorkspace, resizeComposer])

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
    if (!sessionId) {
      if (!activeSessionRef.current) setContextInfo(null)
      return
    }
    try {
      const next = await window.api.chat.contextInfo(sessionId)
      if (activeSessionRef.current === sessionId) setContextInfo(next)
    } catch {
      if (activeSessionRef.current === sessionId) setContextInfo(null)
    }
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
      activeSessionProviderRef.current = null
      activeSessionProjectRef.current = null
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
      activeSessionProviderRef.current = historySel.providerId ?? null
      activeSessionProjectRef.current = isWorkspace ? activeProject?.id ?? null : null
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
      const loaded = hydrateStoredChatMessages(data.messages, isWorkspace)
      sessionMessagesRef.current[data.session.id] = loaded
      publishMessages(loaded)
      setActiveSessionId(data.session.id)
      activeSessionRef.current = data.session.id
      activeSessionProviderRef.current = data.session.providerId
      activeSessionProjectRef.current = data.session.projectId
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

  const followLatestActivity = useCallback((force = false): void => {
    const element = scrollRef.current
    if (!element || (!force && !nearBottomRef.current)) return
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      const current = scrollRef.current
      if (!current) return
      current.scrollTop = current.scrollHeight
      nearBottomRef.current = true
      setShowLatestActivity(false)
    })
  }, [])

  useEffect(() => {
    followLatestActivity()
  }, [followLatestActivity, messages])

  useEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript || typeof ResizeObserver === 'undefined') return
    let previousHeight = transcript.getBoundingClientRect().height
    const observer = new ResizeObserver(() => {
      const nextHeight = transcript.getBoundingClientRect().height
      if (nextHeight <= previousHeight) {
        previousHeight = nextHeight
        return
      }
      previousHeight = nextHeight
      if (nearBottomRef.current) followLatestActivity()
      else setShowLatestActivity(true)
    })
    observer.observe(transcript)
    return () => observer.disconnect()
  }, [followLatestActivity, messages.length])

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

  const showToast = (message: string, tone: ComposerNotice['tone'] = 'error'): void => {
    const notice = { id: newId(), message, tone }
    setToast(notice)
    window.setTimeout(() => setToast((current) => current?.id === notice.id ? null : current), 3200)
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

  const ensureSession = async (
    prompt: string,
    turnProviderId: string,
    projectId: string | null
  ): Promise<string> => {
    if (
      activeSessionRef.current &&
      activeSessionProviderRef.current === turnProviderId &&
      activeSessionProjectRef.current === projectId
    ) return activeSessionRef.current

    if (activeSessionRef.current) {
      sessionMessagesRef.current[activeSessionRef.current] = messagesRef.current
    }
    const session = await window.api.history.create(
      turnProviderId,
      prompt.replace(/\s+/g, ' ').slice(0, 64),
      projectId
    )
    publishMessages([])
    setContextInfo(null)
    setActiveSessionId(session.id)
    activeSessionRef.current = session.id
    activeSessionProviderRef.current = turnProviderId
    activeSessionProjectRef.current = projectId
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

  const revealFinalResponse = useCallback(async (
    requestId: string,
    sessionId: string,
    assistantId: string,
    finalText: string
  ): Promise<void> => {
    const currentText = (sessionMessagesRef.current[sessionId] ?? [])
      .find((message) => message.id === assistantId)?.text ?? ''
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (
      !activeRef.current ||
      activeSessionRef.current !== sessionId ||
      document.hidden ||
      reducedMotion ||
      currentText === finalText ||
      !finalText.startsWith(currentText)
    ) {
      if (currentText !== finalText) {
        setSessionMessages(sessionId, (current) => current.map((message) => message.id === assistantId
          ? { ...message, text: finalText }
          : message))
      }
      return
    }

    const remaining = finalText.length - currentText.length
    const step = Math.max(24, Math.ceil(remaining / FINAL_RESPONSE_REVEAL_STEPS))
    const generation = revealGenerationRef.current[requestId] ?? 0
    let cursor = currentText.length
    while (cursor < finalText.length) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, FINAL_RESPONSE_REVEAL_INTERVAL_MS))
      if (
        revealGenerationRef.current[requestId] !== generation ||
        activeSessionRef.current !== sessionId
      ) {
        return
      }
      if (!activeRef.current || document.hidden) {
        cursor = finalText.length
      } else {
        cursor = Math.min(finalText.length, cursor + step)
      }
      const text = finalText.slice(0, cursor)
      setSessionMessages(sessionId, (current) => current.map((message) => message.id === assistantId
        ? { ...message, text }
        : message))
    }
  }, [setSessionMessages])

  const executeTurnRef = useRef<(turn: QueuedTurn, requestedSessionId?: string | null) => Promise<void>>(async () => {})
  const executeTurn = useCallback(async (turn: QueuedTurn, requestedSessionId?: string | null): Promise<void> => {
    const requestId = turn.id
    let sessionId: string
    try {
      sessionId = requestedSessionId ?? await ensureSession(
        turn.prompt,
        turn.providerId,
        turn.workspace?.projectId ?? null
      )
    } catch (error) {
      setStartingTurn((current) => current?.id === turn.id ? null : current)
      showToast(error instanceof Error ? error.message : String(error))
      return
    }
    if (cancelledStartingTurnsRef.current.delete(turn.id)) {
      setStartingTurn((current) => current?.id === turn.id ? null : current)
      return
    }
    const assistantId = newId()
    const liveChangesBaselinePromise: Promise<GitStatusResult | null> = turn.workspace && turn.intent !== 'plan'
      ? window.api.git.status(turn.workspace.projectPath).catch(() => null)
      : Promise.resolve(null)
    revealGenerationRef.current[requestId] = 0
    const requestedTools = new Set<WorkspaceToolId>()
    const requestWorkspaceTool = (tool: WorkspaceToolId, reason: 'activity' | 'changes'): void => {
      if (
        !turn.workspace ||
        activeSessionRef.current !== sessionId ||
        (reason === 'activity' && requestedTools.has(tool))
      ) return
      requestedTools.add(tool)
      onWorkspaceToolRequest?.({ projectId: turn.workspace.projectId, sessionId, requestId, tool, reason })
    }
    setActiveRequests((current) => ({ ...current, [sessionId]: requestId }))
    onPendingChange?.(sessionId, true)
    const startedAt = turn.startedAt
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
      {
        id: assistantId,
        role: 'assistant',
        text: '',
        status: 'streaming',
        activities: turn.mode === 'workspace' ? [] : undefined,
        taskPrompt: turn.prompt,
        startedAt,
        intent: turn.intent,
        meta: { provider: turn.providerId, model: turn.model || 'default' }
      }
    ])
    setStartingTurn((current) => current?.id === turn.id ? null : current)
    const offToken = window.api.chat.onToken(requestId, (token) => {
      tokenBuffersRef.current[requestId] = `${tokenBuffersRef.current[requestId] ?? ''}${token}`
      if (tokenTimersRef.current[requestId] === undefined) {
        tokenTimersRef.current[requestId] = window.setTimeout(
          () => flushToken(requestId, sessionId, assistantId),
          TOKEN_RENDER_INTERVAL_MS
        )
      }
    })
    const offActivity = turn.mode === 'workspace'
      ? window.api.chat.onActivity(requestId, (activity) => {
          if (
            activity.surface === 'review' ||
            activity.surface === 'terminal' ||
            activity.surface === 'browser' ||
            activity.surface === 'computer' ||
            activity.surface === 'files'
          ) {
            requestWorkspaceTool(activity.surface, 'activity')
          }
          setSessionMessages(sessionId, (current) => current.map((message) => message.id === assistantId
            ? { ...message, activities: mergeWorkspaceActivityEvent(message.activities ?? [], activity) }
            : message))
        })
      : () => {}
    let stopLiveChangePolling = (): void => {}
    try {
      const responsePromise = window.api.chat.send({
        requestId,
        providerId: turn.providerId,
        model: turn.model || undefined,
        prompt: turn.prompt,
        sessionId,
        includeDigest: Boolean(turn.workspace) && digestEnabled,
        workspaceContext: turn.workspace
          ? { projectName: turn.workspace.projectName, projectPath: turn.workspace.projectPath }
          : undefined,
        attachments: publicAttachments,
        intent: turn.intent,
        generation: turn.mode === 'workspace'
          ? { timeoutMs: workspaceRequestTimeoutMs(turn.providerId) }
          : undefined
      })
      // Register the IPC request before awaiting the optional Git snapshot so
      // Stop can cancel immediately and provider startup is not serialized
      // behind a renderer-only status read.
      void responsePromise.catch(() => {})
      // ipcRenderer.invoke clones its argument synchronously. Release the
      // renderer's non-display base64 copies while the provider is working.
      turn.attachments.length = 0
      publicAttachments = []
      const liveChangesBaseline = await liveChangesBaselinePromise
      if (turn.workspace && liveChangesBaseline?.ok && liveChangesBaseline.isRepo) {
        let stopped = false
        let timer: number | undefined
        let lastSignature = ''
        const announcedCreatedFiles = new Set<string>()
        const poll = async (): Promise<void> => {
          if (stopped) return
          if (
            activeRef.current &&
            !document.hidden &&
            activeSessionRef.current === sessionId
          ) {
            const current = await window.api.git.status(turn.workspace!.projectPath).catch(() => null)
            if (stopped) return
            if (current) {
              const changes = liveWorkspaceChangesSince(liveChangesBaseline, current)
              const signature = JSON.stringify(changes ?? null)
              if (signature !== lastSignature) {
                lastSignature = signature
                const created = changes
                  ? newlyCreatedWorkspaceFiles(changes).filter((path) => !announcedCreatedFiles.has(path))
                  : []
                for (const path of created) announcedCreatedFiles.add(path)
                const timestamp = Date.now()
                setSessionMessages(sessionId, (items) => items.map((message) => {
                  if (message.id !== assistantId || message.status !== 'streaming') return message
                  const createdActivities = created.map((path, index) => ({
                    kind: 'file' as const,
                    label: `Created ${path}`,
                    detail: 'Detected in this task’s Git working-tree changes',
                    status: 'complete' as const,
                    timestamp: timestamp + index
                  }))
                  return {
                    ...message,
                    meta: { ...(message.meta ?? { provider: turn.providerId, model: turn.model || 'default' }), changes },
                    activities: createdActivities.length
                      ? createdActivities.reduce(
                          (activityItems, activity) => mergeWorkspaceActivityEvent(activityItems, activity),
                          message.activities ?? []
                        )
                      : message.activities
                  }
                }))
              }
            }
          }
          if (!stopped) timer = window.setTimeout(() => { void poll() }, LIVE_CHANGE_POLL_MS)
        }
        timer = window.setTimeout(() => { void poll() }, 800)
        stopLiveChangePolling = () => {
          stopped = true
          if (timer !== undefined) window.clearTimeout(timer)
        }
      }
      const response = await responsePromise
      stopLiveChangePolling()
      const completedAt = Date.now()
      const timer = tokenTimersRef.current[requestId]
      if (timer !== undefined) window.clearTimeout(timer)
      delete tokenBuffersRef.current[requestId]
      delete tokenTimersRef.current[requestId]
      if (response.ok) {
        await revealFinalResponse(requestId, sessionId, assistantId, response.result.text)
        setSessionMessages(sessionId, (current) => current.map((message) => message.id === assistantId
          ? { ...message, text: response.result.text, status: 'done', endedAt: completedAt, meta: { provider: turn.providerId, model: response.result.model, usage: response.result.usage, changes: response.result.changes } }
          : message))
        if (response.result.changes?.files.length) requestWorkspaceTool('review', 'changes')
        onHistoryChange()
        void refreshContext(sessionId)
      } else {
        setSessionMessages(sessionId, (current) => current.map((message) => message.id === assistantId
          ? { ...message, text: response.error, status: 'error', endedAt: completedAt }
          : message))
      }
    } catch (error) {
      setSessionMessages(sessionId, (current) => current.map((message) => message.id === assistantId
        ? { ...message, text: error instanceof Error ? error.message : String(error), status: 'error', endedAt: Date.now() }
        : message))
    } finally {
      stopLiveChangePolling()
      offToken()
      offActivity()
      const timer = tokenTimersRef.current[requestId]
      if (timer !== undefined) window.clearTimeout(timer)
      flushToken(requestId, sessionId, assistantId)
      delete revealGenerationRef.current[requestId]
      setActiveRequests((current) => {
        if (current[sessionId] !== requestId) return current
        const next = { ...current }; delete next[sessionId]; return next
      })
      onPendingChange?.(sessionId, false)
      setStoppingRequests((current) => {
        if (!current[requestId]) return current
        const next = { ...current }
        delete next[requestId]
        return next
      })
      if (turn.workspace) onWorkspaceContentChange?.(turn.workspace.projectId)
      const next = queuedTurnsRef.current[sessionId]?.shift()
      setQueueVersion((version) => version + 1)
      if (next) window.setTimeout(() => { void executeTurnRef.current(next) }, 0)
    }
  }, [digestEnabled, flushToken, onHistoryChange, onPendingChange, onWorkspaceContentChange, onWorkspaceToolRequest, refreshContext, revealFinalResponse, setSessionMessages])
  executeTurnRef.current = executeTurn

  const makeTurn = (): QueuedTurn | null => {
    const prompt = draft.trim()
    if (!prompt || !selected?.available.ok || (isWorkspace && !hasProject)) return null
    return {
      id: newId(),
      startedAt: Date.now(),
      prompt,
      providerId,
      model,
      attachments: attachments.map((item) => ({ ...item })),
      intent,
      mode,
      workspace: hasProject && activeProject?.path
        ? {
            projectId: activeProject.id,
            projectName: activeProject.name,
            projectPath: activeProject.path
          }
        : null
    }
  }

  const clearComposerTurn = (): void => {
    for (const item of attachments) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    setDraft('')
    setAttachments([])
    setSuggestion(null)
    setMentionQuery(null)
  }

  const startWorkspaceLoopGoal = async (prompt: string, goal: string): Promise<void> => {
    if (loopStartingRef.current) return
    if (attachments.length > 0) {
      showToast('Remove attachments before starting /loop. Project files remain available in the workspace.')
      return
    }
    if (!hasProject || !activeProject?.path) {
      showToast('Open a project before starting /loop.')
      return
    }
    if (!selected?.available.ok) {
      showToast('Select an available workspace model before starting /loop.')
      return
    }
    if (!selected.kind.includes('executor')) {
      showToast(`${selected.label} cannot edit a workspace. Select an executor model for /loop.`)
      return
    }
    const currentSessionId = activeSessionRef.current
    if (currentSessionId && activeRequests[currentSessionId]) {
      showToast('Wait for the current response before starting /loop.')
      return
    }

    loopStartingRef.current = true
    setLoopStarting(true)
    try {
      const sessionId = await ensureSession(goal, selected.id, activeProject!.id)
      const snapshot = await window.api.projectLoop.startWorkspaceGoal({
        requestId: newId(),
        sessionId,
        providerId: selected.id,
        model: model || undefined,
        prompt
      })
      setSessionMessages(sessionId, (current) => [
        ...current,
        {
          id: snapshot.userMessageId,
          role: 'user',
          text: snapshot.goal,
          status: 'done'
        },
        {
          id: snapshot.assistantMessageId,
          role: 'assistant',
          text: '',
          status: snapshot.status === 'running' ? 'streaming' : 'done',
          startedAt: snapshot.createdAt,
          endedAt: snapshot.completedAt,
          meta: {
            provider: snapshot.providerId,
            model: snapshot.model ?? 'default',
            workspaceGoal: {
              bindingId: snapshot.bindingId,
              loopId: snapshot.loopId,
              goal: snapshot.goal,
              status: snapshot.status,
              attempts: snapshot.attempts,
              final: snapshot.final,
              error: snapshot.error
            }
          }
        }
      ])
      clearComposerTurn()
      setIntent('execute')
      onHistoryChange()
      void refreshContext(sessionId)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    } finally {
      loopStartingRef.current = false
      setLoopStarting(false)
    }
  }

  const sendOrQueue = (): void => {
    const loopCommand = isWorkspace ? parseWorkspaceLoopCommand(draft) : { kind: 'none' as const }
    if (loopCommand.kind === 'invalid') {
      showToast(loopCommand.reason)
      return
    }
    if (loopCommand.kind === 'command') {
      void startWorkspaceLoopGoal(draft, loopCommand.goal)
      return
    }
    const turn = makeTurn()
    if (!turn) return
    const sessionId = activeSessionRef.current
    const busy = sessionId ? activeRequests[sessionId] : undefined
    clearComposerTurn()
    if (busy && sessionId) {
      queuedTurnsRef.current[sessionId] = [...(queuedTurnsRef.current[sessionId] ?? []), turn]
      setQueueVersion((version) => version + 1)
      showToast('Follow-up queued', 'success')
      return
    }
    setStartingTurn(turn)
    void executeTurn(turn)
  }

  const cancel = (): void => {
    const requestId = activeSessionRef.current ? activeRequests[activeSessionRef.current] : undefined
    if (requestId) {
      revealGenerationRef.current[requestId] = (revealGenerationRef.current[requestId] ?? 0) + 1
      setStoppingRequests((current) => ({ ...current, [requestId]: true }))
      if (activeSessionRef.current) {
        const sessionId = activeSessionRef.current
        setSessionMessages(sessionId, (items) => items.map((message) => (
          message.role === 'assistant' && message.status === 'streaming'
            ? {
                ...message,
                activities: mergeWorkspaceActivityEvent(
                  message.activities ?? [],
                  {
                    kind: 'status',
                    label: 'Stopping the current task',
                    detail: 'Akorith is interrupting the provider process and preserving the conversation so this task can be resumed.',
                    status: 'running',
                    timestamp: Date.now()
                  }
                )
              }
            : message
        )))
      }
      window.api.chat.cancel(requestId)
      return
    }
    if (startingTurn) {
      cancelledStartingTurnsRef.current.add(startingTurn.id)
      setStartingTurn(null)
    }
  }

  const resumeWorkspaceTask = useCallback((message: ChatMessage): void => {
    const prompt = message.taskPrompt?.trim()
    if (!prompt || !activeProject?.path || !isWorkspace) return
    const originalProvider = providers?.find((provider) => provider.id === message.meta?.provider && provider.available.ok)
    const resumeProvider = originalProvider ?? selected
    if (!resumeProvider?.available.ok) {
      showToast('The provider for this task is unavailable. Select an available model and try again.')
      return
    }
    const turn: QueuedTurn = {
      id: newId(),
      startedAt: Date.now(),
      prompt: `Resume the interrupted workspace task below. Inspect the current files first, keep any valid work already completed, then finish and verify the request.\n\n${prompt}`,
      providerId: resumeProvider.id,
      model: originalProvider
        ? message.meta?.model ?? resumeProvider.models[0] ?? ''
        : model,
      attachments: [],
      intent: message.intent ?? 'execute',
      mode: 'workspace',
      workspace: {
        projectId: activeProject.id,
        projectName: activeProject.name,
        projectPath: activeProject.path
      }
    }
    const sessionId = activeSessionRef.current
    if (sessionId && activeRequests[sessionId]) {
      queuedTurnsRef.current[sessionId] = [...(queuedTurnsRef.current[sessionId] ?? []), turn]
      setQueueVersion((version) => version + 1)
      showToast('Resume queued after the current task', 'success')
      return
    }
    setStartingTurn(turn)
    void executeTurn(turn)
  }, [activeProject, activeRequests, executeTurn, isWorkspace, model, providers, selected])

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

  const renderMessages = useMemo<ChatMessage[]>(() => {
    if (!startingTurn) return messages
    const projectName = startingTurn.workspace?.projectName ?? 'this workspace'
    return [
      ...messages,
      {
        id: `starting-user:${startingTurn.id}`,
        role: 'user',
        text: startingTurn.prompt,
        status: 'done',
        intent: startingTurn.intent
      },
      {
        id: `starting-assistant:${startingTurn.id}`,
        role: 'assistant',
        text: '',
        status: 'streaming',
        taskPrompt: startingTurn.prompt,
        startedAt: startingTurn.startedAt,
        intent: startingTurn.intent,
        activities: startingTurn.mode === 'workspace'
          ? [{
              kind: 'status',
              label: `Preparing ${projectName}`,
              detail: 'Akorith is opening the saved project context and connecting the selected CLI before the first project action is sent.',
              status: 'running',
              timestamp: startingTurn.startedAt
            }]
          : undefined,
        meta: {
          provider: startingTurn.providerId,
          model: startingTurn.model || 'default'
        }
      }
    ]
  }, [messages, startingTurn])
  const hasConversation = renderMessages.length > 0
  const latestWorkspaceContext = useMemo(() => {
    if (!isWorkspace) return null
    let runIndex = -1
    for (let index = renderMessages.length - 1; index >= 0; index -= 1) {
      if (renderMessages[index].role === 'assistant' && renderMessages[index].startedAt && !renderMessages[index].meta?.workspaceGoal) {
        runIndex = index
        break
      }
    }
    if (runIndex < 0) return null
    const run = renderMessages[runIndex]
    let prompt = ''
    for (let index = runIndex - 1; index >= 0; index -= 1) {
      if (renderMessages[index].role === 'user') {
        prompt = renderMessages[index].text
        break
      }
    }
    return { run, prompt }
  }, [isWorkspace, renderMessages])
  const latestWorkspaceRun = latestWorkspaceContext?.run
  const latestWorkspaceActivities = latestWorkspaceRun?.activities
  const latestWorkspacePrompt = latestWorkspaceContext?.prompt ?? ''
  const latestWorkspaceStatus = latestWorkspaceRun?.status
  const liveWorkspaceChanges = latestWorkspaceStatus === 'streaming'
    ? latestWorkspaceRun?.meta?.changes
    : undefined
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
  useEffect(() => {
    if (!isWorkspace || !activeProject || !activeSessionId || !latestWorkspaceRun) {
      onWorkspaceStepsChange?.(null)
      return
    }
    onWorkspaceStepsChange?.({
      projectId: activeProject.id,
      sessionId: activeSessionId,
      prompt: latestWorkspacePrompt,
      steps: latestWorkspaceSteps,
      active: latestWorkspaceStatus === 'streaming',
      failed: latestWorkspaceStatus === 'error',
      updatedAt: latestWorkspaceRun.endedAt ?? latestWorkspaceRun.startedAt ?? Date.now()
    })
  }, [
    activeProject,
    activeSessionId,
    isWorkspace,
    latestWorkspacePrompt,
    latestWorkspaceRun,
    latestWorkspaceStatus,
    latestWorkspaceSteps,
    onWorkspaceStepsChange
  ])
  const busyRequestId = (activeSessionId ? activeRequests[activeSessionId] : undefined) ?? startingTurn?.id
  const isStopping = Boolean(busyRequestId && stoppingRequests[busyRequestId])
  const reviewLiveChanges = useCallback((): void => {
    if (!activeProject || !activeSessionId || !busyRequestId) return
    onWorkspaceToolRequest?.({
      projectId: activeProject.id,
      sessionId: activeSessionId,
      requestId: busyRequestId,
      tool: 'review',
      reason: 'changes'
    })
  }, [activeProject, activeSessionId, busyRequestId, onWorkspaceToolRequest])
  const currentQueue = activeSessionId ? queuedTurnsRef.current[activeSessionId] ?? [] : []
  void queueVersion
  const loopHint = isWorkspace && hasProject ? workspaceLoopHint(draft) : null
  const parsedLoopHint = loopHint === 'armed' ? parseWorkspaceLoopCommand(draft) : null
  const canSubmit = Boolean(draft.trim() && selected?.available.ok && (!isWorkspace || hasProject) && !loopStarting)
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
      {suggestion && <div className="router-suggestion"><div className="router-suggestion-head"><span className={`tier-badge tier-${suggestion.tier}`}>{suggestion.rank} · {suggestion.tier}</span><span className="router-target">→ {suggestion.providerLabel}{suggestion.model ? ` · ${suggestion.model}` : ''}</span></div><div className="router-reason">{suggestion.reason}</div><div className="router-actions"><button type="button" className="router-accept" disabled={!suggestion.available} onClick={acceptSuggestion}>Use model</button><button type="button" className="router-ignore" onClick={() => setSuggestion(null)}>Dismiss</button></div></div>}
      {currentQueue.length > 0 && <div className="composer-queue"><QueueIcon size={14} /><span>{currentQueue.length} follow-up{currentQueue.length === 1 ? '' : 's'} queued</span><button type="button" onClick={() => { queuedTurnsRef.current[activeSessionId!] = []; setQueueVersion((version) => version + 1) }}>Clear</button></div>}
      {toast && (
        <div
          className={`composer-notice is-${toast.tone}`}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
        >
          {toast.message}
        </div>
      )}
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
            {busyRequestId
              ? <ComposerSendButton stop disabled={isStopping} onClick={cancel}><StopIcon size={16} /></ComposerSendButton>
              : <ComposerSendButton disabled={!canSubmit} onClick={sendOrQueue}><SendIcon size={16} /></ComposerSendButton>}
          </div>
        </div>
      </div>
      {loopHint && (
        <div className={`workspace-loop-command-hint is-${loopHint}`} role={loopHint === 'armed' ? 'status' : undefined}>
          {loopHint === 'suggest' ? (
            <button
              type="button"
              onClick={() => {
                updateDraft(insertWorkspaceLoopCommand(draft))
                window.setTimeout(() => composerInputRef.current?.focus(), 0)
              }}
            >
              <code>/loop</code>
              <span>Keep working until the complete project goal is verified.</span>
              <small>Insert</small>
            </button>
          ) : (
            <>
              <code>/loop</code>
              <span>{parsedLoopHint?.kind === 'command'
                ? 'Akorith will keep cycling and withhold the final result until this goal is verified.'
                : parsedLoopHint?.kind === 'invalid'
                  ? parsedLoopHint.reason
                  : 'Add /loop after a concrete project task.'}</span>
            </>
          )}
        </div>
      )}
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
          : <>
              <div
                className="chat-messages"
                ref={scrollRef}
                onScroll={() => {
                  const element = scrollRef.current
                  if (!element) return
                  const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120
                  nearBottomRef.current = nearBottom
                  if (nearBottom) setShowLatestActivity(false)
                }}
              >
                <div className="chat-messages-col" ref={transcriptRef}>
                  <Suspense fallback={<div className="chat-transcript-loading" role="status">Opening conversation...</div>}>
                    {renderMessages.map((message) => (
                      <ChatMessageView
                        key={message.id}
                        message={message}
                        isWorkspace={isWorkspace}
                        active={active}
                        projectName={activeProject?.name}
                        onResume={resumeWorkspaceTask}
                      />
                    ))}
                  </Suspense>
                </div>
                {showLatestActivity && (
                  <button type="button" className="chat-latest-activity" onClick={() => followLatestActivity(true)}>
                    Latest activity
                    <span aria-hidden="true">↓</span>
                  </button>
                )}
              </div>
              <div className="composer-dock">
                {liveWorkspaceChanges?.files.length ? <WorkspaceLiveChangesCard changes={liveWorkspaceChanges} onReview={reviewLiveChanges} /> : null}
                {composer}
              </div>
            </>}
    </main>
  )
}
