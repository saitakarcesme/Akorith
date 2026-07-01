import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Companion,
  CompanionMemory,
  CompanionMessage,
  CompanionSession,
  RuntimeStatus,
  SendCompanionMessageResult
} from '../../../preload/index.d'
import { ComposerActionButton } from './CreationPrimitives'
import { SendIcon, StopIcon } from './icons'

// Phase 51: Companions — long-memory local personalities (Athena, Zeus). Think and
// remember. Companions never take actions.

type CompanionUiMessage = CompanionMessage & {
  pending?: boolean
  tone?: 'thinking' | 'error' | 'stopped'
}

function newClientId(prefix: string): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function persistedMatchesPending(persisted: CompanionMessage, pending: CompanionUiMessage): boolean {
  return Boolean(
    pending.pending &&
      persisted.sessionId === pending.sessionId &&
      persisted.role === pending.role &&
      persisted.content === pending.content
  )
}

function mergePersistedMessages(persisted: CompanionMessage[], current: CompanionUiMessage[]): CompanionUiMessage[] {
  const stillPending = current.filter(
    (message) => message.pending && !persisted.some((saved) => persistedMatchesPending(saved, message))
  )
  return [...persisted, ...stillPending]
}

export default function CompanionsPage({ active }: { active: boolean }): JSX.Element {
  const [companions, setCompanions] = useState<Companion[]>([])
  const [memoryCounts, setMemoryCounts] = useState<Record<string, number>>({})
  const [selectedCompanion, setSelectedCompanion] = useState<string | null>(null)
  const [sessions, setSessions] = useState<CompanionSession[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CompanionMessage[]>([])
  const [memories, setMemories] = useState<CompanionMemory[]>([])
  const [usedMemoryIds, setUsedMemoryIds] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadCompanions = useCallback(async () => {
    const list = (await window.api.companion.list()) as Companion[]
    setCompanions(list)
    setSelectedCompanion((cur) => cur ?? list[0]?.id ?? null)
    const counts: Record<string, number> = {}
    for (const c of list) counts[c.id] = (await window.api.companion.memoryCount(c.id)) as number
    setMemoryCounts(counts)
  }, [])

  useEffect(() => {
    if (!active) return
    void loadCompanions()
    void window.api.localRuntime.status().then((s) => setRuntime(s as RuntimeStatus)).catch(() => setRuntime(null))
  }, [active, loadCompanions])

  const loadSessions = useCallback(async (companionId: string) => {
    const list = (await window.api.companion.listSessions(companionId)) as CompanionSession[]
    setSessions(list)
    setSessionId((cur) => (list.some((s) => s.id === cur) ? cur : list[0]?.id ?? null))
  }, [])

  const loadMemories = useCallback(async (companionId: string) => {
    setMemories((await window.api.companion.listMemories(companionId)) as CompanionMemory[])
  }, [])

  useEffect(() => {
    if (selectedCompanion) {
      void loadSessions(selectedCompanion)
      void loadMemories(selectedCompanion)
    }
  }, [selectedCompanion, loadSessions, loadMemories])

  useEffect(() => {
    if (sessionId) void window.api.companion.listMessages(sessionId).then((m) => setMessages(m as CompanionMessage[]))
    else setMessages([])
    setUsedMemoryIds([])
  }, [sessionId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const companion = useMemo(() => companions.find((c) => c.id === selectedCompanion) ?? null, [companions, selectedCompanion])

  const newChat = async (): Promise<void> => {
    if (!selectedCompanion) return
    const s = (await window.api.companion.createSession(selectedCompanion)) as CompanionSession
    await loadSessions(selectedCompanion)
    setSessionId(s.id)
  }

  const send = async (): Promise<void> => {
    if (!companion || !draft.trim() || busy) return
    let sid = sessionId
    if (!sid) {
      const s = (await window.api.companion.createSession(companion.id)) as CompanionSession
      sid = s.id
      setSessionId(sid)
    }
    const prompt = draft.trim()
    setDraft('')
    setBusy(true)
    // optimistic user bubble
    setMessages((prev) => [...prev, { id: 'tmp', sessionId: sid!, companionId: companion.id, role: 'user', content: prompt, createdAt: Date.now() }])
    try {
      const res = (await window.api.companion.sendMessage({ companionId: companion.id, sessionId: sid, prompt })) as SendCompanionMessageResult
      const msgs = (await window.api.companion.listMessages(sid)) as CompanionMessage[]
      setMessages(msgs)
      if (res.contextInfo) setUsedMemoryIds(res.contextInfo.usedMemories.map((m) => m.id))
      if (!res.ok) {
        setMessages((prev) => [...prev, { id: 'err', sessionId: sid!, companionId: companion.id, role: 'assistant', content: `⚠ ${res.error ?? 'error'} — is a local model running?`, createdAt: Date.now() }])
      }
      // fire-and-forget memory extraction after a few turns
      if (msgs.length >= 4 && msgs.length % 4 === 0) {
        void window.api.companion.extractMemories(sid).then(() => void loadMemories(companion.id))
      }
      await loadSessions(companion.id)
      setMemoryCounts((c) => ({ ...c, [companion.id]: c[companion.id] ?? 0 }))
    } finally {
      setBusy(false)
    }
  }

  const extractNow = async (): Promise<void> => {
    if (!companion || !sessionId) return
    setBusy(true)
    try {
      await window.api.companion.extractMemories(sessionId)
      await loadMemories(companion.id)
      const count = (await window.api.companion.memoryCount(companion.id)) as number
      setMemoryCounts((c) => ({ ...c, [companion.id]: count }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="companions-page">
      <aside className="companions-left">
        <div className="companions-head">
          <h1>Companions</h1>
          <span className={`runtime-pill is-${runtime?.readiness ?? 'setup'}`} title={runtime?.reason}>
            <span className="runtime-pill-dot" />
            {runtime?.ok ? 'Local' : 'Offline'}
          </span>
        </div>
        <p className="companions-sub">Think and remember. Companions never touch your files.</p>
        <div className="companion-cards">
          {companions.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`companion-card ${c.id === selectedCompanion ? 'is-active' : ''}`}
              onClick={() => setSelectedCompanion(c.id)}
            >
              <div className="companion-card-avatar">{c.name[0]}</div>
              <div className="companion-card-body">
                <div className="companion-card-name">{c.name}</div>
                <div className="companion-card-tagline">{c.tagline}</div>
                <div className="companion-card-tags">
                  {c.tags.slice(0, 3).map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
                <div className="companion-card-meta">{memoryCounts[c.id] ?? 0} memories</div>
              </div>
            </button>
          ))}
        </div>

        <div className="companion-sessions-head">
          <span>Conversations</span>
          <button type="button" onClick={() => void newChat()}>+ New</button>
        </div>
        <div className="companion-sessions">
          {sessions.length === 0 ? (
            <div className="companions-empty">No conversations yet.</div>
          ) : (
            sessions.map((s) => (
              <button key={s.id} type="button" className={s.id === sessionId ? 'is-active' : ''} onClick={() => setSessionId(s.id)}>
                <span className="companion-session-title">{s.title}</span>
                <span className="companion-session-meta">{s.messageCount} msg</span>
              </button>
            ))
          )}
        </div>
      </aside>

      <main className="companions-chat">
        {companion ? (
          <>
            <div className="companions-chat-head">
              <strong>{companion.name}</strong>
              <span>{companion.tagline}</span>
            </div>
            <div className="companions-messages" ref={scrollRef}>
              {messages.length === 0 ? (
                <div className="companions-empty-chat">
                  <p>Say hello to {companion.name}. They&apos;ll remember what matters across all your conversations.</p>
                </div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`companion-msg is-${m.role}`}>
                    {m.content}
                  </div>
                ))
              )}
              {busy && <div className="companion-msg is-assistant is-thinking">…</div>}
            </div>
            <div className="companions-composer">
              <textarea
                value={draft}
                placeholder={`Message ${companion.name}…`}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <button type="button" className="is-primary" disabled={busy || !draft.trim()} onClick={() => void send()}>
                Send
              </button>
            </div>
          </>
        ) : (
          <div className="companions-empty-chat">Loading companions…</div>
        )}
      </main>

      <aside className="companions-memory">
        <div className="companions-memory-head">
          <h3>Memory</h3>
          <button type="button" disabled={busy || !sessionId} onClick={() => void extractNow()} title="Extract memories from this conversation now">
            Extract
          </button>
        </div>
        {companion && (
          <MemoryPanel
            companionId={companion.id}
            memories={memories}
            usedIds={usedMemoryIds}
            onChange={() => void loadMemories(companion.id)}
          />
        )}
      </aside>
    </div>
  )
}

function MemoryPanel({
  companionId,
  memories,
  usedIds,
  onChange
}: {
  companionId: string
  memories: CompanionMemory[]
  usedIds: string[]
  onChange: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    if (!query.trim()) return memories
    const q = query.toLowerCase()
    return memories.filter((m) => (m.title + ' ' + m.content).toLowerCase().includes(q))
  }, [memories, query])
  const pinned = filtered.filter((m) => m.pinned)
  const rest = filtered.filter((m) => !m.pinned)

  const row = (m: CompanionMemory): JSX.Element => (
    <div key={m.id} className={`memory-item ${usedIds.includes(m.id) ? 'is-used' : ''}`}>
      <div className="memory-item-top">
        <span className="memory-type">{m.type}</span>
        {usedIds.includes(m.id) && <span className="memory-used">used</span>}
      </div>
      <div className="memory-title">{m.title}</div>
      <div className="memory-content">{m.content}</div>
      <div className="memory-actions">
        <button type="button" onClick={() => void window.api.companion.pinMemory(m.id, !m.pinned).then(onChange)}>
          {m.pinned ? 'Unpin' : 'Pin'}
        </button>
        <button type="button" onClick={() => void window.api.companion.archiveMemory(m.id).then(onChange)}>Archive</button>
        <button type="button" className="is-danger" onClick={() => void window.api.companion.forgetMemory(m.id).then(onChange)}>Forget</button>
      </div>
    </div>
  )

  return (
    <>
      <input className="memory-search" value={query} placeholder="Search memories…" onChange={(e) => setQuery(e.target.value)} />
      {usedIds.length > 0 && <div className="memory-section-label">Recalled in the last reply</div>}
      {memories.length === 0 ? (
        <div className="companions-empty">No memories yet. They&apos;ll grow as you talk.</div>
      ) : (
        <div className="memory-list">
          {pinned.length > 0 && <div className="memory-section-label">Pinned</div>}
          {pinned.map(row)}
          {rest.length > 0 && <div className="memory-section-label">Remembered</div>}
          {rest.map(row)}
        </div>
      )}
      <AddMemory companionId={companionId} onChange={onChange} />
    </>
  )
}

function AddMemory({ companionId, onChange }: { companionId: string; onChange: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const add = async (): Promise<void> => {
    if (!title.trim() || !content.trim()) return
    await window.api.companion.createMemory({ companionId, type: 'personal_context', title: title.trim(), content: content.trim(), importance: 4 })
    setTitle('')
    setContent('')
    setOpen(false)
    onChange()
  }
  if (!open) {
    return (
      <button type="button" className="memory-add-toggle" onClick={() => setOpen(true)}>
        + Add a memory manually
      </button>
    )
  }
  return (
    <div className="memory-add">
      <input value={title} placeholder="Title" onChange={(e) => setTitle(e.target.value)} />
      <textarea value={content} placeholder="What should they remember?" onChange={(e) => setContent(e.target.value)} />
      <div className="memory-add-actions">
        <button type="button" onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="is-primary" onClick={() => void add()}>Save</button>
      </div>
    </div>
  )
}
