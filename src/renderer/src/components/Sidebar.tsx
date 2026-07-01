import { type CSSProperties, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectRow, ProviderInfo, SessionRow, StartupSnapshot } from '../../../preload/index.d'
import type { AppTheme, AppView } from '../App'
import {
  AgentsIcon,
  ChartIcon,
  ChevronIcon,
  CompanionsIcon,
  FlaskIcon,
  FolderIcon,
  FolderOpenIcon,
  LoopIcon,
  PanelsIcon,
  PluginIcon,
  PlusIcon,
  SettingsIcon,
  UserIcon
} from './icons'
import SettingsCenter from './SettingsCenter'

interface SidebarProps {
  view: AppView
  theme: AppTheme
  onThemeChange: (theme: AppTheme) => void
  onNavigate: (view: AppView) => void
  historyVersion: number
  projectVersion: number
  startupSnapshot: StartupSnapshot | null
  startupHydrated: boolean
  startupError: string | null
  onRetryStartupHydration: () => void
  activeSessionId: string | null
  activeProject: ProjectRow | null
  /** Bumped by the center empty-state "Create Project" button to open the modal. */
  createSignal?: number
  onSelectProject: (project: ProjectRow | null) => void
  onSelectSession: (sessionId: string, project?: ProjectRow | null, providerId?: string) => void
  onNewChat: (providerId: string) => void
  /** Phase 14.1: the top "New chat" action — always opens a fresh general chat. */
  onNewGeneralChat: () => void
  /** Phase 33.6: start a fresh chat inside a specific project (multi-chat). */
  onNewProjectChat: (project: ProjectRow) => void
  onHistoryChange: () => void
  onProjectsChange: () => void
}

// Phase 14.1: the separate "Chat" nav item is gone; a "New chat" action sits
// above Workspace instead (see below). Workspace stays project-scoped.
const NAV_ITEMS: { view: AppView; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { view: 'workspace', label: 'Workspace', icon: PanelsIcon },
  { view: 'loops', label: 'Loop', icon: LoopIcon },
  { view: 'dashboard', label: 'Dashboard', icon: ChartIcon },
  { view: 'test', label: 'Test', icon: FlaskIcon },
  { view: 'plugins', label: 'Plugins', icon: PluginIcon },
  { view: 'companions', label: 'Companions', icon: CompanionsIcon },
  { view: 'agents', label: 'Agents', icon: AgentsIcon }
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

function storageNumber(key: string, fallback: number): number {
  try {
    const raw = Number(localStorage.getItem(key))
    return Number.isFinite(raw) && raw > 0 ? raw : fallback
  } catch {
    return fallback
  }
}

// Phase 38.3: keep the sidebar between a usable min and a cap that never crowds
// the workspace (the smaller of 520px / 40vw).
const SIDEBAR_MIN = 240
const SIDEBAR_DEFAULT = 292
function clampSidebarWidth(value: number): number {
  const max = Math.min(520, Math.round((typeof window !== 'undefined' ? window.innerWidth : 1280) * 0.4))
  return Math.min(Math.max(value, SIDEBAR_MIN), Math.max(max, SIDEBAR_MIN))
}

function initialSidebarWidth(): number {
  const stored = storageNumber('akorith.sidebarWidth', SIDEBAR_DEFAULT)
  return clampSidebarWidth(stored > 312 ? SIDEBAR_DEFAULT : stored)
}

function hasLocalAutoStarting(providers: ProviderInfo[]): boolean {
  return providers.some((provider) =>
    provider.id === 'local' &&
    !provider.available.ok &&
    /Akorith (is starting Ollama|tried to auto-start it)/i.test(provider.available.reason ?? '')
  )
}

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ts))
}

// Phase 34.3: compact relative age for chat rows (Codex-like "3d", "1w").
function relativeShort(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000)
  if (seconds < 60) return 'now'
  const minutes = seconds / 60
  if (minutes < 60) return `${Math.round(minutes)}m`
  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours)}h`
  const days = hours / 24
  if (days < 7) return `${Math.round(days)}d`
  const weeks = days / 7
  if (weeks < 5) return `${Math.round(weeks)}w`
  const months = days / 30
  if (months < 12) return `${Math.round(months)}mo`
  return `${Math.round(days / 365)}y`
}

export default function Sidebar({
  view,
  theme,
  onThemeChange,
  onNavigate,
  historyVersion,
  projectVersion,
  startupSnapshot,
  startupHydrated,
  startupError,
  onRetryStartupHydration,
  activeSessionId,
  activeProject,
  createSignal,
  onSelectProject,
  onSelectSession,
  onNewChat,
  onNewGeneralChat,
  onNewProjectChat,
  onHistoryChange,
  onProjectsChange
}: SidebarProps): JSX.Element {
  // Folders come from the registry + DB — never a hardcoded provider list.
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [projects, setProjects] = useState<ProjectRow[]>([])
  // Phase 33.5: which projects are expanded to reveal their chats. Persisted so
  // the tree shape survives reloads. A project absent from the map is collapsed.
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('akorith.expandedProjects')
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
    } catch {
      return {}
    }
  })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => storageBoolean('akorith.sidebarCollapsed', false))
  const [sidebarPeeking, setSidebarPeeking] = useState(false)
  // Phase 38.3: user-resizable sidebar width (persisted, bounded).
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  // Phase 14.3/14.4: per-project overflow menu + inline rename + remove confirm.
  // The menu is rendered fixed-position (anchored to the clicked button's rect)
  // so the Projects list's own `overflow-y: auto` cannot clip it.
  const [projectRowMenu, setProjectRowMenu] = useState<string | null>(null)
  // Phase 37.4: per-chat overflow menu (Rename / Delete) — replaces inline text.
  const [chatRowMenu, setChatRowMenu] = useState<string | null>(null)
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

  const loadProviders = useCallback(() => {
    window.api.chat
      .listProviders()
      .then(setProviders)
      .catch(() => setProviders([]))
  }, [])

  useEffect(() => {
    loadProviders()
  }, [loadProviders])

  useEffect(() => {
    if (!settingsOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen])

  useEffect(() => {
    if (!hasLocalAutoStarting(providers)) return
    const timer = window.setTimeout(loadProviders, 3000)
    return () => window.clearTimeout(timer)
  }, [providers, loadProviders])

  useEffect(() => {
    if (!startupSnapshot) return
    setSessions(startupSnapshot.sessions)
    setProjects(startupSnapshot.projects)
    setExpandedProjects((current) => {
      const projectIds = new Set(startupSnapshot.projects.map((project) => project.id))
      let changed = false
      const next = { ...current }
      for (const session of startupSnapshot.sessions) {
        if (!session.projectId || !projectIds.has(session.projectId) || next[session.projectId] !== undefined) continue
        next[session.projectId] = true
        changed = true
      }
      if (startupSnapshot.restore.projectId && next[startupSnapshot.restore.projectId] !== true) {
        next[startupSnapshot.restore.projectId] = true
        changed = true
      }
      return changed ? next : current
    })
  }, [startupSnapshot])

  useEffect(() => {
    if (!startupHydrated) return
    window.api.history
      .list()
      .then(setSessions)
      .catch(() => setSessions([]))
  }, [historyVersion, startupHydrated])

  useEffect(() => {
    if (!startupHydrated) return
    window.api.projects
      .list()
      .then(setProjects)
      .catch(() => setProjects([]))
  }, [projectVersion, startupHydrated])

  useEffect(() => {
    localStorage.setItem('akorith.sidebarCollapsed', String(sidebarCollapsed))
  }, [sidebarCollapsed])

  useEffect(() => {
    localStorage.setItem('akorith.sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])

  // Phase 38.3: drag the right edge to resize the open sidebar.
  const startSidebarResize = (event: ReactMouseEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    const move = (moveEvent: MouseEvent): void => {
      setSidebarWidth(clampSidebarWidth(startWidth + (moveEvent.clientX - startX)))
    }
    const stop = (): void => {
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
  }

  useEffect(() => {
    localStorage.setItem('akorith.expandedProjects', JSON.stringify(expandedProjects))
  }, [expandedProjects])

  useEffect(() => {
    localStorage.setItem('akorith.displayName', displayName)
  }, [displayName])

  // Close row actions on Escape. These menus render inside the sidebar, avoiding
  // the full-window portal/backdrop path that could blank the app.
  useEffect(() => {
    if (!projectRowMenu) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setProjectRowMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [projectRowMenu])

  useEffect(() => {
    if (!chatRowMenu) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setChatRowMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chatRowMenu])

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const labelOf = (id: string): string => providers.find((p) => p.id === id)?.label ?? id

  // Phase 33.5: chats grouped by their owning project (newest first, mirroring
  // history.list ordering). Used to render each project's chat threads inline.
  const sessionsByProject = useMemo(() => {
    const map = new Map<string, SessionRow[]>()
    for (const session of sessions) {
      if (!session.projectId) continue
      const list = map.get(session.projectId) ?? []
      list.push(session)
      map.set(session.projectId, list)
    }
    return map
  }, [sessions])

  // Phase 33.6: general chats are everything without a (still-existing) project —
  // this also surfaces orphaned workspace chats whose project was removed, so no
  // history silently disappears now that provider folders are gone.
  const generalSessions = sessions.filter((s) => !s.projectId || !projectById.has(s.projectId))

  const toggleProjectExpanded = (projectId: string): void => {
    setExpandedProjects((current) => ({ ...current, [projectId]: !(current[projectId] ?? false) }))
  }

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

  // Phase 37.2: copy the project's folder path to the clipboard.
  const copyProjectPath = async (project: ProjectRow): Promise<void> => {
    setProjectRowMenu(null)
    if (!project.path) return
    try {
      await navigator.clipboard.writeText(project.path)
    } catch {
      /* ignore */
    }
  }

  const toggleProjectRowMenu = (projectId: string, event: ReactMouseEvent): void => {
    event.stopPropagation()
    setChatRowMenu(null)
    setProjectRowMenu((current) => (current === projectId ? null : projectId))
  }

  const toggleChatRowMenu = (chatId: string, event: ReactMouseEvent): void => {
    event.stopPropagation()
    setProjectRowMenu(null)
    setChatRowMenu((current) => (current === chatId ? null : chatId))
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

  const pinSidebar = (): void => {
    setSidebarPeeking(false)
    setSidebarCollapsed(false)
  }

  const revealSidebar = (): void => {
    if (sidebarCollapsed) setSidebarPeeking(true)
  }

  const closeSidebar = (): void => {
    setSettingsOpen(false)
    setSidebarPeeking(false)
    setSidebarCollapsed(true)
  }

  useEffect(() => {
    const onToggle = (): void => {
      setSidebarPeeking(false)
      setSidebarCollapsed((value) => !value)
    }
    window.addEventListener('akorith:toggle-sidebar', onToggle)
    return () => window.removeEventListener('akorith:toggle-sidebar', onToggle)
  }, [])

  const handleSidebarLeave = (): void => {
    if (sidebarCollapsed && !settingsOpen && !createOpen && !confirmRemoveProject && !projectMenuOpen && !projectRowMenu) {
      setSidebarPeeking(false)
    }
  }

  return (
    <>
      {sidebarCollapsed && (
        <div
          className="sidebar-hover-zone"
          onMouseEnter={revealSidebar}
          onMouseMove={revealSidebar}
          onPointerEnter={revealSidebar}
          onPointerMove={revealSidebar}
        />
      )}

      <aside
        className={`sidebar ${sidebarCollapsed ? 'is-collapsed' : 'is-pinned'} ${sidebarPeeking ? 'is-peeking' : ''}`}
        style={{ ['--sidebar-width' as string]: `${sidebarWidth}px` } as CSSProperties}
        onMouseEnter={revealSidebar}
        onPointerEnter={revealSidebar}
        onMouseLeave={handleSidebarLeave}
      >
        {!sidebarCollapsed && (
          <div
            className="sidebar-resize-handle"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize · double-click to reset"
            onMouseDown={startSidebarResize}
            onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
          />
        )}
        <div
          className="sidebar-surface"
          aria-hidden={sidebarCollapsed && !sidebarPeeking}
          onMouseEnter={revealSidebar}
          onPointerEnter={revealSidebar}
          onMouseLeave={handleSidebarLeave}
        >
      {/* The top chrome owns sidebar collapse; this nav stays focused on
          destinations and creation. */}
      <nav className="sidebar-nav" aria-label="Primary">
        <div className="sidebar-newchat-row">
          <button
            type="button"
            className={`sidebar-newchat ${view === 'general' ? 'is-active' : ''}`}
            onClick={onNewGeneralChat}
            title="Start a fresh general chat"
          >
            <PlusIcon size={16} />
            <span>New chat</span>
          </button>
        </div>
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
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar-scroll">
        <div className="sidebar-fixed-groups">
          <section className="sidebar-section project-section">
            {/* Phase 36.2: "Projects" is a plain heading, not a collapsible folder.
                The list below is always visible inside the scroll area. */}
            <div className="sidebar-section-header projects-heading">
              <div className="projects-heading-label">
                Projects
                {projects.length > 0 && <span className="sidebar-count">{projects.length}</span>}
              </div>
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
            <>
                {projectBusy === 'open' && <div className="sidebar-item is-empty">Opening project…</div>}
                {projectError && !createOpen && <div className="project-onboarding-error">{projectError}</div>}
                <div className="project-list">
                  {!startupHydrated ? (
                    <div className="sidebar-empty-state is-loading">
                      <p>Loading workspace...</p>
                    </div>
                  ) : startupError ? (
                    <div className="sidebar-empty-state">
                      <p>Workspace data could not load.</p>
                      <div className="sidebar-empty-actions">
                        <button type="button" className="sidebar-cta is-primary" onClick={onRetryStartupHydration}>
                          Retry
                        </button>
                      </div>
                    </div>
                  ) : projects.length === 0 ? (
                    <div className="sidebar-empty-state">
                      <p>No projects yet. Pick a folder — Akorith starts Codex, OpenCode, and Claude there.</p>
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
                    projects.map((project) => {
                      const chats = sessionsByProject.get(project.id) ?? []
                      const isExpanded = expandedProjects[project.id] ?? false
                      const isActiveProject = view === 'workspace' && activeProject?.id === project.id
                      return (
                        <div className={`project-group ${isExpanded ? 'is-expanded' : ''}`} key={project.id}>
                          <div
                            className={`project-row ${isActiveProject ? 'is-active' : ''} ${projectRowMenu === project.id ? 'is-menu-open' : ''}`}
                            title={project.path ?? project.name}
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              if (renamingProjectId === project.id) return
                              onSelectProject(project)
                              setExpandedProjects((current) => ({ ...current, [project.id]: true }))
                            }}
                            onKeyDown={(event) => {
                              if (renamingProjectId === project.id) return
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                onSelectProject(project)
                                setExpandedProjects((current) => ({ ...current, [project.id]: true }))
                              }
                            }}
                          >
                            {/* Phase 38.6: a folder icon (open when expanded) replaces the
                                chevron — the row reads as a folder, and the icon toggles
                                the chat list. */}
                            <button
                              type="button"
                              className="project-disclosure"
                              title={isExpanded ? 'Collapse chats' : 'Expand chats'}
                              aria-expanded={isExpanded}
                              onClick={(event) => {
                                event.stopPropagation()
                                toggleProjectExpanded(project.id)
                              }}
                            >
                              {isExpanded ? <FolderOpenIcon size={15} /> : <FolderIcon size={15} />}
                            </button>
                            {/* Phase 34.2: no folder icon / no path subtitle — a calm,
                                text-focused row. The full path lives in the row's
                                hover title (set on the row above). */}
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
                                <span className="project-name">{project.name}</span>
                              )}
                            </span>
                            {/* Phase 38.5: per-project chat count badge removed. */}
                            <span className="project-row-actions">
                              <button
                                type="button"
                                className="project-newchat-icon"
                                title={`New chat in ${project.name}`}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setExpandedProjects((current) => ({ ...current, [project.id]: true }))
                                  onNewProjectChat(project)
                                }}
                              >
                                <PlusIcon size={13} />
                              </button>
                              <button
                                type="button"
                                className="project-overflow"
                                title="Project actions"
                                aria-haspopup="menu"
                                aria-expanded={projectRowMenu === project.id}
                                onClick={(event) => toggleProjectRowMenu(project.id, event)}
                              >
                                ⋯
                              </button>
                            </span>
                            {projectRowMenu === project.id && (
                              <div className="project-menu project-row-menu" role="menu" onClick={(event) => event.stopPropagation()}>
                                <button type="button" role="menuitem" onClick={() => beginRenameProject(project)}>
                                  <span>Rename</span>
                                </button>
                                <button type="button" role="menuitem" disabled={!project.path} onClick={() => void revealProject(project)}>
                                  <span>Reveal in Finder</span>
                                </button>
                                <button type="button" role="menuitem" disabled={!project.path} onClick={() => void copyProjectPath(project)}>
                                  <span>Copy path</span>
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
                            )}
                          </div>
                          {isExpanded && (
                            <div className="project-chats">
                              {chats.map((chat) =>
                                renamingId === chat.id ? (
                                  <div className="project-chat" key={chat.id}>
                                    <input
                                      className="sidebar-rename-input"
                                      value={renameValue}
                                      autoFocus
                                      onChange={(event) => setRenameValue(event.target.value)}
                                      onKeyDown={(event) => {
                                        if (event.key === 'Enter') void commitRename(chat.id)
                                        if (event.key === 'Escape') setRenamingId(null)
                                      }}
                                      onBlur={() => void commitRename(chat.id)}
                                    />
                                  </div>
                                ) : (
                                  <div
                                    className={`project-chat ${chat.id === activeSessionId ? 'is-active' : ''} ${chatRowMenu === chat.id ? 'is-menu-open' : ''}`}
                                    key={chat.id}
                                    role="button"
                                    tabIndex={0}
                                    title={chat.title}
                                    onClick={() => selectSession(chat)}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault()
                                        selectSession(chat)
                                      }
                                    }}
                                  >
                                    <span className="project-chat-title">{chat.title}</span>
                                    <span className="project-chat-time">{relativeShort(chat.updatedAt)}</span>
                                    {/* Phase 37.4: actions via a small ⋯ menu, not inline text. */}
                                    <button
                                      type="button"
                                      className="project-chat-overflow"
                                      title="Chat actions"
                                      aria-haspopup="menu"
                                      aria-expanded={chatRowMenu === chat.id}
                                      onClick={(event) => toggleChatRowMenu(chat.id, event)}
                                    >
                                      ⋯
                                    </button>
                                    {chatRowMenu === chat.id && (
                                      <div className="project-menu project-row-menu" role="menu" onClick={(event) => event.stopPropagation()}>
                                        <button
                                          type="button"
                                          role="menuitem"
                                          onClick={() => {
                                            setChatRowMenu(null)
                                            setRenamingId(chat.id)
                                            setRenameValue(chat.title)
                                          }}
                                        >
                                          <span>Rename</span>
                                        </button>
                                        <button
                                          type="button"
                                          role="menuitem"
                                          className="is-danger"
                                          onClick={() => {
                                            setChatRowMenu(null)
                                            void deleteSession(chat)
                                          }}
                                        >
                                          <span>Delete chat</span>
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )
                              )}
                              {startupHydrated && chats.length === 0 && <div className="project-chats-empty">No chats yet</div>}
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
                {view === 'workspace' && activeProject?.path && <div className="project-agent-hint">Olympus, Gaia, and Atlantis start in this folder.</div>}
              </>
          </section>

          {/* Phase 33.4: provider folders (Claude / Codex / Local) are removed from
              the sidebar. The sidebar is project-first now; provider/model choice
              lives in the composer model picker, Agent Hub, and Settings. General
              chats are listed in their own borderless section below. */}
        </div>

        <section className="sidebar-section recent-section">
          <div className="sidebar-section-header">
            <div className="sidebar-section-title">Chats</div>
            <button
              type="button"
              className="sidebar-add"
              title="Start a new chat"
              onClick={onNewGeneralChat}
            >
              <PlusIcon size={14} />
            </button>
          </div>
          <div className="recent-list">
            {!startupHydrated ? (
              <div className="sidebar-item is-empty">Loading chats...</div>
            ) : startupError ? (
              <button type="button" className="sidebar-item is-empty" onClick={onRetryStartupHydration}>
                Retry loading chats
              </button>
            ) : generalSessions.length === 0 ? (
              <div className="sidebar-item is-empty">No chats yet</div>
            ) : (
              generalSessions.map((session) => {
                const provider = labelOf(session.providerId)
                const orphaned = Boolean(session.projectId)
                const meta = `${orphaned ? 'Removed project' : 'General chat'} · ${provider} · ${formatDate(session.updatedAt)}`
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

      <div className="sidebar-profile">
        <button type="button" className="profile-button" onClick={() => setSettingsOpen((value) => !value)} title="Settings">
          <UserIcon size={17} />
          <span>
            <strong>{displayName.trim() || 'User'}</strong>
            <em>Local profile</em>
          </span>
          <SettingsIcon size={16} />
        </button>
      </div>
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

      {settingsOpen && (
        <div className="settings-page-host">
          <SettingsCenter
            theme={theme}
            displayName={displayName}
            providers={providers}
            onThemeChange={onThemeChange}
            onDisplayNameChange={setDisplayName}
            onRefreshProviders={loadProviders}
            onClose={() => setSettingsOpen(false)}
          />
        </div>
      )}
    </>
  )
}
