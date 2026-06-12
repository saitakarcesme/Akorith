import { useEffect, useState } from 'react'
import type { ProviderInfo, SessionRow } from '../../../preload/index.d'
import type { AppView } from '../App'

interface SidebarProps {
  view: AppView
  onNavigate: (view: AppView) => void
  historyVersion: number
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onNewChat: (providerId: string) => void
  onHistoryChange: () => void
}

export default function Sidebar({
  view,
  onNavigate,
  historyVersion,
  activeSessionId,
  onSelectSession,
  onNewChat,
  onHistoryChange
}: SidebarProps): JSX.Element {
  // Folders come from the registry + DB — never a hardcoded provider list.
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => {
    window.api.chat
      .listProviders()
      .then(setProviders)
      .catch(() => setProviders([]))
  }, [])

  useEffect(() => {
    window.api.history
      .list()
      .then(setSessions)
      .catch(() => setSessions([]))
  }, [historyVersion])

  // Registry providers first (in registry order), then any orphaned provider
  // ids that still have sessions but are gone from config.
  const folderIds = [
    ...providers.map((p) => p.id),
    ...[...new Set(sessions.map((s) => s.providerId))].filter((id) => !providers.some((p) => p.id === id))
  ]
  const labelOf = (id: string): string => providers.find((p) => p.id === id)?.label ?? id

  const commitRename = async (sessionId: string): Promise<void> => {
    const title = renameValue.trim()
    setRenamingId(null)
    if (title) {
      await window.api.history.rename(sessionId, title)
      onHistoryChange()
    }
  }

  const deleteSession = async (session: SessionRow): Promise<void> => {
    setConfirmDeleteId(null)
    await window.api.history.remove(session.id)
    onHistoryChange()
    if (session.id === activeSessionId) onNewChat(session.providerId)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">Loopex</div>

      <nav className="sidebar-nav">
        <button
          type="button"
          className={view === 'workspace' ? 'is-active' : ''}
          onClick={() => onNavigate('workspace')}
        >
          Workspace
        </button>
        <button
          type="button"
          className={view === 'dashboard' ? 'is-active' : ''}
          onClick={() => onNavigate('dashboard')}
        >
          Dashboard
        </button>
        <button type="button" className={view === 'test' ? 'is-active' : ''} onClick={() => onNavigate('test')}>
          Test
        </button>
      </nav>

      {folderIds.map((providerId) => {
        const items = sessions.filter((s) => s.providerId === providerId)
        const isCollapsed = collapsed[providerId] ?? false
        return (
          <section className="sidebar-section" key={providerId}>
            <div className="sidebar-section-header">
              <button
                type="button"
                className="sidebar-fold"
                onClick={() => setCollapsed((c) => ({ ...c, [providerId]: !isCollapsed }))}
                title={isCollapsed ? 'Expand' : 'Collapse'}
              >
                <span className="sidebar-fold-arrow">{isCollapsed ? '▸' : '▾'}</span>
                {labelOf(providerId)}
                {items.length > 0 && <span className="sidebar-count">{items.length}</span>}
              </button>
              <button
                type="button"
                className="sidebar-add"
                title={`New ${labelOf(providerId)} chat`}
                onClick={() => onNewChat(providerId)}
              >
                +
              </button>
            </div>
            {!isCollapsed &&
              (items.length === 0 ? (
                <div className="sidebar-item is-empty">
                  <span className="sidebar-item-dot" />
                  <span>No sessions yet</span>
                </div>
              ) : (
                items.map((s) =>
                  renamingId === s.id ? (
                    <div className="sidebar-item" key={s.id}>
                      <input
                        className="sidebar-rename-input"
                        value={renameValue}
                        autoFocus
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(s.id)
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        onBlur={() => void commitRename(s.id)}
                      />
                    </div>
                  ) : (
                    <div
                      className={`sidebar-item is-session ${s.id === activeSessionId ? 'is-active' : ''}`}
                      key={s.id}
                      onClick={() => onSelectSession(s.id)}
                      title={s.title}
                    >
                      <span className="sidebar-item-title">{s.title}</span>
                      <span className="sidebar-item-actions">
                        <button
                          type="button"
                          title="Rename"
                          onClick={(e) => {
                            e.stopPropagation()
                            setRenamingId(s.id)
                            setRenameValue(s.title)
                            setConfirmDeleteId(null)
                          }}
                        >
                          ✎
                        </button>
                        {confirmDeleteId === s.id ? (
                          <button
                            type="button"
                            className="is-danger"
                            title="Click again to delete"
                            onClick={(e) => {
                              e.stopPropagation()
                              void deleteSession(s)
                            }}
                          >
                            sure?
                          </button>
                        ) : (
                          <button
                            type="button"
                            title="Delete"
                            onClick={(e) => {
                              e.stopPropagation()
                              setConfirmDeleteId(s.id)
                              setTimeout(() => setConfirmDeleteId((id) => (id === s.id ? null : id)), 2500)
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    </div>
                  )
                )
              ))}
          </section>
        )
      })}
    </aside>
  )
}
