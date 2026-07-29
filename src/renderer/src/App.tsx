import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'
import Sidebar from './components/Sidebar'
import ChatPanel from './components/ChatPanel'
import { ChevronIcon, PanelsIcon } from './components/icons'
import type {
  WorkspaceToolId,
  WorkspaceToolRequest
} from './components/WorkspaceToolsPanel'
import type { ProjectRow, SessionRow, StartupSnapshot, StartupSnapshotRequest } from '../../preload/index.d'

const Dashboard = lazy(() => import('./components/Dashboard'))
const Plugins = lazy(() => import('./components/Plugins'))
const TestPage = lazy(() => import('./components/TestPage'))
const ResearchPage = lazy(() => import('./components/ResearchPage'))
const WorkspaceToolsPanel = lazy(() => import('./components/WorkspaceToolsPanel'))

export type ChatMode = 'workspace' | 'general'
export type AppView = ChatMode | 'dashboard' | 'test' | 'research' | 'plugins'
export type AppTheme = 'dark' | 'light'

const PERSISTENT_FEATURE_VIEWS = new Set<AppView>(['test', 'research'])

function FeaturePageFallback({ label }: { label: string }): JSX.Element {
  return (
    <div className="feature-page-loading" role="status" aria-live="polite">
      <span>{label}</span>
    </div>
  )
}

/** A sidebar→chat instruction: load a session (id) or start fresh (null). */
export interface HistorySelection {
  sessionId: string | null
  providerId?: string
  mode: ChatMode
  nonce: number
}

function initialChromeSidebarWidth(): number {
  try {
    if (localStorage.getItem('akorith.replicaSidebarVersion') !== '1') {
      localStorage.setItem('akorith.sidebarWidth', '266')
      localStorage.setItem('akorith.replicaSidebarVersion', '1')
    }
    if (window.innerWidth <= 720) return 0
    if (localStorage.getItem('akorith.sidebarCollapsed') === 'true') return 0
    const raw = Number(localStorage.getItem('akorith.sidebarWidth'))
    return Number.isFinite(raw) && raw > 0 && raw <= 520 ? raw : 266
  } catch {
    return 266
  }
}

type NativeMenuId = 'file' | 'edit' | 'view' | 'help'

function AppChrome({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onNewChat,
  onOpenProject,
  onOpenSettings,
  theme,
  onThemeChange,
  pendingCount
}: {
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onNewChat: () => void
  onOpenProject: () => void
  onOpenSettings: () => void
  theme: AppTheme
  onThemeChange: (theme: AppTheme) => void
  pendingCount: number
}): JSX.Element {
  const hasWindowControls = Boolean(window.api?.windowControls) && /Mac/i.test(navigator.platform)
  const [openMenu, setOpenMenu] = useState<NativeMenuId | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const lastEditableRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const rememberEditable = (event: FocusEvent): void => {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) {
        lastEditableRef.current = target
      }
    }
    document.addEventListener('focusin', rememberEditable)
    return () => document.removeEventListener('focusin', rememberEditable)
  }, [])

  useEffect(() => {
    if (!openMenu) return
    const menu = openMenu
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpenMenu(null)
      window.requestAnimationFrame(() => document.getElementById(`app-menu-trigger-${menu}`)?.focus())
    }
    window.addEventListener('keydown', close)
    window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus())
    return () => window.removeEventListener('keydown', close)
  }, [openMenu])

  const activate = (action?: () => void | Promise<void>): void => {
    void action?.()
    setOpenMenu(null)
  }

  const dismissMenu = (): void => {
    const menu = openMenu
    setOpenMenu(null)
    if (menu) window.requestAnimationFrame(() => document.getElementById(`app-menu-trigger-${menu}`)?.focus())
  }

  const runEditCommand = async (command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): Promise<void> => {
    const target = lastEditableRef.current
    target?.focus()
    if (command !== 'paste') {
      document.execCommand(command)
      return
    }
    try {
      const text = await navigator.clipboard.readText()
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const start = target.selectionStart ?? target.value.length
        const end = target.selectionEnd ?? start
        target.setRangeText(text, start, end, 'end')
        target.dispatchEvent(new Event('input', { bubbles: true }))
        return
      }
      if (target?.isContentEditable) {
        document.execCommand('insertText', false, text)
        return
      }
    } catch {
      // The native command is still useful on hosts where clipboard read is
      // unavailable but Electron grants paste to the focused editor.
    }
    document.execCommand('paste')
  }

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    let next = current
    if (event.key === 'ArrowDown') next = current < items.length - 1 ? current + 1 : 0
    else if (event.key === 'ArrowUp') next = current > 0 ? current - 1 : items.length - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'Tab') {
      setOpenMenu(null)
      return
    } else {
      return
    }
    event.preventDefault()
    items[next]?.focus()
  }

  return (
    <header className="app-chrome">
      {hasWindowControls && (
        <div className="app-window-controls" aria-label="Window controls">
          <button
            type="button"
            className="app-window-control is-close"
            aria-label="Close window"
            title="Close"
            onClick={() => void window.api.windowControls.close()}
          />
          <button
            type="button"
            className="app-window-control is-minimize"
            aria-label="Minimize window"
            title="Minimize"
            onClick={() => void window.api.windowControls.minimize()}
          />
          <button
            type="button"
            className="app-window-control is-fullscreen"
            aria-label="Toggle fullscreen"
            title="Fullscreen"
            onClick={() => void window.api.windowControls.toggleFullscreen()}
          />
        </div>
      )}
      <div className="app-chrome-left">
        <button
          type="button"
          className="app-chrome-icon"
          title="Toggle sidebar"
          onClick={() => window.dispatchEvent(new Event('akorith:toggle-sidebar'))}
        >
          <PanelsIcon size={14} />
        </button>
        <button type="button" className="app-chrome-nav" title="Back" disabled={!canGoBack} onClick={onBack}>
          <ChevronIcon size={15} direction="left" />
        </button>
        <button type="button" className="app-chrome-nav" title="Forward" disabled={!canGoForward} onClick={onForward}>
          <ChevronIcon size={15} direction="right" />
        </button>
        <nav className="app-native-menus" aria-label="Application menu">
          {(['file', 'edit', 'view', 'help'] as NativeMenuId[]).map((menu) => (
            <button
              type="button"
              key={menu}
              id={`app-menu-trigger-${menu}`}
              className={openMenu === menu ? 'is-open' : ''}
              aria-haspopup="menu"
              aria-expanded={openMenu === menu}
              aria-controls={openMenu === menu ? `app-menu-${menu}` : undefined}
              onClick={() => setOpenMenu((current) => current === menu ? null : menu)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setOpenMenu(menu)
                }
              }}
            >
              {menu[0].toUpperCase() + menu.slice(1)}
            </button>
          ))}
        </nav>
      </div>
      <div className="app-chrome-drag-region" />
      <div className="app-chrome-right">
        {pendingCount > 0 && <span className="app-working-indicator"><i />{pendingCount} working</span>}
      </div>
      {openMenu && (
        <>
          <button type="button" className="app-native-menu-backdrop" aria-label="Close menu" onClick={dismissMenu} />
          <div
            ref={menuRef}
            id={`app-menu-${openMenu}`}
            className={`app-native-menu is-${openMenu}`}
            role="menu"
            aria-labelledby={`app-menu-trigger-${openMenu}`}
            onKeyDown={handleMenuKeyDown}
          >
            {openMenu === 'file' && (
              <>
                <button type="button" role="menuitem" onClick={() => activate(onNewChat)}><span>New chat</span><kbd>Ctrl+N</kbd></button>
                <button type="button" role="menuitem" onClick={() => activate(onOpenProject)}><span>Open project</span><kbd>Ctrl+O</kbd></button>
                <div className="app-native-menu-rule" />
                <button type="button" role="menuitem" onClick={() => activate(onOpenSettings)}><span>Settings</span><kbd>Ctrl+,</kbd></button>
              </>
            )}
            {openMenu === 'edit' && (
              <>
                <button type="button" role="menuitem" onClick={() => activate(() => runEditCommand('undo'))}><span>Undo</span><kbd>Ctrl+Z</kbd></button>
                <button type="button" role="menuitem" onClick={() => activate(() => runEditCommand('redo'))}><span>Redo</span><kbd>Ctrl+Y</kbd></button>
                <div className="app-native-menu-rule" />
                <button type="button" role="menuitem" onClick={() => activate(() => runEditCommand('cut'))}><span>Cut</span><kbd>Ctrl+X</kbd></button>
                <button type="button" role="menuitem" onClick={() => activate(() => runEditCommand('copy'))}><span>Copy</span><kbd>Ctrl+C</kbd></button>
                <button type="button" role="menuitem" onClick={() => activate(() => runEditCommand('paste'))}><span>Paste</span><kbd>Ctrl+V</kbd></button>
                <button type="button" role="menuitem" onClick={() => activate(() => runEditCommand('selectAll'))}><span>Select all</span><kbd>Ctrl+A</kbd></button>
              </>
            )}
            {openMenu === 'view' && (
              <>
                <button type="button" role="menuitem" onClick={() => activate(() => { window.dispatchEvent(new Event('akorith:toggle-sidebar')) })}><span>Sidebar</span><kbd>Ctrl+B</kbd></button>
                <button type="button" role="menuitem" onClick={() => activate(() => onThemeChange(theme === 'dark' ? 'light' : 'dark'))}><span>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span><kbd /></button>
              </>
            )}
            {openMenu === 'help' && (
              <>
                <button type="button" role="menuitem" onClick={() => activate(onOpenSettings)}><span>Keyboard shortcuts</span><kbd>Ctrl+/</kbd></button>
                <button type="button" role="menuitem" onClick={() => activate(onOpenSettings)}><span>Troubleshooting</span><kbd /></button>
              </>
            )}
          </div>
        </>
      )}
    </header>
  )
}

function SurfaceToolbar({
  title,
  scope,
  showWorkbench,
  workbenchOpen,
  onToggleWorkbench
}: {
  title?: string
  scope?: string
  showWorkbench: boolean
  workbenchOpen: boolean
  onToggleWorkbench: () => void
}): JSX.Element {
  return (
    <header className="app-surface-toolbar">
      <div className="app-surface-toolbar-left">
        {title && <strong>{title}</strong>}
        {scope && <span>{scope}</span>}
      </div>
      <div className="app-surface-toolbar-right">
        {showWorkbench && !workbenchOpen && (
          <button
            type="button"
            aria-label="Open workspace tools"
            title="Open workspace tools"
            onClick={onToggleWorkbench}
          >
            <PanelsIcon size={15} />
          </button>
        )}
      </div>
    </header>
  )
}

function readStartupRequest(): StartupSnapshotRequest {
  try {
    return {
      lastActiveProjectId: localStorage.getItem('akorith.lastActiveProjectId'),
      lastActiveSessionId: localStorage.getItem('akorith.lastActiveSessionId'),
      lastView: localStorage.getItem('akorith.lastView'),
      sidebarWidth: localStorage.getItem('akorith.sidebarWidth'),
      displayName: localStorage.getItem('akorith.displayName')
    }
  } catch {
    return {}
  }
}

function latestSessionFrom(sessions: SessionRow[], projectId: string | null): SessionRow | null {
  return sessions.find((session) => session.projectId === projectId) ?? null
}

export default function App(): JSX.Element {
  const [view, setView] = useState<AppView>('workspace')
  const [mountedFeatureViews, setMountedFeatureViews] = useState<Set<AppView>>(() => new Set())
  const [theme, setTheme] = useState<AppTheme>(() => {
    try {
      return localStorage.getItem('akorith.theme') === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })
  const [historyVersion, setHistoryVersion] = useState(0)
  const [workspaceContentVersion, setWorkspaceContentVersion] = useState(0)
  const [projectVersion, setProjectVersion] = useState(0)
  const [startupSnapshot, setStartupSnapshot] = useState<StartupSnapshot | null>(null)
  const [startupHydrated, setStartupHydrated] = useState(false)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [startupRetry, setStartupRetry] = useState(0)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const updateActiveSessionId = useCallback((sessionId: string | null): void => {
    activeSessionIdRef.current = sessionId
    setActiveSessionId(sessionId)
  }, [])
  const [activeProject, setActiveProject] = useState<ProjectRow | null>(null)
  const [historySel, setHistorySel] = useState<HistorySelection | null>(null)
  const [workbenchOpen, setWorkbenchOpen] = useState(() => {
    try { return localStorage.getItem('akorith.workspaceToolsOpen') === 'true' } catch { return false }
  })
  const [workspaceToolRequest, setWorkspaceToolRequest] = useState<WorkspaceToolRequest | null>(null)
  const [toolAutoOpenBlocked, setToolAutoOpenBlocked] = useState(false)
  const [chromeSidebarWidth, setChromeSidebarWidth] = useState(initialChromeSidebarWidth)
  const [navBackStack, setNavBackStack] = useState<AppView[]>([])
  const [navForwardStack, setNavForwardStack] = useState<AppView[]>([])
  const lastViewRef = useRef<AppView>('workspace')
  const navTravelRef = useRef<'back' | 'forward' | null>(null)
  // Lets the center empty-state "Create Project" button open the sidebar modal.
  const [createSignal, setCreateSignal] = useState(0)
  // Phase 38.9: durable "a request is in flight for this session" set, owned by
  // App so it survives ChatPanel re-selection/navigation. Keyed by session id.
  const [pendingSessions, setPendingSessions] = useState<Set<string>>(() => new Set())
  const setSessionPending = useCallback((sessionId: string, pending: boolean) => {
    setPendingSessions((prev) => {
      if (pending === prev.has(sessionId)) return prev
      const next = new Set(prev)
      if (pending) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }, [])

  useEffect(() => {
    if (pendingSessions.size === 0) setToolAutoOpenBlocked(false)
  }, [pendingSessions.size])

  const requestWorkspaceTool = useCallback((request: {
    projectId: string
    sessionId: string
    requestId: string
    tool: WorkspaceToolId
    reason: 'activity' | 'changes'
  }): void => {
    if (
      toolAutoOpenBlocked ||
      (request.reason === 'activity' && request.tool === 'terminal') ||
      view !== 'workspace' ||
      activeProject?.id !== request.projectId ||
      activeSessionIdRef.current !== request.sessionId
    ) return
    setWorkbenchOpen(true)
    setWorkspaceToolRequest((current) => ({
      projectId: request.projectId,
      tool: request.tool,
      nonce: (current?.nonce ?? 0) + 1
    }))
  }, [activeProject?.id, toolAutoOpenBlocked, view])

  const toggleWorkspaceTools = useCallback((): void => {
    if (!activeProject?.path) return
    if (workbenchOpen) {
      if (pendingSessions.size > 0) setToolAutoOpenBlocked(true)
      setWorkbenchOpen(false)
      return
    }
    setToolAutoOpenBlocked(false)
    setWorkbenchOpen(true)
  }, [activeProject?.path, pendingSessions.size, workbenchOpen])

  const openWorkspaceTools = useCallback((): void => {
    setToolAutoOpenBlocked(false)
    setWorkbenchOpen(true)
  }, [])

  useEffect(() => {
    if (!startupHydrated) {
      lastViewRef.current = view
      return
    }
    const previous = lastViewRef.current
    if (previous !== view && navTravelRef.current === null) {
      setNavBackStack((stack) => [...stack, previous].slice(-24))
      setNavForwardStack([])
    }
    lastViewRef.current = view
    navTravelRef.current = null
  }, [view, startupHydrated])

  useEffect(() => {
    if (!PERSISTENT_FEATURE_VIEWS.has(view)) return
    setMountedFeatureViews((mounted) => {
      if (mounted.has(view)) return mounted
      const next = new Set(mounted)
      next.add(view)
      return next
    })
  }, [view])

  const goBack = useCallback((): void => {
    setNavBackStack((stack) => {
      const target = stack[stack.length - 1]
      if (!target) return stack
      navTravelRef.current = 'back'
      setNavForwardStack((forward) => [view, ...forward].slice(0, 24))
      setView(target)
      return stack.slice(0, -1)
    })
  }, [view])

  const goForward = useCallback((): void => {
    setNavForwardStack((stack) => {
      const target = stack[0]
      if (!target) return stack
      navTravelRef.current = 'forward'
      setNavBackStack((back) => [...back, view].slice(-24))
      setView(target)
      return stack.slice(1)
    })
  }, [view])

  const bumpHistory = useCallback(() => setHistoryVersion((v) => v + 1), [])
  const bumpWorkspaceContent = useCallback(() => setWorkspaceContentVersion((v) => v + 1), [])
  const bumpProjects = useCallback(() => setProjectVersion((v) => v + 1), [])
  const selectHistory = useCallback((sessionId: string | null, mode: ChatMode, providerId?: string) => {
    setHistorySel((prev) => ({ sessionId, providerId, mode, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [])

  const latestSession = useCallback(async (projectId: string | null): Promise<SessionRow | null> => {
    const sessions = await window.api.history.list()
    return latestSessionFrom(sessions, projectId)
  }, [])

  const openWorkspaceForProject = useCallback(
    async (project: ProjectRow | null): Promise<void> => {
      setActiveProject(project)
      setView('workspace')
      if (!project?.id) {
        selectHistory(null, 'workspace')
        updateActiveSessionId(null)
        return
      }
      try {
        const session = await latestSession(project.id)
        selectHistory(session?.id ?? null, 'workspace', session?.providerId)
        if (!session) updateActiveSessionId(null)
      } catch {
        selectHistory(null, 'workspace')
        updateActiveSessionId(null)
      }
    },
    [latestSession, selectHistory, updateActiveSessionId]
  )

  const openGeneralChat = useCallback(
    async (providerId?: string): Promise<void> => {
      setView('general')
      if (providerId) {
        selectHistory(null, 'general', providerId)
        updateActiveSessionId(null)
        return
      }
      try {
        const session = await latestSession(null)
        selectHistory(session?.id ?? null, 'general', session?.providerId)
        if (!session) updateActiveSessionId(null)
      } catch {
        selectHistory(null, 'general')
        updateActiveSessionId(null)
      }
    },
    [latestSession, selectHistory, updateActiveSessionId]
  )

  // Phase 14.1: the sidebar "New chat" action — always opens a FRESH general chat
  // (never loads the latest), keeping the user's currently selected/default model.
  const startNewGeneralChat = useCallback((): void => {
    setView('general')
    selectHistory(null, 'general')
    updateActiveSessionId(null)
  }, [selectHistory, updateActiveSessionId])

  // Phase 33.6: start a FRESH chat inside a specific project (multiple chats per
  // project). Keeps the project active so its agents/cwd stay bound, but opens an
  // empty workspace thread instead of loading the project's latest session. The
  // new session is persisted on first message via history.create(projectId).
  const startNewProjectChat = useCallback(
    (project: ProjectRow): void => {
      setActiveProject(project)
      setView('workspace')
      selectHistory(null, 'workspace')
      updateActiveSessionId(null)
    },
    [selectHistory, updateActiveSessionId]
  )

  const applyStartupSnapshot = useCallback(
    (snapshot: StartupSnapshot): void => {
      const projectById = new Map(snapshot.projects.map((project) => [project.id, project]))
      const sessionById = new Map(snapshot.sessions.map((session) => [session.id, session]))
      const restoredProject = snapshot.restore.projectId ? projectById.get(snapshot.restore.projectId) ?? null : null
      const restoredSession = snapshot.restore.sessionId ? sessionById.get(snapshot.restore.sessionId) ?? null : null
      // Older builds persisted the removed standalone Loop route. The main
      // process sanitizes it, while this guard also protects against a stale
      // snapshot arriving from an older preload contract.
      const restoredView: AppView = (snapshot.restore.view as string) === 'loops'
        ? 'workspace'
        : snapshot.restore.view

      if (restoredView === 'general') {
        setActiveProject(null)
        setView('general')
        updateActiveSessionId(restoredSession?.id ?? null)
        selectHistory(restoredSession?.id ?? null, 'general', restoredSession?.providerId)
        return
      }

      if (restoredView === 'workspace') {
        const project = restoredProject ?? snapshot.projects[0] ?? null
        const session = restoredSession ?? (project ? latestSessionFrom(snapshot.sessions, project.id) : null)
        setActiveProject(project)
        setView('workspace')
        updateActiveSessionId(session?.id ?? null)
        selectHistory(session?.id ?? null, 'workspace', session?.providerId)
        return
      }

      setActiveProject(restoredProject)
      setView(restoredView)
      updateActiveSessionId(restoredSession?.id ?? null)
      if (restoredSession) {
        selectHistory(restoredSession.id, restoredSession.projectId ? 'workspace' : 'general', restoredSession.providerId)
      }
    },
    [selectHistory, updateActiveSessionId]
  )

  useEffect(() => {
    let cancelled = false
    setStartupHydrated(false)
    setStartupError(null)
    void window.api.app
      .getStartupSnapshot(readStartupRequest())
      .then((snapshot) => {
        if (cancelled) return
        setStartupSnapshot(snapshot)
        applyStartupSnapshot(snapshot)
        if (snapshot.diagnostics.warnings.length > 0) {
          console.warn('[startup] hydration warnings:', snapshot.diagnostics.warnings)
        }
        console.info('[startup] hydration snapshot:', snapshot.diagnostics.counts)
        setStartupHydrated(true)
      })
      .catch((err) => {
        if (cancelled) return
        setStartupError(err instanceof Error ? err.message : String(err))
        setStartupHydrated(true)
      })
  }, [applyStartupSnapshot, startupRetry])

  // Persist the active project id. Workspace CLI calls receive the trusted path
  // directly and no longer depend on hidden terminal sessions.
  useEffect(() => {
    if (!startupHydrated) return
    try {
      if (activeProject?.id) localStorage.setItem('akorith.lastActiveProjectId', activeProject.id)
      else localStorage.removeItem('akorith.lastActiveProjectId')
    } catch {
      /* ignore */
    }
  }, [activeProject?.id, startupHydrated])

  useEffect(() => {
    if (!startupHydrated) return
    try {
      if (activeSessionId) localStorage.setItem('akorith.lastActiveSessionId', activeSessionId)
      else localStorage.removeItem('akorith.lastActiveSessionId')
    } catch {
      /* ignore */
    }
  }, [activeSessionId, startupHydrated])

  useEffect(() => {
    if (!startupHydrated) return
    try {
      localStorage.setItem('akorith.lastView', view)
    } catch {
      /* ignore */
    }
  }, [view, startupHydrated])

  useEffect(() => {
    try {
      localStorage.setItem('akorith.theme', theme)
    } catch {
      /* ignore */
    }
    // Mirror to config so the next launch's splash paints the matching background.
    void window.api.settings.setTheme(theme)
  }, [theme])

  useEffect(() => {
    try { localStorage.setItem('akorith.workspaceToolsOpen', String(workbenchOpen)) } catch { /* ignore */ }
  }, [workbenchOpen])

  const handleNavigate = useCallback(
    (nextView: AppView): void => {
      if (nextView === 'general') {
        void openGeneralChat()
        return
      }
      if (nextView === 'workspace') {
        void openWorkspaceForProject(activeProject)
        return
      }
      // Heavy feature chunks may still be resolving on the first visit.
      // Keep the current surface interactive until React can commit the next
      // section instead of replacing the whole stage with a blocking frame.
      startTransition(() => setView(nextView))
    },
    [activeProject, openGeneralChat, openWorkspaceForProject]
  )

  const selectSession = useCallback(
    (sessionId: string, project?: ProjectRow | null, providerId?: string) => {
      updateActiveSessionId(sessionId)
      if (project) {
        setActiveProject(project)
        setView('workspace')
        selectHistory(sessionId, 'workspace', providerId)
        return
      }
      setView('general')
      selectHistory(sessionId, 'general', providerId)
    },
    [selectHistory, updateActiveSessionId]
  )

  // Centralized "Open Project" used by both the sidebar and the center empty
  // state. Same validated main-process dialog; selecting it starts the agents.
  const openProject = useCallback(async () => {
    const res = await window.api.projects.openFolder(activeProject?.id ?? null)
    if (res.ok) {
      setActiveProject(res.project)
      void openWorkspaceForProject(res.project)
      bumpProjects()
    }
  }, [activeProject?.id, bumpProjects, openWorkspaceForProject])

  const requestCreateProject = useCallback(() => setCreateSignal((n) => n + 1), [])

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'n') {
        event.preventDefault()
        startNewGeneralChat()
      } else if (key === 'o') {
        event.preventDefault()
        void openProject()
      } else if (key === ',') {
        event.preventDefault()
        window.dispatchEvent(new Event('akorith:open-settings'))
      } else if (key === 'b') {
        event.preventDefault()
        window.dispatchEvent(new Event('akorith:toggle-sidebar'))
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [openProject, startNewGeneralChat])

  const chromeTitle =
    view === 'general'
      ? 'General chat'
      : view === 'workspace'
        ? activeProject?.name ?? 'Workspace'
        : view === 'dashboard'
          ? 'Dashboard'
          : view === 'test'
            ? 'Benchmark'
            : view === 'research'
              ? 'Research'
              : 'Plugins'
  const chromeScope =
    view === 'general'
      ? 'Model chat'
      : view === 'workspace'
        ? activeProject?.path
          ? 'Project workspace'
          : 'Workspace'
        : undefined
  const showChromeWorkbench = view === 'workspace' && Boolean(activeProject?.path)
  const workspaceToolsVisible = showChromeWorkbench && workbenchOpen
  const activeChatMode: ChatMode = view === 'general' || view === 'workspace'
    ? view
    : historySel?.mode ?? (activeProject ? 'workspace' : 'general')

  return (
    <div
      className="app"
      data-theme={theme}
      data-ui="replica"
      data-sidebar-collapsed={chromeSidebarWidth === 0 ? 'true' : 'false'}
      style={{ ['--chrome-sidebar-width' as string]: `${chromeSidebarWidth}px` } as CSSProperties}
    >
      <AppChrome
        canGoBack={navBackStack.length > 0}
        canGoForward={navForwardStack.length > 0}
        onBack={goBack}
        onForward={goForward}
        onNewChat={startNewGeneralChat}
        onOpenProject={() => void openProject()}
        onOpenSettings={() => window.dispatchEvent(new Event('akorith:open-settings'))}
        theme={theme}
        onThemeChange={setTheme}
        pendingCount={pendingSessions.size}
      />
      <div className="app-main">
      <Sidebar
        view={view}
        theme={theme}
        onThemeChange={setTheme}
        onNavigate={handleNavigate}
        historyVersion={historyVersion}
        projectVersion={projectVersion}
        startupSnapshot={startupSnapshot}
        startupHydrated={startupHydrated}
        startupError={startupError}
        onRetryStartupHydration={() => setStartupRetry((n) => n + 1)}
        activeSessionId={activeSessionId}
        activeProject={activeProject}
        createSignal={createSignal}
        onSelectProject={(project) => void openWorkspaceForProject(project)}
        onSelectSession={(id, project, providerId) => selectSession(id, project, providerId)}
        onNewChat={(providerId) => void openGeneralChat(providerId)}
        onNewGeneralChat={startNewGeneralChat}
        onNewProjectChat={startNewProjectChat}
        onHistoryChange={bumpHistory}
        onProjectsChange={bumpProjects}
        onChromeWidthChange={setChromeSidebarWidth}
        pendingSessions={pendingSessions}
      />
      <section className="app-surface">
        <SurfaceToolbar
          title={view === 'workspace' && activeProject && activeSessionId ? chromeTitle : view === 'general' && activeSessionId ? chromeTitle : undefined}
          scope={view === 'workspace' && activeProject && activeSessionId ? chromeScope : undefined}
          showWorkbench={showChromeWorkbench}
          workbenchOpen={workspaceToolsVisible}
          onToggleWorkbench={toggleWorkspaceTools}
        />
        <div className="app-view-stage">
      <div
        className={`workspace ${
          view === 'workspace' && activeProject?.path
            ? `has-workspace-tools ${workspaceToolsVisible ? 'tools-open' : 'tools-closed'}`
            : ''
        }`}
        style={{ display: view === 'workspace' || view === 'general' ? 'flex' : 'none' }}
      >
        <ChatPanel
          mode={activeChatMode}
          active={view === 'workspace' || view === 'general'}
          historySel={historySel}
          activeProject={activeChatMode === 'general' ? null : activeProject}
          onOpenProject={() => void openProject()}
          onCreateProject={requestCreateProject}
          onHistoryChange={bumpHistory}
          onActiveSession={updateActiveSessionId}
          pendingSessions={pendingSessions}
          onPendingChange={setSessionPending}
          onWorkspaceContentChange={bumpWorkspaceContent}
          onWorkspaceToolRequest={requestWorkspaceTool}
        />
        <Suspense fallback={null}>
          <WorkspaceToolsPanel
            key={activeProject?.id ?? 'no-project'}
            project={view === 'workspace' ? activeProject : null}
            open={workbenchOpen}
            active={view === 'workspace'}
            refreshKey={`${historyVersion}:${workspaceContentVersion}`}
            requestedTool={workspaceToolRequest}
            onOpen={openWorkspaceTools}
            onClose={toggleWorkspaceTools}
          />
        </Suspense>
      </div>
      {/* Heavy feature surfaces load only on first use. Long-running pages remain
          mounted after that first visit so navigation never interrupts a run. */}
      {(view === 'test' || mountedFeatureViews.has('test')) && (
        <div className="test-page-wrap" style={{ display: view === 'test' ? 'flex' : 'none' }}>
          <Suspense fallback={<FeaturePageFallback label="Loading Benchmark…" />}>
            <TestPage active={view === 'test'} activeProject={activeProject} />
          </Suspense>
        </div>
      )}
      {(view === 'research' || mountedFeatureViews.has('research')) && (
        <div className="research-page-wrap" style={{ display: view === 'research' ? 'flex' : 'none' }}>
          <Suspense fallback={<FeaturePageFallback label="Loading Research…" />}>
            <ResearchPage active={view === 'research'} />
          </Suspense>
        </div>
      )}
      {view === 'dashboard' && (
        <Suspense fallback={<FeaturePageFallback label="Loading Dashboard…" />}>
          <Dashboard activeProject={activeProject} />
        </Suspense>
      )}
      {view === 'plugins' && (
        <Suspense fallback={<FeaturePageFallback label="Loading Plugins…" />}>
          <Plugins />
        </Suspense>
      )}
        </div>
      </section>
      </div>
    </div>
  )
}
