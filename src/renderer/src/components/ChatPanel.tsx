import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatUsage, ContextInfo, PermissionDetection, PermissionOption, ProjectRow, ProviderInfo, RouterSuggestion } from '../../../preload/index.d'
import type { AgentStatusMap, ChatMode, HistorySelection } from '../App'
import MacroLoopPanel from './MacroLoopPanel'
import { FolderIcon, PlusIcon, SendIcon, SparkIcon } from './icons'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: 'streaming' | 'done' | 'error'
  meta?: { provider: string; model: string; usage?: ChatUsage }
  /** Phase 13.2: a terminal-output summary card (source = agent label). */
  summary?: { source: string; needsAttention: boolean }
}

// Olympus = Codex (t2), Atlantis = Claude (t1).
const TERMINALS = [
  { id: 't2', label: 'Olympus' },
  { id: 't1', label: 'Atlantis' }
] as const
const AGENT_ROLE: Record<string, string> = { t2: 'Codex', t1: 'Claude' }
// Bounded auto-summary watcher: first look after this long, then poll until the
// terminal output stabilizes or the max wait elapses (agents keep streaming).
const AUTO_SUMMARY_FIRST_DELAY_MS = 3500
const AUTO_SUMMARY_POLL_MS = 2000
const AUTO_SUMMARY_MAX_WAIT_MS = 45_000
// Background permission poll cadence while a project workspace is open.
const PERMISSION_POLL_MS = 4000

interface ChatPanelProps {
  mode: ChatMode
  /** Sidebar instruction: load a session or start a fresh thread. */
  historySel: HistorySelection | null
  activeProject: ProjectRow | null
  /** Background agent status (Codex/Claude) so the header can show readiness. */
  agentStatus: AgentStatusMap
  drawerOpen: boolean
  onToggleDrawer: () => void
  /** Open/Create routed back through the app/sidebar single project flow. */
  onOpenProject: () => void
  onCreateProject: () => void
  /** Notify the app that sessions changed (titles, ordering, creation). */
  onHistoryChange: () => void
  onActiveSession: (sessionId: string | null) => void
}

const AGENT_LABELS: Record<'t1' | 't2', string> = { t1: 'Claude', t2: 'Codex' }

/** Compact readiness summary for the header chip from the two agents' statuses. */
function agentSummary(status: AgentStatusMap): { label: string; tone: 'ready' | 'starting' | 'idle' | 'warn' } {
  const vals = [status.t2, status.t1]
  if (vals.every((v) => !v)) return { label: 'Agents starting…', tone: 'starting' }
  const live = vals.filter((v) => v?.status === 'live').length
  const anyShellFallback = vals.some((v) => v && v.status === 'live' && v.role === 'shell')
  if (live === 2) return { label: anyShellFallback ? 'Agents ready (shell fallback)' : 'Codex & Claude ready', tone: anyShellFallback ? 'warn' : 'ready' }
  if (vals.some((v) => v?.status === 'exited')) return { label: 'An agent exited', tone: 'warn' }
  return { label: 'Agents starting…', tone: 'starting' }
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function usageLine(usage: ChatUsage): string {
  const parts: string[] = []
  if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) {
    parts.push(`${usage.promptTokens ?? '?'}→${usage.completionTokens ?? '?'} tok`)
  }
  if (usage.costUsd !== undefined) {
    parts.push(`$${usage.costUsd.toFixed(4)}`)
  }
  return parts.join(' · ')
}

interface Segment {
  type: 'text' | 'code'
  content: string
  lang?: string
}

/** Split a message into prose and fenced-code segments. */
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

interface SelectionPopover {
  x: number
  y: number
  text: string
}

function storageBoolean(key: string, fallback: boolean): boolean {
  try {
    return localStorage.getItem(key) === null ? fallback : localStorage.getItem(key) === 'true'
  } catch {
    return fallback
  }
}

export default function ChatPanel({
  mode,
  historySel,
  activeProject,
  agentStatus,
  drawerOpen,
  onToggleDrawer,
  onOpenProject,
  onCreateProject,
  onHistoryChange,
  onActiveSession
}: ChatPanelProps): JSX.Element {
  // Everything below is driven by the registry — never a hardcoded backend list.
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [providerId, setProviderId] = useState<string>('')
  const [model, setModel] = useState<string>('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  // Phase 14.2: live memory/context stats for the indicator near the composer.
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Phase 14.1: only auto-scroll to the newest message when the user is already
  // near the bottom — never yank them away while they read older history.
  const nearBottomRef = useRef(true)

  // ---- bridge state: one current target + the persisted auto-Enter setting ----
  const [bridgeTarget, setBridgeTarget] = useState<string>('t1')
  const [autoEnter, setAutoEnter] = useState<boolean | null>(null) // null until loaded
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [sentKey, setSentKey] = useState<string | null>(null)
  const [selection, setSelection] = useState<SelectionPopover | null>(null)
  const [planningCollapsed, setPlanningCollapsed] = useState(() => storageBoolean('akorith.planningToolsCollapsed', true))

  // ---- Phase 6: suggest-only router + opt-in repo context ----
  const [suggestion, setSuggestion] = useState<RouterSuggestion | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [digestEnabled, setDigestEnabled] = useState(false)
  const [summarizingAgent, setSummarizingAgent] = useState(false)
  // Phase 14.1: a detected terminal permission/confirmation prompt, surfaced as
  // an actionable card so the user never has to open the Activity drawer.
  const [pendingPermission, setPendingPermission] = useState<{ detection: PermissionDetection; terminalId: string } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()
  const sentTimer = useRef<ReturnType<typeof setTimeout>>()
  const autoSummaryTimer = useRef<ReturnType<typeof setTimeout>>()
  // Monotonic token so a newer send/auto-summary watcher cancels an older one.
  const summaryWatch = useRef(0)
  // Once answered/dismissed, don't immediately re-surface the same prompt.
  const dismissedPermSig = useRef<string | null>(null)
  // Dedup: skip re-summarizing unchanged terminal output (no summary spam).
  const lastSummarySig = useRef<string | null>(null)
  const isWorkspace = mode === 'workspace'
  const hasProject = isWorkspace && Boolean(activeProject?.path)

  const loadProviders = useCallback(async (): Promise<void> => {
    setLoadError(null)
    try {
      const list = await window.api.chat.listProviders()
      setProviders(list)
      // Keep the current selection when still valid; else pick the first available.
      setProviderId((current) => {
        if (list.some((p) => p.id === current && p.available.ok)) return current
        return list.find((p) => p.available.ok)?.id ?? ''
      })
    } catch (err) {
      setProviders([])
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void loadProviders()
    void window.api.bridge.getSettings().then((s) => setAutoEnter(s.autoEnter))
    void window.api.digest.getSettings().then((s) => setDigestEnabled(s.enabled))
    return () => {
      clearTimeout(toastTimer.current)
      clearTimeout(sentTimer.current)
      clearTimeout(autoSummaryTimer.current)
    }
  }, [loadProviders])

  useEffect(() => {
    localStorage.setItem('akorith.planningToolsCollapsed', String(planningCollapsed))
  }, [planningCollapsed])

  // Read-only memory stats for the composer indicator (no model call). Each
  // session is independent, so this only ever reflects the active session.
  const refreshContextInfo = useCallback(async (sessionId: string | null): Promise<void> => {
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

  // Sidebar instructions: load a stored session, or start a fresh thread.
  useEffect(() => {
    if (!historySel || historySel.mode !== mode) return
    // A fresh session/thread always opens scrolled to the bottom.
    nearBottomRef.current = true
    setConfirmingClear(false)
    if (historySel.sessionId === null) {
      // New Chat / fresh thread: no old memory, truly empty session.
      setMessages([])
      setActiveSessionId(null)
      onActiveSession(null)
      setContextInfo(null)
      if (historySel.providerId) setProviderId(historySel.providerId)
      return
    }
    void (async () => {
      const data = await window.api.history.messages(historySel.sessionId!)
      if (!data) return
      setMessages(
        data.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.content,
          status: 'done' as const,
          meta:
            m.role === 'assistant'
              ? { provider: m.providerId, model: m.model ?? 'default' }
              : undefined
        }))
      )
      setActiveSessionId(data.session.id)
      onActiveSession(data.session.id)
      setProviderId(data.session.providerId)
      // Restore the REAL memory state, not just the UI transcript.
      void refreshContextInfo(data.session.id)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historySel?.nonce, mode])

  const selected = providers?.find((p) => p.id === providerId)

  // Default the model whenever the selected provider (or its model list) changes.
  useEffect(() => {
    setModel((current) =>
      selected && selected.models.includes(current) ? current : (selected?.models[0] ?? '')
    )
  }, [selected])

  useEffect(() => {
    const el = scrollRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // Track whether the user is parked near the bottom of the conversation.
  const handleMessagesScroll = (): void => {
    const el = scrollRef.current
    if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    setSelection(null)
  }

  const showToast = (kind: 'ok' | 'error', text: string): void => {
    setToast({ kind, text })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2500)
  }

  // The single renderer-side entry to the bridge. All three send modes (code
  // block, whole message, selection) call this; main funnels it into
  // PtyManager.write(). The Phase 9 macro-loop uses the same main-side path.
  const sendToTerminal = async (text: string, sourceKey: string): Promise<void> => {
    if (autoEnter === null) return // settings not loaded yet
    const label = TERMINALS.find((t) => t.id === bridgeTarget)?.label ?? bridgeTarget
    const res = await window.api.bridge.send({ text, targetTerminalId: bridgeTarget, autoEnter })
    if (res.ok) {
      setSentKey(sourceKey)
      clearTimeout(sentTimer.current)
      sentTimer.current = setTimeout(() => setSentKey(null), 1500)
      showToast('ok', `Sent to ${label}${autoEnter ? ' (running)' : ''}`)
      // Phase 13.2: after a bounded delay, read what the agent did and summarize
      // it back into chat (once, deduped). Manual button also available.
      scheduleAutoSummary(bridgeTarget, text)
    } else {
      showToast('error', res.error)
    }
  }

  /** Render an ExecutorSummary into a compact, readable chat card body. */
  const formatAgentSummary = (
    summary: import('../../../preload/index.d').ExecutorSummary,
    detection: import('../../../preload/index.d').PermissionDetection
  ): string => {
    const lines: string[] = [summary.currentStatus]
    if (summary.changedFiles.length) lines.push(`Files changed: ${summary.changedFiles.slice(0, 8).join(', ')}`)
    if (summary.commandsRun.length) lines.push(`Commands: ${summary.commandsRun.slice(0, 6).join(' · ')}`)
    if (summary.testsRun) lines.push(`Tests: ${summary.testsRun}`)
    if (summary.failures.length) lines.push(`Failures: ${summary.failures.slice(0, 3).join(' | ')}`)
    lines.push(`Recommended next step: ${summary.likelyNextStep}`)
    if (detection.detected) lines.push(`⚠ A permission prompt is waiting — ${detection.rationale} Open the activity drawer to review.`)
    lines.push('How would you like to continue?')
    return lines.join('\n')
  }

  /**
   * Summarize a target terminal's recent output into a chat-visible assistant
   * card. Meta call → never writes a usage_event. `auto` runs silently after a
   * send; the manual button surfaces the "no meaningful output" state.
   */
  const runAgentSummary = async (terminalId: string, opts: { auto: boolean; lastPrompt?: string }): Promise<void> => {
    if (!selected?.available.ok) {
      if (!opts.auto) showToast('error', 'Select an available provider to summarize agent output.')
      return
    }
    setSummarizingAgent(true)
    try {
      const res = await window.api.agent.summarize({
        terminalId,
        providerId: selected.id,
        model: model || undefined,
        goal: hasProject && activeProject ? `Work in ${activeProject.name}` : undefined,
        lastPrompt: opts.lastPrompt,
        // Phase 14.2: fold the summary into THIS session's memory so later
        // follow-ups in the same chat can reference what the agent did.
        sessionId: activeSessionId ?? undefined
      })
      const label = TERMINALS.find((t) => t.id === terminalId)?.label ?? terminalId
      const source = `${label} / ${AGENT_ROLE[terminalId] ?? 'Agent'}`
      if (res.ok) {
        if (opts.auto && res.signature === lastSummarySig.current) return // unchanged → no spam
        lastSummarySig.current = res.signature
        setMessages((prev) => [
          ...prev,
          {
            id: newId(),
            role: 'assistant',
            status: 'done',
            text: formatAgentSummary(res.summary, res.detection),
            summary: { source, needsAttention: res.summary.needsUserAttention || res.detection.detected }
          }
        ])
        if (res.persisted) void refreshContextInfo(activeSessionId) // summary now in session memory
      } else if (!opts.auto) {
        showToast('error', `${source}: ${res.error}`)
      }
    } finally {
      setSummarizingAgent(false)
    }
  }

  const permSig = (terminalId: string, d: PermissionDetection): string =>
    `${terminalId}:${d.question ?? ''}:${d.matchedText ?? ''}`

  /** Read-only check for a pending permission prompt; surfaces the card if new. */
  const checkPermission = useCallback(
    async (terminalId: string): Promise<boolean> => {
      try {
        const res = await window.api.agent.detectPermission(terminalId)
        if (!res.ok || !res.detection.detected) {
          // The prompt is gone — clear any stale card for this terminal.
          setPendingPermission((cur) => (cur && cur.terminalId === terminalId ? null : cur))
          return false
        }
        const sig = permSig(terminalId, res.detection)
        if (sig === dismissedPermSig.current) return false
        setPendingPermission({ detection: res.detection, terminalId })
        return true
      } catch {
        return false
      }
    },
    []
  )

  /**
   * Phase 14.1: after sending to an agent, watch the target terminal until its
   * output stabilizes (or a permission prompt appears, or a bounded deadline),
   * then summarize once. More reliable than a single fixed delay — Claude/Codex
   * often keep streaming for a while after the prompt is accepted.
   */
  const scheduleAutoSummary = (terminalId: string, lastPrompt: string): void => {
    clearTimeout(autoSummaryTimer.current)
    const token = ++summaryWatch.current
    const deadline = Date.now() + AUTO_SUMMARY_MAX_WAIT_MS
    let lastLen = -1
    let stable = 0
    const tick = async (): Promise<void> => {
      if (token !== summaryWatch.current) return // superseded by a newer send
      // Surface a permission prompt as soon as we see one (and keep watching).
      const hasPrompt = await checkPermission(terminalId)
      let len = lastLen
      try {
        const snap = await window.api.pty.snapshot(terminalId, 8000)
        len = snap.chars
      } catch {
        /* keep previous length */
      }
      if (len === lastLen) stable += 1
      else {
        stable = 0
        lastLen = len
      }
      const settled = stable >= 2 || Date.now() > deadline
      if (settled && !hasPrompt) {
        if (token === summaryWatch.current) void runAgentSummary(terminalId, { auto: true, lastPrompt })
        return
      }
      autoSummaryTimer.current = setTimeout(() => void tick(), AUTO_SUMMARY_POLL_MS)
    }
    autoSummaryTimer.current = setTimeout(() => void tick(), AUTO_SUMMARY_FIRST_DELAY_MS)
  }

  /** Answer a detected permission prompt via the single bridge write path. */
  const answerPermission = async (option: PermissionOption): Promise<void> => {
    const pending = pendingPermission
    if (!pending) return
    dismissedPermSig.current = permSig(pending.terminalId, pending.detection)
    setPendingPermission(null)
    const label = TERMINALS.find((t) => t.id === pending.terminalId)?.label ?? pending.terminalId
    // Permanent "always allow" is surfaced but never sent automatically; here the
    // user explicitly chose it, which is allowed, but we still gate on the click.
    const res = await window.api.bridge.send({ text: option.value, targetTerminalId: pending.terminalId, autoEnter: true })
    if (res.ok) {
      showToast('ok', `Answered ${label}: ${option.label}`)
      // Let the agent react, then summarize the result back into chat.
      scheduleAutoSummary(pending.terminalId, `Answered permission prompt: ${option.label}`)
    } else {
      showToast('error', res.error)
    }
  }

  const dismissPermission = (): void => {
    if (pendingPermission) dismissedPermSig.current = permSig(pendingPermission.terminalId, pendingPermission.detection)
    setPendingPermission(null)
  }

  // Background permission poll: while a project workspace is open, watch the
  // current target terminal for a confirmation prompt so the user can answer it
  // from chat. Read-only (agent:detectPermission) — never writes anything.
  useEffect(() => {
    if (!hasProject) {
      setPendingPermission(null)
      return
    }
    let cancelled = false
    const id = setInterval(() => {
      if (!cancelled) void checkPermission(bridgeTarget)
    }, PERMISSION_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [hasProject, bridgeTarget, checkPermission])

  // Switching project clears any stale permission card and lets prompts re-show.
  useEffect(() => {
    setPendingPermission(null)
    dismissedPermSig.current = null
  }, [activeProject?.id])

  const toggleAutoEnter = async (): Promise<void> => {
    const next = !(autoEnter ?? false)
    const settings = await window.api.bridge.setAutoEnter(next)
    setAutoEnter(settings.autoEnter)
  }

  const toggleDigest = async (): Promise<void> => {
    const settings = await window.api.digest.setEnabled(!digestEnabled)
    setDigestEnabled(settings.enabled)
  }

  // On-demand only (never per keystroke). The classifier runs locally in main;
  // accepting just switches the visible selectors — nothing is sent or changed
  // automatically.
  const suggestTask = async (): Promise<void> => {
    const prompt = draft.trim()
    if (!prompt || suggesting) return
    setSuggesting(true)
    setSuggestion(null)
    try {
      const res = await window.api.router.suggest(prompt)
      if (res.ok) setSuggestion(res.suggestion)
      else showToast('error', res.error)
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : String(err))
    } finally {
      setSuggesting(false)
    }
  }

  const acceptSuggestion = (): void => {
    if (!suggestion) return
    // Switch the user's own selectors to the suggestion for this send. The send
    // still goes through the normal chat:send path with these values.
    if (suggestion.providerId !== providerId && (activeSessionId || messages.length > 0)) {
      setMessages([])
      setActiveSessionId(null)
      onActiveSession(null)
      setContextInfo(null)
    }
    setProviderId(suggestion.providerId)
    setModel(suggestion.model ?? '')
    setSuggestion(null)
  }

  const handleSelectionMouseUp = (): void => {
    // Defer so the browser settles the selection first.
    setTimeout(() => {
      const sel = window.getSelection()
      const container = scrollRef.current
      if (!sel || sel.isCollapsed || !container || !container.contains(sel.anchorNode)) {
        setSelection(null)
        return
      }
      const text = sel.toString().trim()
      if (!text) {
        setSelection(null)
        return
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      setSelection({ x: rect.left + rect.width / 2, y: rect.top, text })
    }, 0)
  }

  const patchMessage = (id: string, patch: Partial<ChatMessage> | ((m: ChatMessage) => ChatMessage)): void => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? (typeof patch === 'function' ? patch(m) : { ...m, ...patch }) : m))
    )
  }

  const sendPrompt = async (): Promise<void> => {
    const prompt = draft.trim()
    if (!prompt || busyRequestId || !selected?.available.ok) return

    // A session belongs to one provider: create it on the first message.
    let sessionId = activeSessionId
    if (!sessionId) {
      try {
        const session = await window.api.history.create(selected.id, prompt.slice(0, 80), hasProject ? activeProject?.id ?? null : null)
        sessionId = session.id
        setActiveSessionId(session.id)
        onActiveSession(session.id)
        onHistoryChange()
      } catch {
        sessionId = null // persistence trouble must not block the chat
      }
    }

    const requestId = newId()
    const assistantId = newId()
    setDraft('')
    setBusyRequestId(requestId)
    setMessages((prev) => [
      ...prev,
      { id: newId(), role: 'user', text: prompt, status: 'done' },
      {
        id: assistantId,
        role: 'assistant',
        text: '',
        status: 'streaming',
        meta: { provider: selected.label, model: model || 'default' }
      }
    ])

    const offToken = window.api.chat.onToken(requestId, (token) => {
      patchMessage(assistantId, (m) => ({ ...m, text: m.text + token }))
    })
    try {
      const response = await window.api.chat.send({
        requestId,
        providerId: selected.id,
        model: model || undefined,
        prompt,
        sessionId: sessionId ?? undefined,
        includeDigest: hasProject
      })
      if (response.ok) {
        patchMessage(assistantId, {
          text: response.result.text,
          status: 'done',
          meta: { provider: selected.label, model: response.result.model, usage: response.result.usage }
        })
      } else {
        patchMessage(assistantId, (m) => ({
          ...m,
          status: 'error',
          text: m.text || `Error: ${response.error}`
        }))
      }
    } catch (err) {
      patchMessage(assistantId, {
        status: 'error',
        text: `Error: ${err instanceof Error ? err.message : String(err)}`
      })
    } finally {
      offToken()
      setBusyRequestId(null)
      onHistoryChange() // updated_at moved this session up the sidebar
      void refreshContextInfo(sessionId) // memory indicator now includes this turn
    }
  }

  const cancel = (): void => {
    if (busyRequestId) window.api.chat.cancel(busyRequestId)
  }

  // Reset context for the ACTIVE session only (clears its messages + summary).
  // Two-click confirm so it isn't destructive by accident; never touches other chats.
  const clearContext = async (): Promise<void> => {
    if (!activeSessionId || busyRequestId) return
    if (!confirmingClear) {
      setConfirmingClear(true)
      setTimeout(() => setConfirmingClear(false), 3000)
      return
    }
    setConfirmingClear(false)
    try {
      await window.api.history.clearMessages(activeSessionId)
      setMessages([])
      lastSummarySig.current = null
      await refreshContextInfo(activeSessionId)
      onHistoryChange()
      showToast('ok', 'Context reset for this chat')
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : String(err))
    }
  }

  const canSend = Boolean(draft.trim()) && !busyRequestId && Boolean(selected?.available.ok)

  const bridgeLabel = TERMINALS.find((t) => t.id === bridgeTarget)?.label ?? bridgeTarget
  const lastUsage = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'assistant' && m.meta?.usage)?.meta?.usage,
    [messages]
  )
  const composerInfo = [
    isWorkspace ? `workspace ${activeProject?.name ?? 'no project'}` : 'general chat',
    selected?.label ?? 'No provider',
    model || 'default',
    lastUsage ? usageLine(lastUsage) : null,
    hasProject ? `repo context ${digestEnabled ? 'on' : 'off'}` : null,
    hasProject ? `target ${bridgeLabel}` : null
  ].filter((item): item is string => Boolean(item))

  const bridgeButton = (text: string, key: string, title: string): JSX.Element => (
    <button
      type="button"
      className={`bridge-button ${sentKey === key ? 'is-sent' : ''}`}
      title={title}
      onClick={() => void sendToTerminal(text, key)}
    >
      {sentKey === key ? 'Sent' : `Send to ${bridgeLabel}`}
    </button>
  )

  const hasConversation = messages.length > 0
  const summary = agentSummary(agentStatus)

  // Phase 14.2 memory indicator + reset control, shown near the composer so it is
  // obvious the model receives this session's prior turns (a trust surface).
  const ctxCount = contextInfo?.totalMessages ?? 0
  const memoryLabel = ((): string => {
    if (ctxCount > 0) {
      const bits = [`Memory: ${ctxCount} msg${ctxCount === 1 ? '' : 's'}`]
      if (contextInfo?.hasSummary) bits.push(`summarized ${contextInfo.summarizedCount}`)
      if (hasProject && digestEnabled) bits.push('Repo on')
      return bits.join(' · ')
    }
    return hasProject ? 'Session memory on' : 'New chat — memory on'
  })()
  const memoryTooltip =
    contextInfo && contextInfo.totalMessages > 0
      ? `This chat remembers its previous messages. ${contextInfo.includedVerbatim} recent message(s) are sent in full` +
        (contextInfo.hasSummary ? `, and ${contextInfo.summarizedCount} older message(s) are compressed into a summary` : '') +
        ` (~${contextInfo.approxTokens} tokens of context).`
      : 'The model will see this session’s previous messages as you continue the conversation.'
  const memoryBar = (
    <div className="context-bar">
      <span className="context-chip" title={memoryTooltip}>
        <span className="context-dot" />
        {memoryLabel}
      </span>
      {activeSessionId && hasConversation && (
        <button
          type="button"
          className={`context-clear ${confirmingClear ? 'is-confirm' : ''}`}
          onClick={() => void clearContext()}
          disabled={Boolean(busyRequestId)}
          title="Clear this chat's memory (only this session). Click again to confirm."
        >
          {confirmingClear ? 'Reset context?' : 'Reset context'}
        </button>
      )}
    </div>
  )

  // The composer is the central work control, reused in the empty-state hero and
  // (when a conversation exists) docked at the bottom. Macro-loop mode/status live
  // inside it via the compact MacroLoopPanel above the input.
  const permissionCard = pendingPermission && (() => {
    const { detection, terminalId } = pendingPermission
    const label = TERMINALS.find((t) => t.id === terminalId)?.label ?? terminalId
    const role = AGENT_ROLE[terminalId] ?? 'Agent'
    const options: PermissionOption[] =
      detection.options && detection.options.length > 0
        ? detection.options
        : detection.suggestedAction
          ? [{ value: detection.suggestedAction, label: 'Yes once', tone: 'affirm' }]
          : [{ value: 'y', label: 'Yes once', tone: 'affirm' }, { value: 'n', label: 'No', tone: 'deny' }]
    return (
      <div className={`permission-card risk-${detection.riskLevel}`}>
        <div className="permission-head">
          <span className="permission-source">
            {label} / {role}
          </span>
          <span className="permission-tag">waiting for your answer</span>
          {detection.riskLevel !== 'low' && <span className="permission-risk">{detection.riskLevel} risk</span>}
        </div>
        <div className="permission-question">{detection.question || detection.matchedText || 'The agent is asking for confirmation in the terminal.'}</div>
        <div className="permission-actions">
          {options.map((opt, i) => (
            <button
              key={`${opt.value}-${i}`}
              type="button"
              className={`permission-btn tone-${opt.tone} ${opt.permanent ? 'is-permanent' : ''}`}
              title={opt.permanent ? 'Permanent “always allow” — sent only because you chose it explicitly.' : `Send “${opt.label}” to ${label}`}
              onClick={() => void answerPermission(opt)}
            >
              {opt.label}
            </button>
          ))}
          <button type="button" className="permission-btn tone-neutral" onClick={onToggleDrawer}>
            Open Activity
          </button>
          <button type="button" className="permission-dismiss" onClick={dismissPermission} title="Hide — answer later in the terminal">
            Dismiss
          </button>
        </div>
        {detection.requiresUserReview && (
          <div className="permission-note">Akorith will not auto-answer this — review the choices above.</div>
        )}
      </div>
    )
  })()

  const composer = (
    <div className="composer">
      {permissionCard}
      {suggestion && (
        <div className="router-suggestion">
          <div className="router-suggestion-head">
            <span className={`tier-badge tier-${suggestion.tier}`}>
              {suggestion.rank} · {suggestion.tier}
            </span>
            {suggestion.classifiedBy === 'heuristic' && <span className="tier-heuristic">heuristic</span>}
            <span className="router-target">
              → {suggestion.providerLabel}
              {suggestion.model ? ` · ${suggestion.model}` : ''}
            </span>
            {!suggestion.available && <span className="router-unavailable">unavailable</span>}
          </div>
          <div className="router-reason">{suggestion.reason}</div>
          {suggestion.warning && <div className="router-warning">⚠ {suggestion.warning}</div>}
          <div className="router-actions">
            <button type="button" className="router-accept" disabled={!suggestion.available} onClick={acceptSuggestion}>
              Accept
            </button>
            <button type="button" className="router-ignore" onClick={() => setSuggestion(null)}>
              Ignore
            </button>
          </div>
        </div>
      )}
      {hasProject && activeProject && (
        <MacroLoopPanel
          providers={providers}
          defaultProviderId={providerId}
          defaultModel={model}
          defaultTargetTerminal={bridgeTarget}
          activeProject={activeProject}
          collapsed={planningCollapsed}
          onToggleCollapsed={() => setPlanningCollapsed((value) => !value)}
        />
      )}
      <div className="composer-box">
        <textarea
          className="composer-input"
          placeholder={
            !selected?.available.ok
              ? 'Select an available provider to start…'
              : hasProject
                ? `Describe a task for ${activeProject!.name}…  (Enter to send · Shift+Enter for newline)`
                : isWorkspace
                  ? 'Open a project to start the workspace…'
                  : 'Ask a model directly…  (Enter to send · Shift+Enter for newline)'
          }
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void sendPrompt()
            }
          }}
          rows={3}
          spellCheck={false}
        />
        <div className="composer-controls">
          <div className="composer-controls-left">
            {hasProject && (
              <div className="route-seg" role="group" aria-label="Target agent">
                {TERMINALS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={bridgeTarget === t.id ? 'is-active' : ''}
                    onClick={() => setBridgeTarget(t.id)}
                    title={`Bridge sends go to ${t.label} (${t.id === 't2' ? 'Codex' : 'Claude'})`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
            {hasProject && (
              <label className="composer-chip" title="Prepend a bounded git digest of the repo to what the provider sees.">
                <input type="checkbox" checked={digestEnabled} onChange={() => void toggleDigest()} />
                Repo
              </label>
            )}
            {hasProject && (
              <label className="composer-chip" title="ON: sent text runs immediately. OFF: waits at the prompt for Enter.">
                <input type="checkbox" checked={autoEnter ?? false} disabled={autoEnter === null} onChange={() => void toggleAutoEnter()} />
                Auto-Enter
              </label>
            )}
            <button type="button" className="composer-chip" disabled={!draft.trim() || suggesting} onClick={() => void suggestTask()}>
              {suggesting ? 'Classifying…' : '✦ Suggest'}
            </button>
            {hasProject && (
              <button
                type="button"
                className="composer-chip"
                disabled={summarizingAgent}
                onClick={() => void runAgentSummary(bridgeTarget, { auto: false })}
                title={`Read ${TERMINALS.find((t) => t.id === bridgeTarget)?.label}'s recent terminal output and summarize it into chat`}
              >
                {summarizingAgent ? 'Reading…' : 'Summarize output'}
              </button>
            )}
            {hasProject && (
              <button type="button" className="composer-chip" onClick={onToggleDrawer}>
                {drawerOpen ? 'Hide agents' : 'Show agents'}
              </button>
            )}
          </div>
          {busyRequestId ? (
            <button type="button" className="send-button" onClick={cancel}>
              Stop
            </button>
          ) : (
            <button type="button" className="send-button" disabled={!canSend} onClick={() => void sendPrompt()}>
              <SendIcon size={14} />
              Send
            </button>
          )}
        </div>
      </div>
      {memoryBar}
      <div className="composer-info">{composerInfo.join(' · ')}</div>
    </div>
  )

  return (
    <main className="chat-panel">
      <header className="ws-topbar">
        <div className="ws-topbar-left">
          <span className="ws-title">{isWorkspace ? activeProject?.name ?? 'Workspace' : 'General chat'}</span>
          <span className="ws-scope-pill">{isWorkspace ? 'Project workspace' : 'Model chat'}</span>
          {hasProject && (
            <button
              type="button"
              className={`agent-status agent-${summary.tone}`}
              onClick={onToggleDrawer}
              title="Open the agent activity drawer"
            >
              <span className="agent-status-dot" />
              {summary.label}
            </button>
          )}
        </div>
        <div className="ws-topbar-right">
          <div className={`model-switcher ${!selected?.available.ok ? 'is-unavailable' : ''}`} title="Provider and model for this chat">
            <span className="model-switcher-label">Model</span>
            <select
              className="model-select is-provider"
              value={providerId}
              onChange={(event) => {
                const next = event.target.value
                if (next !== providerId && (activeSessionId || messages.length > 0)) {
                  setMessages([])
                  setActiveSessionId(null)
                  onActiveSession(null)
                  setContextInfo(null)
                }
                setProviderId(next)
              }}
              aria-label="Provider"
              disabled={!providers?.length}
            >
              {!providers?.length && <option value="">No providers</option>}
              {providers?.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available.ok}>
                  {p.available.ok ? p.label : `${p.label} — unavailable`}
                </option>
              ))}
            </select>
            {selected && selected.models.length > 0 && (
              <select className="model-select" value={model} onChange={(event) => setModel(event.target.value)} aria-label="Model">
                {selected.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
          </div>
          <button type="button" className="icon-button" title="Refresh providers" onClick={() => void loadProviders()}>
            ↻
          </button>
          {hasProject && (
            <button
              type="button"
              className={`activity-button ${drawerOpen ? 'is-active' : ''}`}
              onClick={onToggleDrawer}
              title="Show agent terminals"
            >
              <SparkIcon size={14} />
              Activity
            </button>
          )}
        </div>
      </header>

      {isWorkspace && !hasProject ? (
        <div className="ws-hero">
          <div className="ws-hero-inner">
            <h1 className="ws-hero-title">What should we work on?</h1>
            <p className="ws-hero-sub">Open or create a project from the sidebar to start Codex and Claude.</p>
            <div className="ws-hero-actions">
              <button type="button" className="ws-hero-btn is-primary" onClick={onOpenProject}>
                <FolderIcon size={16} />
                Open Project
              </button>
              <button type="button" className="ws-hero-btn" onClick={onCreateProject}>
                <PlusIcon size={16} />
                Create Project
              </button>
            </div>
            {activeProject && !activeProject.path && (
              <div className="ws-hero-note">Selected “{activeProject.name}” has no folder yet — open one to start agents.</div>
            )}
          </div>
        </div>
      ) : !hasConversation ? (
        <div className="ws-hero">
          <div className="ws-hero-inner is-wide">
            <h1 className="ws-hero-title">{hasProject ? `What should we build in ${activeProject!.name}?` : 'Ask a model directly'}</h1>
            <p className="ws-hero-sub">
              {hasProject ? 'Type a task — Akorith plans it and drives Codex and Claude for you.' : 'General chats are separate from project workspaces and do not use project context.'}
            </p>
            {composer}
            {selected && !selected.available.ok && (
              <div className="chat-notice">
                {selected.label} unavailable{selected.available.reason ? `: ${selected.available.reason}` : ''}
              </div>
            )}
            {loadError && <div className="chat-notice">Failed to load providers: {loadError}</div>}
          </div>
        </div>
      ) : (
        <>
          <div className="chat-messages" ref={scrollRef} onMouseUp={handleSelectionMouseUp} onScroll={handleMessagesScroll}>
            <div className="chat-messages-col">
              {messages.map((m) => (
                <div key={m.id} className={`chat-msg ${m.role} ${m.status} ${m.summary ? 'is-summary' : ''}`}>
                  {m.summary && (
                    <div className={`agent-summary-head ${m.summary.needsAttention ? 'needs-attention' : ''}`}>
                      <SparkIcon size={13} />
                      <span>{m.summary.source}</span>
                      <em>agent output summary</em>
                    </div>
                  )}
                  {m.role === 'assistant' && m.status !== 'streaming' ? (
                    <div className="chat-msg-text">
                      {splitFences(m.text).map((seg, i) =>
                        seg.type === 'code' ? (
                          <div className="chat-code" key={i}>
                            <div className="chat-code-header">
                              <span>{seg.lang ?? 'code'}</span>
                              {hasProject && m.status === 'done' &&
                                bridgeButton(seg.content, `${m.id}-block-${i}`, 'Send this code block to the target terminal')}
                            </div>
                            <pre>{seg.content}</pre>
                          </div>
                        ) : (
                          <span key={i}>{seg.content}</span>
                        )
                      )}
                    </div>
                  ) : (
                    <div className="chat-msg-text">{m.text || (m.status === 'streaming' ? '…' : '')}</div>
                  )}
                  {m.role === 'assistant' && m.status === 'done' && !m.summary && (
                    <div className="chat-msg-meta">
                      {m.meta && (
                        <span>
                          {m.meta.provider} · {m.meta.model}
                          {m.meta.usage && usageLine(m.meta.usage) ? ` · ${usageLine(m.meta.usage)}` : ''}
                          {m.meta.usage?.estimated && <span className="chat-estimated">≈ estimated</span>}
                        </span>
                      )}
                      {hasProject && bridgeButton(m.text, `${m.id}-all`, 'Send the whole message to the target terminal')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {selection && (
            <button
              type="button"
              className="selection-popover"
              style={{ left: selection.x, top: selection.y - 34 }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                void sendToTerminal(selection.text, 'selection')
                setSelection(null)
                window.getSelection()?.removeAllRanges()
              }}
            >
              Send selection →
            </button>
          )}

          <div className="composer-dock">{composer}</div>
        </>
      )}

      {toast && <div className={`bridge-toast ${toast.kind}`}>{toast.text}</div>}
    </main>
  )
}
