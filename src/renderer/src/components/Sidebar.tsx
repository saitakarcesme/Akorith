import { useEffect, useMemo, useState } from 'react'
import type { ProjectRow, ProviderInfo, SessionRow } from '../../../preload/index.d'
import type { AppView } from '../App'
import {
  ChartIcon,
  ChevronIcon,
  FlaskIcon,
  FolderIcon,
  MessageIcon,
  PanelsIcon,
  PlusIcon,
  SettingsIcon,
  UserIcon
} from './icons'

interface SidebarProps {
  view: AppView
  onNavigate: (view: AppView) => void
  historyVersion: number
  projectVersion: number
  activeSessionId: string | null
  activeProject: ProjectRow | null
  onSelectProject: (project: ProjectRow | null) => void
  onSelectSession: (sessionId: string, project?: ProjectRow | null) => void
  onNewChat: (providerId: string) => void
  onHistoryChange: () => void
  onProjectsChange: () => void
}

const NAV_ITEMS: { view: AppView; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { view: 'workspace', label: 'Workspace', icon: PanelsIcon },
  { view: 'dashboard', label: 'Dashboard', icon: ChartIcon },
  { view: 'test', label: 'Test', icon: FlaskIcon }
]

function storageBoolean(key: string, fallback: boolean): boolean {
  try {
    return localStorage.getItem(key) === null ? fallback : localStorage.getItem(key) === 'true'
  } catch {
    return fallback
  }
}

function storageString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function providerTone(id: string): string {
  const normalized = id.toLowerCase()
  if (normalized.includes('claude')) return 'tone-claude'
  if (normalized.includes('chatgpt') || normalized.includes('codex')) return 'tone-codex'
  if (normalized.includes('local') || normalized.includes('ollama')) return 'tone-local'
  return 'tone-neutral'
}

function providerShortLabel(id: string, label: string): string {
  if (id.includes('claude')) return 'Cl'
  if (id.includes('chatgpt') || id.includes('codex')) return 'Cx'
  if (id.includes('local') || id.includes('ollama')) return 'Lo'
  return label.slice(0, 2)
}

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ts))
}

export default function Sidebar({
  view,
  onNavigate,
  historyVersion,
  projectVersion,
  activeSessionId,
  activeProject,
  onSelectProject,
  onSelectSession,
  onNewChat,
  onHistoryChange,
  onProjectsChange
}: SidebarProps): JSX.Element {
  // Folders come from the registry + DB — never a hardcoded provider list.
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [projects, setProjects] = useState<ProjectRow[]>([])
  // Provider groups default to collapsed for a cleaner first load; explicit
  // toggles persist per provider id. A provider absent from the map is collapsed.
  const [providerCollapsed, setProviderCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('akorith.providerCollapsed')
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
    } catch {
      return {}
    }
  })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => storageBoolean('akorith.sidebarCollapsed', false))
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newParent, setNewParent] = useState<string | null>(null)
  const [projectBusy, setProjectBusy] = useState<'open' | 'create' | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [displayName, setDisplayName] = useState(() => storageString('akorith.displayName', 'Ibrahim'))

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

  useEffect(() => {
    window.api.projects
      .list()
      .then(setProjects)
      .catch(() => setProjects([]))
  }, [projectVersion])

  useEffect(() => {
    localStorage.setItem('akorith.sidebarCollapsed', String(sidebarCollapsed))
  }, [sidebarCollapsed])

  useEffect(() => {
    localStorage.setItem('akorith.providerCollapsed', JSON.stringify(providerCollapsed))
  }, [providerCollapsed])

  useEffect(() => {
    localStorage.setItem('akorith.displayName', displayName)
  }, [displayName])

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const recentSessions = sessions.slice(0, 6)
  const visibleSessions = activeProject ? sessions.filter((s) => s.projectId === activeProject.id) : sessions

  // Registry providers first (in registry order), then any orphaned provider
  // ids that still have sessions but are gone from config.
  const folderIds = [
    ...providers.map((p) => p.id),
    ...[...new Set(visibleSessions.map((s) => s.providerId))].filter((id) => !providers.some((p) => p.id === id))
  ]
  const labelOf = (id: string): string => providers.find((p) => p.id === id)?.label ?? id

  const refreshProjects = async (): Promise<void> => {
    const list = await window.api.projects.list()
    setProjects(list)
  }

  // Open Project — reuses the same validated main-process folder dialog as the
  // terminal onboarding flow; persists/selects the project and starts its agents.
  const openExistingProject = async (): Promise<void> => {
    setProjectMenuOpen(false)
    setProjectBusy('open')
    setProjectError(null)
    try {
      const res = await window.api.projects.openFolder(null)
      if (res.ok) {
        await refreshProjects()
        onProjectsChange()
        onSelectProject(res.project)
      } else if (!res.cancelled) {
        setProjectError(res.error)
      }
    } finally {
      setProjectBusy(null)
    }
  }

  const beginCreateProject = (): void => {
    setProjectMenuOpen(false)
    setNewName('')
    setNewParent(null)
    setProjectError(null)
    setCreateOpen(true)
  }

  const pickParentDir = async (): Promise<void> => {
    setProjectError(null)
    const res = await window.api.projects.pickDirectory()
    if (res.ok) setNewParent(res.path)
    else if (!res.cancelled) setProjectError(res.error)
  }

  const submitCreateProject = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) {
      setProjectError('Enter a project name.')
      return
    }
    if (!newParent) {
      setProjectError('Choose a parent folder.')
      return
    }
    setProjectBusy('create')
    setProjectError(null)
    try {
      const res = await window.api.projects.createFolder({ name, parentPath: newParent })
      if (res.ok) {
        setCreateOpen(false)
        await refreshProjects()
        onProjectsChange()
        onSelectProject(res.project)
      } else if (!res.cancelled) {
        setProjectError(res.error)
      }
    } finally {
      setProjectBusy(null)
    }
  }

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

  const selectSession = (session: SessionRow): void => {
    onSelectSession(session.id, session.projectId ? projectById.get(session.projectId) ?? null : null)
  }

  return (
    <aside className={`sidebar ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
      <div className="sidebar-brand">
        <div className="brand-lockup" title="Akorith">
          <img src="/akorith-icon.svg" alt="" />
          {!sidebarCollapsed && (
            <div>
              <div className="brand-name">Akorith</div>
              <div className="brand-subtitle">Agent orchestration</div>
            </div>
          )}
        </div>
        <button
          type="button"
          className="sidebar-collapse-btn"
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => setSidebarCollapsed((value) => !value)}
        >
          <ChevronIcon size={16} direction={sidebarCollapsed ? 'right' : 'left'} />
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Primary">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.view}
              type="button"
              className={view === item.view ? 'is-active' : ''}
              onClick={() => onNavigate(item.view)}
              title={item.label}
            >
              <Icon size={17} />
              {!sidebarCollapsed && <span>{item.label}</span>}
            </button>
          )
        })}
      </nav>

      {sidebarCollapsed ? (
        <div className="sidebar-collapsed-stack">
          <button
            type="button"
            className={`collapsed-project-dot ${!activeProject ? 'is-active' : ''}`}
            onClick={() => onSelectProject(null)}
            title="All projects"
          >
            <FolderIcon size={17} />
          </button>
          {projects.slice(0, 8).map((project) => (
            <button
              type="button"
              key={project.id}
              className={`collapsed-project-dot ${activeProject?.id === project.id ? 'is-active' : ''}`}
              onClick={() => onSelectProject(project)}
              title={project.name}
            >
              {project.name.slice(0, 1).toUpperCase()}
            </button>
          ))}
          {providers.map((provider) => (
            <button
              type="button"
              key={provider.id}
              className={`collapsed-provider-dot ${providerTone(provider.id)}`}
              title={provider.label}
              onClick={() => onNewChat(provider.id)}
            >
              {providerShortLabel(provider.id, provider.label)}
            </button>
          ))}
        </div>
      ) : (
        <div className="sidebar-scroll">
          <section className="sidebar-section project-section">
            <div className="sidebar-section-header">
              <button
                type="button"
                className={`sidebar-fold ${!activeProject ? 'is-active' : ''}`}
                onClick={() => onSelectProject(null)}
              >
                <FolderIcon size={15} />
                All projects
              </button>
              <div className="sidebar-add-wrap">
                <button
                  type="button"
                  className="sidebar-add"
                  title="Add project"
                  aria-haspopup="menu"
                  aria-expanded={projectMenuOpen}
                  disabled={projectBusy !== null}
                  onClick={() => setProjectMenuOpen((value) => !value)}
                >
                  <PlusIcon size={14} />
                </button>
                {projectMenuOpen && (
                  <>
                    <div className="popover-backdrop" onClick={() => setProjectMenuOpen(false)} />
                    <div className="project-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => void openExistingProject()}>
                        <FolderIcon size={14} />
                        <span>Open Project</span>
                      </button>
                      <button type="button" role="menuitem" onClick={beginCreateProject}>
                        <PlusIcon size={14} />
                        <span>Create Project</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
            {projectBusy === 'open' && <div className="sidebar-item is-empty">Opening project…</div>}
            {projectError && !createOpen && <div className="project-onboarding-error">{projectError}</div>}
            <div className="project-list">
              {projects.length === 0 ? (
                <div className="sidebar-item is-empty">No project folders yet</div>
              ) : (
                projects.map((project) => (
                  <button
                    type="button"
                    key={project.id}
                    className={`project-item ${activeProject?.id === project.id ? 'is-active' : ''}`}
                    onClick={() => onSelectProject(project)}
                    title={project.path ?? project.name}
                  >
                    <span className="project-avatar">{project.name.slice(0, 1).toUpperCase()}</span>
                    <span className="project-text">
                      <span>{project.name}</span>
                      <em>{project.path || 'No path associated'}</em>
                    </span>
                  </button>
                ))
              )}
            </div>
            {activeProject?.path && <div className="project-agent-hint">Olympus and Atlantis start in this folder.</div>}
          </section>

          <section className="sidebar-section">
            <div className="sidebar-section-title">Recent chats</div>
            {recentSessions.length === 0 ? (
              <div className="sidebar-item is-empty">No recent chats yet</div>
            ) : (
              recentSessions.map((session) => {
                const provider = labelOf(session.providerId)
                const project = session.projectId ? projectById.get(session.projectId) : null
                return (
                  <button
                    type="button"
                    className={`recent-chat ${session.id === activeSessionId ? 'is-active' : ''} ${providerTone(
                      session.providerId
                    )}`}
                    key={session.id}
                    onClick={() => selectSession(session)}
                    title={session.title}
                  >
                    <span className="recent-provider-dot" />
                    <span className="recent-chat-text">
                      <span>{session.title}</span>
                      <em>
                        {provider}
                        {project ? ` · ${project.name}` : ''} · {formatDate(session.updatedAt)}
                      </em>
                    </span>
                  </button>
                )
              })
            )}
          </section>

          {folderIds.map((providerId) => {
            const items = visibleSessions.filter((s) => s.providerId === providerId)
            const isCollapsed = providerCollapsed[providerId] ?? true
            return (
              <section className={`sidebar-section provider-section ${providerTone(providerId)}`} key={providerId}>
                <div className="sidebar-section-header provider-header">
                  <button
                    type="button"
                    className="sidebar-fold"
                    onClick={() => setProviderCollapsed((c) => ({ ...c, [providerId]: !isCollapsed }))}
                    title={isCollapsed ? 'Expand' : 'Collapse'}
                  >
                    <ChevronIcon size={13} direction={isCollapsed ? 'right' : 'down'} />
                    <FolderIcon size={15} />
                    {labelOf(providerId)}
                    {items.length > 0 && <span className="sidebar-count">{items.length}</span>}
                  </button>
                  <button
                    type="button"
                    className="sidebar-add"
                    title={`New ${labelOf(providerId)} chat`}
                    onClick={() => onNewChat(providerId)}
                  >
                    <PlusIcon size={14} />
                  </button>
                </div>
                {!isCollapsed &&
                  (items.length === 0 ? (
                    <div className="sidebar-item is-empty">
                      <MessageIcon size={13} />
                      <span>{activeProject ? 'No project chats yet' : 'No sessions yet'}</span>
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
                          onClick={() => selectSession(s)}
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
                              Edit
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
                                Delete?
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
                                Remove
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
        </div>
      )}

      <div className="sidebar-profile">
        {settingsOpen && !sidebarCollapsed && (
          <div className="settings-popover">
            <div className="settings-title">Settings</div>
            <label>
              <span>Display name</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
            <div className="settings-note">Theme: Akorith dark</div>
            <div className="settings-note">Package identity cleanup remains Phase 10.</div>
          </div>
        )}
        <button type="button" className="profile-button" onClick={() => setSettingsOpen((value) => !value)} title="Settings">
          <UserIcon size={17} />
          {!sidebarCollapsed && (
            <span>
              <strong>{displayName.trim() || 'User'}</strong>
              <em>Local profile</em>
            </span>
          )}
          {!sidebarCollapsed && <SettingsIcon size={16} />}
        </button>
      </div>

      {createOpen && (
        <div className="modal-overlay" onClick={() => projectBusy === null && setCreateOpen(false)}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-label="Create project" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Create project</div>
            <p className="modal-subtitle">
              Akorith creates the folder, then starts Olympus as Codex and Atlantis as Claude inside it.
            </p>
            <label className="modal-field">
              <span>Project name</span>
              <input
                value={newName}
                placeholder="my-project"
                autoFocus
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && newName.trim() && newParent) void submitCreateProject()
                  if (event.key === 'Escape' && projectBusy === null) setCreateOpen(false)
                }}
              />
            </label>
            <label className="modal-field">
              <span>Parent folder</span>
              <div className="modal-dir-row">
                <span className="modal-dir-path" title={newParent ?? ''}>
                  {newParent ?? 'No folder selected'}
                </span>
                <button type="button" className="modal-dir-btn" onClick={() => void pickParentDir()} disabled={projectBusy !== null}>
                  <FolderIcon size={14} />
                  Choose…
                </button>
              </div>
            </label>
            {projectError && <div className="modal-error">{projectError}</div>}
            <div className="modal-actions">
              <button type="button" className="modal-cancel" onClick={() => setCreateOpen(false)} disabled={projectBusy !== null}>
                Cancel
              </button>
              <button
                type="button"
                className="modal-confirm"
                onClick={() => void submitCreateProject()}
                disabled={projectBusy !== null || !newName.trim() || !newParent}
              >
                {projectBusy === 'create' ? 'Creating…' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
