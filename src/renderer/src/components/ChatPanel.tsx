import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatUsage, ProviderInfo } from '../../../preload/index.d'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: 'streaming' | 'done' | 'error'
  meta?: { provider: string; model: string; usage?: ChatUsage }
}

// TODO(phase 5): persist messages (SQLite history) — for now state only.

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

export default function ChatPanel(): JSX.Element {
  // Everything below is driven by the registry — never a hardcoded backend list.
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [providerId, setProviderId] = useState<string>('')
  const [model, setModel] = useState<string>('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

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
  }, [loadProviders])

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

  const patchMessage = (id: string, patch: Partial<ChatMessage> | ((m: ChatMessage) => ChatMessage)): void => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? (typeof patch === 'function' ? patch(m) : { ...m, ...patch }) : m))
    )
  }

  const sendPrompt = async (): Promise<void> => {
    const prompt = draft.trim()
    if (!prompt || busyRequestId || !selected?.available.ok) return

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
        prompt
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
    }
  }

  const cancel = (): void => {
    if (busyRequestId) window.api.chat.cancel(busyRequestId)
  }

  const canSend = Boolean(draft.trim()) && !busyRequestId && Boolean(selected?.available.ok)

  return (
    <aside className="chat-panel">
      <header className="chat-header">
        <span className="chat-header-title">Planner</span>
        <div className="chat-header-controls">
          <select
            className="model-select"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
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

      {selected && !selected.available.ok && (
        <div className="chat-notice">
          {selected.label} unavailable{selected.available.reason ? `: ${selected.available.reason}` : ''}
        </div>
      )}
      {loadError && <div className="chat-notice">Failed to load providers: {loadError}</div>}

      <div className="chat-messages" ref={scrollRef}>
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
              <div className="chat-msg-text">
                {m.text || (m.status === 'streaming' ? '…' : '')}
              </div>
              {/* TODO(phase 4): "→ Terminal" bridge button on assistant messages. */}
              {m.role === 'assistant' && m.meta && m.status === 'done' && (
                <div className="chat-msg-meta">
                  {m.meta.provider} · {m.meta.model}
                  {m.meta.usage && usageLine(m.meta.usage) ? ` · ${usageLine(m.meta.usage)}` : ''}
                  {m.meta.usage?.estimated && <span className="chat-estimated">≈ estimated</span>}
                </div>
              )}
            </div>
          ))
        )}
      </div>

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
