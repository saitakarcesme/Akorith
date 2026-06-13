import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatUsage, ProjectRow, ProviderInfo, RouterSuggestion } from '../../../preload/index.d'
import type { AgentStatusMap, HistorySelection } from '../App'
import MacroLoopPanel from './MacroLoopPanel'
import { FolderIcon, PlusIcon, SendIcon, SparkIcon } from './icons'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: 'streaming' | 'done' | 'error'
  meta?: { provider: string; model: string; usage?: ChatUsage }
}

// Matches the panes mounted in TerminalColumn.
const TERMINALS = [
  { id: 't2', label: 'Olympus' },
  { id: 't1', label: 'Atlantis' }
] as const

interface ChatPanelProps {
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
  const scrollRef = useRef<HTMLDivElement>(null)

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
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()
  const sentTimer = useRef<ReturnType<typeof setTimeout>>()

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
    }
  }, [loadProviders])

  useEffect(() => {
    localStorage.setItem('akorith.planningToolsCollapsed', String(planningCollapsed))
  }, [planningCollapsed])

  // Sidebar instructions: load a stored session, or start a fresh thread.
  useEffect(() => {
    if (!historySel) return
    if (historySel.sessionId === null) {
      setMessages([])
      setActiveSessionId(null)
      onActiveSession(null)
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
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historySel?.nonce])

  const selected = providers?.find((p) => p.id === providerId)

  // Default the model whenever the selected provider (or its model list) changes.
  useEffect(() => {
    setModel((current) =>
      selected && selected.models.includes(current) ? current : (selected?.models[0] ?? '')
    )
  }, [selected])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

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
    } else {
      showToast('error', res.error)
    }
  }

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
        const session = await window.api.history.create(selected.id, prompt.slice(0, 80), activeProject?.id ?? null)
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
        sessionId: sessionId ?? undefined
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
    }
  }

  const cancel = (): void => {
    if (busyRequestId) window.api.chat.cancel(busyRequestId)
  }

  const canSend = Boolean(draft.trim()) && !busyRequestId && Boolean(selected?.available.ok)

  const bridgeLabel = TERMINALS.find((t) => t.id === bridgeTarget)?.label ?? bridgeTarget
  const lastUsage = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'assistant' && m.meta?.usage)?.meta?.usage,
    [messages]
  )
  const composerInfo = [
    selected?.label ?? 'No provider',
    model || 'default',
    lastUsage ? usageLine(lastUsage) : null,
    `repo context ${digestEnabled ? 'on' : 'off'}`,
    `target ${bridgeLabel}`
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

  const hasProject = Boolean(activeProject?.path)
  const hasConversation = messages.length > 0
  const summary = agentSummary(agentStatus)

  // The composer is the central work control, reused in the empty-state hero and
  // (when a conversation exists) docked at the bottom. Macro-loop mode/status live
  // inside it via the compact MacroLoopPanel above the input.
  const composer = (
    <div className="composer">
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
      {hasProject && (
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
                : 'Describe what you want to build…  (Enter to send · Shift+Enter for newline)'
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
            <label className="composer-chip" title="Prepend a bounded git digest of the repo to what the provider sees.">
              <input type="checkbox" checked={digestEnabled} onChange={() => void toggleDigest()} />
              Repo
            </label>
            <label className="composer-chip" title="ON: sent text runs immediately. OFF: waits at the prompt for Enter.">
              <input type="checkbox" checked={autoEnter ?? false} disabled={autoEnter === null} onChange={() => void toggleAutoEnter()} />
              Auto-Enter
            </label>
            <button type="button" className="composer-chip" disabled={!draft.trim() || suggesting} onClick={() => void suggestTask()}>
              {suggesting ? 'Classifying…' : '✦ Suggest'}
            </button>
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
      <div className="composer-info">{composerInfo.join(' · ')}</div>
    </div>
  )

  return (
    <main className="chat-panel">
      <header className="ws-topbar">
        <div className="ws-topbar-left">
          <span className="ws-title">{activeProject ? activeProject.name : 'Workspace'}</span>
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
          <select
            className="model-select"
            value={providerId}
            onChange={(event) => {
              const next = event.target.value
              if (next !== providerId && (activeSessionId || messages.length > 0)) {
                setMessages([])
                setActiveSessionId(null)
                onActiveSession(null)
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

      {!hasProject ? (
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
            <h1 className="ws-hero-title">What should we build in {activeProject!.name}?</h1>
            <p className="ws-hero-sub">Type a task — Akorith plans it and drives Codex and Claude for you.</p>
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
          <div className="chat-messages" ref={scrollRef} onMouseUp={handleSelectionMouseUp} onScroll={() => setSelection(null)}>
            <div className="chat-messages-col">
              {messages.map((m) => (
                <div key={m.id} className={`chat-msg ${m.role} ${m.status}`}>
                  {m.role === 'assistant' && m.status !== 'streaming' ? (
                    <div className="chat-msg-text">
                      {splitFences(m.text).map((seg, i) =>
                        seg.type === 'code' ? (
                          <div className="chat-code" key={i}>
                            <div className="chat-code-header">
                              <span>{seg.lang ?? 'code'}</span>
                              {m.status === 'done' &&
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
                  {m.role === 'assistant' && m.status === 'done' && (
                    <div className="chat-msg-meta">
                      {m.meta && (
                        <span>
                          {m.meta.provider} · {m.meta.model}
                          {m.meta.usage && usageLine(m.meta.usage) ? ` · ${usageLine(m.meta.usage)}` : ''}
                          {m.meta.usage?.estimated && <span className="chat-estimated">≈ estimated</span>}
                        </span>
                      )}
                      {bridgeButton(m.text, `${m.id}-all`, 'Send the whole message to the target terminal')}
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
