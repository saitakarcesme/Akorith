import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatUsage, ProviderInfo } from '../../../preload/index.d'
import type { HistorySelection } from '../App'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: 'streaming' | 'done' | 'error'
  meta?: { provider: string; model: string; usage?: ChatUsage }
}

// Matches the panes mounted in TerminalColumn.
const TERMINALS = [
  { id: 't1', label: 'Terminal 1' },
  { id: 't2', label: 'Terminal 2' }
] as const

interface ChatPanelProps {
  /** Sidebar instruction: load a session or start a fresh thread. */
  historySel: HistorySelection | null
  /** Notify the app that sessions changed (titles, ordering, creation). */
  onHistoryChange: () => void
  onActiveSession: (sessionId: string | null) => void
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

export default function ChatPanel({ historySel, onHistoryChange, onActiveSession }: ChatPanelProps): JSX.Element {
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
    return () => {
      clearTimeout(toastTimer.current)
      clearTimeout(sentTimer.current)
    }
  }, [loadProviders])

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
  // PtyManager.write(). TODO(phase 8): the loop reuses the same main-side path.
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
        const session = await window.api.history.create(selected.id, prompt.slice(0, 80))
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

  const bridgeButton = (text: string, key: string, title: string): JSX.Element => (
    <button
      type="button"
      className={`bridge-button ${sentKey === key ? 'is-sent' : ''}`}
      title={title}
      onClick={() => void sendToTerminal(text, key)}
    >
      {sentKey === key ? '✓ sent' : '→ Terminal'}
    </button>
  )

  return (
    <aside className="chat-panel">
      <header className="chat-header">
        <span className="chat-header-title">Planner</span>
        <div className="chat-header-controls">
          <select
            className="model-select"
            value={providerId}
            onChange={(event) => {
              const next = event.target.value
              if (next !== providerId && (activeSessionId || messages.length > 0)) {
                // One provider per session: switching starts a fresh thread
                // (the old conversation stays in the sidebar).
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
            <select
              className="model-select"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              aria-label="Model"
            >
              {selected.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="icon-button"
            title="Refresh providers (re-reads loopex.config.json)"
            onClick={() => void loadProviders()}
          >
            ↻
          </button>
        </div>
      </header>

      <div className="bridge-bar">
        <span className="bridge-bar-label">Send to</span>
        <div className="bridge-target" role="group" aria-label="Bridge target terminal">
          {TERMINALS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={bridgeTarget === t.id ? 'is-active' : ''}
              onClick={() => setBridgeTarget(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <label
          className="bridge-toggle"
          title="ON: sent text executes immediately. OFF: it waits at the prompt for your Enter."
        >
          <input
            type="checkbox"
            checked={autoEnter ?? false}
            disabled={autoEnter === null}
            onChange={() => void toggleAutoEnter()}
          />
          Auto-Enter
        </label>
      </div>

      {selected && !selected.available.ok && (
        <div className="chat-notice">
          {selected.label} unavailable{selected.available.reason ? `: ${selected.available.reason}` : ''}
        </div>
      )}
      {loadError && <div className="chat-notice">Failed to load providers: {loadError}</div>}

      <div
        className="chat-messages"
        ref={scrollRef}
        onMouseUp={handleSelectionMouseUp}
        onScroll={() => setSelection(null)}
      >
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-glyph">{'>_'}</div>
            <div>No messages yet</div>
            <div className="chat-empty-hint">
              {providers === null
                ? 'Loading providers…'
                : providers.length === 0
                  ? 'No providers configured — edit loopex.config.json.'
                  : 'Plan with the selected provider, then send prompts straight into a terminal.'}
            </div>
          </div>
        ) : (
          messages.map((m) => (
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
          ))
        )}
      </div>

      {selection && (
        <button
          type="button"
          className="selection-popover"
          style={{ left: selection.x, top: selection.y - 34 }}
          onMouseDown={(event) => event.preventDefault() /* keep the selection alive */}
          onClick={() => {
            void sendToTerminal(selection.text, 'selection')
            setSelection(null)
            window.getSelection()?.removeAllRanges()
          }}
        >
          Send selection →
        </button>
      )}

      {toast && <div className={`bridge-toast ${toast.kind}`}>{toast.text}</div>}

      <div className="chat-composer">
        <textarea
          className="chat-input"
          placeholder={
            selected?.available.ok
              ? 'Describe what you want to build… (Enter to send, Shift+Enter for newline)'
              : 'Select an available provider to start…'
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
        <div className="chat-composer-row">
          {busyRequestId ? (
            <button type="button" className="send-button" onClick={cancel}>
              Stop
            </button>
          ) : (
            <button type="button" className="send-button" disabled={!canSend} onClick={() => void sendPrompt()}>
              Send
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
