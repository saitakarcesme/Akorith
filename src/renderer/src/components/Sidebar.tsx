import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OllamaConnectionSettings, OllamaEndpointSuggestion, OllamaShareInfo, ProjectRow, ProviderInfo, SessionRow } from '../../../preload/index.d'
import type { AppTheme, AppView } from '../App'
import {
  ChartIcon,
  ChevronIcon,
  CloseIcon,
  FlaskIcon,
  FolderIcon,
  LoopIcon,
  MessageIcon,
  PanelsIcon,
  PlusIcon,
  SettingsIcon,
  UserIcon
} from './icons'

interface SidebarProps {
  view: AppView
  theme: AppTheme
  onThemeChange: (theme: AppTheme) => void
  onNavigate: (view: AppView) => void
  historyVersion: number
  projectVersion: number
  activeSessionId: string | null
  activeProject: ProjectRow | null
  /** Bumped by the center empty-state "Create Project" button to open the modal. */
  createSignal?: number
  onSelectProject: (project: ProjectRow | null) => void
  onSelectSession: (sessionId: string, project?: ProjectRow | null, providerId?: string) => void
  onNewChat: (providerId: string) => void
  /** Phase 14.1: the top "New chat" action — always opens a fresh general chat. */
  onNewGeneralChat: () => void
  onHistoryChange: () => void
  onProjectsChange: () => void
}

// Phase 14.1: the separate "Chat" nav item is gone; a "New chat" action sits
// above Workspace instead (see below). Workspace stays project-scoped.
const NAV_ITEMS: { view: AppView; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { view: 'workspace', label: 'Workspace', icon: PanelsIcon },
  { view: 'loops', label: 'Loop', icon: LoopIcon },
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

function hasLocalAutoStarting(providers: ProviderInfo[]): boolean {
  return providers.some((provider) =>
    provider.id === 'local' &&
    !provider.available.ok &&
    /Akorith (is starting Ollama|tried to auto-start it)/i.test(provider.available.reason ?? '')
  )
}

function shortEndpointLabel(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`
  } catch {
    return value
  }
}

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ts))
}

export default function Sidebar({
  view,
  theme,
  onThemeChange,
  onNavigate,
  historyVersion,
  projectVersion,
  activeSessionId,
  activeProject,
  createSignal,
  onSelectProject,
  onSelectSession,
  onNewChat,
  onNewGeneralChat,
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
  // The Projects group is a collapsible folder like the provider folders below.
  // Defaults to expanded since the workspace is the primary entry point.
  const [projectsCollapsed, setProjectsCollapsed] = useState(() => storageBoolean('akorith.projectsCollapsed', false))
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => storageBoolean('akorith.sidebarCollapsed', false))
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  // Phase 14.3/14.4: per-project overflow menu + inline rename + remove confirm.
  // The menu is rendered fixed-position (anchored to the clicked button's rect)
  // so the Projects list's own `overflow-y: auto` cannot clip it.
  const [projectRowMenu, setProjectRowMenu] = useState<{ id: string; top: number; right: number } | null>(null)
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  const [renameProjectValue, setRenameProjectValue] = useState('')
  const [confirmRemoveProject, setConfirmRemoveProject] = useState<ProjectRow | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newParent, setNewParent] = useState<string | null>(null)
  const [projectBusy, setProjectBusy] = useState<'open' | 'create' | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [displayName, setDisplayName] = useState(() => storageString('akorith.displayName', 'Ibrahim'))
  const [ollamaSettings, setOllamaSettings] = useState<OllamaConnectionSettings | null>(null)
  const [ollamaEndpoint, setOllamaEndpoint] = useState('')
  const [ollamaShare, setOllamaShare] = useState<OllamaShareInfo | null>(null)
  const [ollamaBusy, setOllamaBusy] = useState<'test' | 'save' | null>(null)
  const [ollamaStatus, setOllamaStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null)

  const loadProviders = useCallback(() => {
    window.api.chat
      .listProviders()
      .then(setProviders)
      .catch(() => setProviders([]))
  }, [])

  const loadOllamaSettings = useCallback(() => {
    window.api.ollama
      .getSettings()
      .then((settings) => {
        setOllamaSettings(settings)
        setOllamaEndpoint(settings.baseUrl)
      })
      .catch(() => {
        setOllamaSettings(null)
        setOllamaEndpoint('http://localhost:11434')
      })
    window.api.ollama
      .getShareInfo()
      .then(setOllamaShare)
      .catch(() => setOllamaShare(null))
  }, [])

  useEffect(() => {
    loadProviders()
  }, [loadProviders])

  useEffect(() => {
    if (!settingsOpen) return
    loadOllamaSettings()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen, loadOllamaSettings])

  useEffect(() => {
    if (!hasLocalAutoStarting(providers)) return
    const timer = window.setTimeout(loadProviders, 3000)
    return () => window.clearTimeout(timer)
  }, [providers, loadProviders])

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
    localStorage.setItem('akorith.projectsCollapsed', String(projectsCollapsed))
  }, [projectsCollapsed])

  useEffect(() => {
    localStorage.setItem('akorith.providerCollapsed', JSON.stringify(providerCollapsed))
  }, [providerCollapsed])

  useEffect(() => {
    localStorage.setItem('akorith.displayName', displayName)
  }, [displayName])

  const testOllamaEndpoint = async (): Promise<void> => {
    const endpoint = ollamaEndpoint.trim()
    if (!endpoint) {
      setOllamaStatus({ kind: 'error', text: 'Enter an Ollama endpoint.' })
      return
    }
    setOllamaBusy('test')
    setOllamaStatus(null)
    try {
      const result = await window.api.ollama.testEndpoint(endpoint)
      if (result.ok) {
        setOllamaEndpoint(result.baseUrl)
        setOllamaStatus({ kind: 'ok', text: `Connected to ${shortEndpointLabel(result.baseUrl)} - ${result.modelCount} model${result.modelCount === 1 ? '' : 's'}` })
      } else {
        setOllamaStatus({ kind: 'error', text: result.error })
      }
    } catch (err) {
      setOllamaStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setOllamaBusy(null)
    }
  }

  const saveOllamaSettings = async (): Promise<void> => {
    const endpoint = ollamaEndpoint.trim()
    if (!endpoint || !ollamaSettings) return
    setOllamaBusy('save')
    setOllamaStatus(null)
    try {
      const response = await window.api.ollama.setSettings({ ...ollamaSettings, baseUrl: endpoint })
      setOllamaSettings(response.settings)
      setOllamaEndpoint(response.settings.baseUrl)
      if (response.ok) {
        setOllamaStatus({ kind: 'ok', text: `Saved ${shortEndpointLabel(response.settings.baseUrl)}` })
        loadProviders()
      } else {
        setOllamaStatus({ kind: 'error', text: response.error })
      }
    } catch (err) {
      setOllamaStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setOllamaBusy(null)
    }
  }

  const updateOllamaSetting = <K extends keyof OllamaConnectionSettings>(key: K, value: OllamaConnectionSettings[K]): void => {
    setOllamaSettings((settings) => (settings ? { ...settings, [key]: value } : settings))
  }

  const useOllamaEndpoint = (endpoint: OllamaEndpointSuggestion): void => {
    setOllamaEndpoint(endpoint.baseUrl)
    setOllamaStatus({ kind: 'info', text: `Selected ${shortEndpointLabel(endpoint.baseUrl)}` })
  }

  const copyOllamaEndpoint = async (endpoint: OllamaEndpointSuggestion): Promise<void> => {
    setOllamaEndpoint(endpoint.baseUrl)
    try {
      await navigator.clipboard.writeText(endpoint.baseUrl)
      setOllamaStatus({ kind: 'ok', text: `Copied ${shortEndpointLabel(endpoint.baseUrl)}` })
    } catch {
      setOllamaStatus({ kind: 'info', text: `Selected ${shortEndpointLabel(endpoint.baseUrl)}` })
    }
  }

  // Close the project actions menu on Escape (outside-click is handled by its
  // backdrop). Also re-close if the list scrolls so it never floats detached.
  useEffect(() => {
    if (!projectRowMenu) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setProjectRowMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [projectRowMenu])

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const recentSessions = sessions
  const generalSessions = sessions.filter((s) => !s.projectId)

  // Registry providers first (in registry order), then any orphaned provider
  // ids that still have sessions but are gone from config.
  const folderIds = [
    ...providers.map((p) => p.id),
    ...[...new Set(generalSessions.map((s) => s.providerId))].filter((id) => !providers.some((p) => p.id === id))
  ]
  const labelOf = (id: string): string => providers.find((p) => p.id === id)?.label ?? id
  const localProvider = providers.find((provider) => provider.id === 'local')
  const shareEndpoints = ollamaShare?.endpoints ?? []

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

  // The center workspace empty-state "Create Project" routes through here so the
  // sidebar owns the single create flow. Skip the initial render (signal 0).
  const firstSignal = useRef(true)
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false
      return
    }
    beginCreateProject()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSignal])

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
    onSelectSession(session.id, session.projectId ? projectById.get(session.projectId) ?? null : null, session.providerId)
  }

  const beginRenameProject = (project: ProjectRow): void => {
    setProjectRowMenu(null)
    setRenamingProjectId(project.id)
    setRenameProjectValue(project.name)
  }

  const revealProject = async (project: ProjectRow): Promise<void> => {
    setProjectRowMenu(null)
    const res = await window.api.projects.reveal(project.id)
    if (!res.ok) setProjectError(res.error)
  }

  // Open the per-row actions menu, anchored under the clicked button. Fixed
  // positioning keeps it out of the Projects list's scroll/overflow clip.
  const toggleProjectRowMenu = (projectId: string, event: ReactMouseEvent): void => {
    event.stopPropagation()
    setProjectRowMenu((current) => {
      if (current?.id === projectId) return null
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
      return { id: projectId, top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) }
    })
  }

  const commitProjectRename = async (project: ProjectRow): Promise<void> => {
    const name = renameProjectValue.trim()
    setRenamingProjectId(null)
    if (name && name !== project.name) {
      await window.api.projects.update(project.id, { name })
      await refreshProjects()
      onProjectsChange()
    }
  }

  // Phase 14.3: remove a project from Akorith's local list. This never deletes
  // the folder on disk. If the removed project is active, fall back to a clean
  // no-project Workspace; its (now-deleted) workspace chats leave Recent chats.
  const removeProject = async (project: ProjectRow): Promise<void> => {
    setConfirmRemoveProject(null)
    setProjectRowMenu(null)
    await window.api.projects.remove(project.id)
    if (activeProject?.id === project.id) onSelectProject(null)
    await refreshProjects()
    onProjectsChange()
    onHistoryChange()
  }

  return (
    <aside className={`sidebar ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
      <div className="sidebar-brand">
        <div className="brand-lockup" title="Akorith">
          {sidebarCollapsed ? (
            <img className="brand-mark" src="./akorith-logo.png" alt="" />
          ) : (
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
        <button
          type="button"
          className={`sidebar-newchat ${view === 'general' ? 'is-active' : ''}`}
          onClick={onNewGeneralChat}
          title="Start a fresh general chat"
        >
          <PlusIcon size={16} />
          {!sidebarCollapsed && <span>New chat</span>}
        </button>
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
          <div className="sidebar-fixed-groups">
            <section className="sidebar-section project-section">
              <div className="sidebar-section-header provider-header">
                <button
                  type="button"
                  className="sidebar-fold"
                  onClick={() => setProjectsCollapsed((value) => !value)}
                  title={projectsCollapsed ? 'Expand' : 'Collapse'}
                >
                  <ChevronIcon size={13} direction={projectsCollapsed ? 'right' : 'down'} />
                  <FolderIcon size={15} />
                  Projects
                  {projects.length > 0 && <span className="sidebar-count">{projects.length}</span>}
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
              {!projectsCollapsed && (
                <>
                  {projectBusy === 'open' && <div className="sidebar-item is-empty">Opening project…</div>}
                  {projectError && !createOpen && <div className="project-onboarding-error">{projectError}</div>}
                  <div className="project-list">
                    {projects.length === 0 ? (
                      <div className="sidebar-empty-state">
                        <p>No projects yet. Pick a folder — Akorith starts Codex and Claude there.</p>
                        <div className="sidebar-empty-actions">
                          <button type="button" className="sidebar-cta is-primary" disabled={projectBusy !== null} onClick={() => void openExistingProject()}>
                            <FolderIcon size={14} />
                            Open Project
                          </button>
                          <button type="button" className="sidebar-cta" disabled={projectBusy !== null} onClick={beginCreateProject}>
                            <PlusIcon size={14} />
                            Create Project
                          </button>
                        </div>
                      </div>
                    ) : (
                      // Phase 14.3: only real projects here — the "All projects" row was removed.
                      // Phase 14.4: a clean folder-list row (folder icon + name +
                      // muted path) — no avatar/letter card. Active = subtle gray.
                      projects.map((project) => (
                        <div
                          key={project.id}
                          className={`project-row ${view === 'workspace' && activeProject?.id === project.id ? 'is-active' : ''} ${projectRowMenu?.id === project.id ? 'is-menu-open' : ''}`}
                          title={project.path ?? project.name}
                          role="button"
                          tabIndex={0}
                          onClick={() => renamingProjectId !== project.id && onSelectProject(project)}
                          onKeyDown={(event) => {
                            if (renamingProjectId === project.id) return
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              onSelectProject(project)
                            }
                          }}
                        >
                          <span className="project-row-ico">
                            <FolderIcon size={15} />
                          </span>
                          <span className="project-text">
                            {renamingProjectId === project.id ? (
                              <input
                                className="sidebar-rename-input"
                                value={renameProjectValue}
                                autoFocus
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => setRenameProjectValue(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') void commitProjectRename(project)
                                  if (event.key === 'Escape') setRenamingProjectId(null)
                                }}
                                onBlur={() => void commitProjectRename(project)}
                              />
                            ) : (
                              <>
                                <span>{project.name}</span>
                                {project.path && <em>{project.path}</em>}
                              </>
                            )}
                          </span>
                          <button
                            type="button"
                            className="project-overflow"
                            title="Project actions"
                            aria-haspopup="menu"
                            aria-expanded={projectRowMenu?.id === project.id}
                            onClick={(event) => toggleProjectRowMenu(project.id, event)}
                          >
                            ⋯
                          </button>
                          {projectRowMenu?.id === project.id && (
                            <>
                              <div
                                className="popover-backdrop"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setProjectRowMenu(null)
                                }}
                              />
                              <div
                                className="project-menu project-row-menu"
                                role="menu"
                                style={{ position: 'fixed', top: projectRowMenu.top, right: projectRowMenu.right }}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <button type="button" role="menuitem" onClick={() => beginRenameProject(project)}>
                                  <span>Rename</span>
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={!project.path}
                                  onClick={() => void revealProject(project)}
                                >
                                  <span>Reveal in Finder</span>
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="is-danger"
                                  onClick={() => {
                                    setProjectRowMenu(null)
                                    setConfirmRemoveProject(project)
                                  }}
                                >
                                  <span>Remove from Akorith</span>
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                  {view === 'workspace' && activeProject?.path && <div className="project-agent-hint">Olympus and Atlantis start in this folder.</div>}
                </>
              )}
            </section>

            {folderIds.map((providerId) => {
              const items = generalSessions.filter((s) => s.providerId === providerId)
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
                        <span>No general chats yet</span>
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

          <section className="sidebar-section recent-section">
            <div className="sidebar-section-title">Recent chats</div>
            <div className="recent-list">
              {recentSessions.length === 0 ? (
                <div className="sidebar-item is-empty">No recent chats yet</div>
              ) : (
                recentSessions.map((session) => {
                  const provider = labelOf(session.providerId)
                  const project = session.projectId ? projectById.get(session.projectId) : null
                  const meta = `${project ? `Workspace · ${project.name}` : 'General chat'} · ${provider} · ${formatDate(session.updatedAt)}`
                  return (
                    <div
                      className={`recent-chat ${session.id === activeSessionId ? 'is-active' : ''}`}
                      key={session.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectSession(session)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          selectSession(session)
                        }
                      }}
                      title={`${session.title} — ${meta}`}
                    >
                      <span className="recent-chat-text">
                        <span>{session.title}</span>
                      </span>
                      <span className="sidebar-item-actions">
                        {confirmDeleteId === session.id ? (
                          <button
                            type="button"
                            className="is-danger"
                            title="Click again to delete this chat"
                            onClick={(event) => {
                              event.stopPropagation()
                              void deleteSession(session)
                            }}
                          >
                            Delete?
                          </button>
                        ) : (
                          <button
                            type="button"
                            title="Delete chat"
                            onClick={(event) => {
                              event.stopPropagation()
                              setConfirmDeleteId(session.id)
                              setTimeout(() => setConfirmDeleteId((id) => (id === session.id ? null : id)), 2500)
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </span>
                    </div>
                  )
                })
              )}
            </div>
          </section>
        </div>
      )}

      <div className="sidebar-profile">
        {settingsOpen && (
          <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div
            className="settings-popover"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-header">
              <div className="settings-title">Settings</div>
              <button
                type="button"
                className="settings-close"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close settings"
                title="Close"
              >
                <CloseIcon size={16} />
              </button>
            </div>
            <label>
              <span>Display name</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
            <div className="settings-field">
              <span>Theme</span>
              <div className="theme-toggle" role="group" aria-label="Theme">
                <button
                  type="button"
                  className={theme === 'light' ? 'is-active' : ''}
                  onClick={() => onThemeChange('light')}
                >
                  Light
                </button>
                <button
                  type="button"
                  className={theme === 'dark' ? 'is-active' : ''}
                  onClick={() => onThemeChange('dark')}
                >
                  Dark
                </button>
              </div>
            </div>
            <div className="settings-divider" />
            <div className="settings-field is-stacked">
              <span>Ollama endpoint</span>
              <div className="ollama-endpoint-row">
                <input
                  value={ollamaEndpoint}
                  spellCheck={false}
                  placeholder="http://localhost:11434"
                  onChange={(event) => setOllamaEndpoint(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void testOllamaEndpoint()
                  }}
                />
                <button type="button" onClick={() => setOllamaEndpoint('http://localhost:11434')}>
                  Localhost
                </button>
              </div>
              <div className="ollama-action-row">
                <button type="button" disabled={ollamaBusy !== null} onClick={() => void testOllamaEndpoint()}>
                  {ollamaBusy === 'test' ? 'Testing...' : 'Test'}
                </button>
                <button type="button" className="is-primary" disabled={ollamaBusy !== null || !ollamaSettings} onClick={() => void saveOllamaSettings()}>
                  {ollamaBusy === 'save' ? 'Saving...' : 'Save'}
                </button>
              </div>
              {shareEndpoints.length > 0 && (
                <div className="ollama-share-box">
                  <div className="ollama-share-title">
                    <span>This machine</span>
                    {ollamaShare?.hostName && <em>{ollamaShare.hostName}</em>}
                  </div>
                  <div className="ollama-endpoint-list">
                    {shareEndpoints.map((endpoint) => (
                      <div className={`ollama-endpoint-card is-${endpoint.kind}`} key={endpoint.baseUrl}>
                        <button type="button" className="ollama-endpoint-main" onClick={() => useOllamaEndpoint(endpoint)}>
                          <span>{endpoint.label}</span>
                          <em>{endpoint.baseUrl}</em>
                        </button>
                        <button type="button" className="ollama-copy-btn" onClick={() => void copyOllamaEndpoint(endpoint)}>
                          Copy
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {ollamaStatus && <div className={`ollama-status is-${ollamaStatus.kind}`}>{ollamaStatus.text}</div>}
              {localProvider && !localProvider.available.ok && <div className="ollama-status is-error">{localProvider.available.reason}</div>}
            </div>
            {ollamaSettings && (
              <div className="settings-checks">
                <label>
                  <input
                    type="checkbox"
                    checked={ollamaSettings.autoStart}
                    onChange={(event) => updateOllamaSetting('autoStart', event.target.checked)}
                  />
                  <span>Auto-start local Ollama</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={ollamaSettings.exposeLan}
                    onChange={(event) => updateOllamaSetting('exposeLan', event.target.checked)}
                  />
                  <span>Expose local Ollama on LAN</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={ollamaSettings.lanDiscovery}
                    onChange={(event) => updateOllamaSetting('lanDiscovery', event.target.checked)}
                  />
                  <span>Discover LAN Ollama hosts</span>
                </label>
              </div>
            )}
            <div className="settings-note">Package identity cleanup remains Phase 10.</div>
          </div>
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

      {confirmRemoveProject && (
        <div className="modal-overlay" onClick={() => setConfirmRemoveProject(null)}>
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="Remove project"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-title">Remove “{confirmRemoveProject.name}”?</div>
            <p className="modal-subtitle">
              This removes the project from Akorith. It does not delete files from disk. The project’s workspace
              chats are also removed from Akorith.
            </p>
            <div className="modal-actions">
              <button type="button" className="modal-cancel" onClick={() => setConfirmRemoveProject(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="modal-confirm is-danger"
                onClick={() => void removeProject(confirmRemoveProject)}
              >
                Remove from Akorith
              </button>
            </div>
          </div>
        </div>
      )}

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
