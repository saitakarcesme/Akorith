import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import AgentDrawer from './components/AgentDrawer'
import BottomWorkbench from './components/BottomWorkbench'
import ChatPanel from './components/ChatPanel'
import Dashboard from './components/Dashboard'
import Plugins from './components/Plugins'
import TestPage from './components/TestPage'
import ProjectLoopPage from './components/ProjectLoopPage'
import CompanionsPage from './components/CompanionsPage'
import AgentsPage from './components/AgentsPage'
import { ChevronIcon, PanelsIcon, SparkIcon } from './components/icons'
import type { AgentStatusInfo } from './components/TerminalPane'
import type { ProjectRow, SessionRow, StartupSnapshot, StartupSnapshotRequest } from '../../preload/index.d'

export type ChatMode = 'workspace' | 'general'
export type AppView = ChatMode | 'dashboard' | 'test' | 'loops' | 'plugins' | 'companions' | 'agents'
export type AppTheme = 'dark' | 'light'

/** A sidebar→chat instruction: load a session (id) or start fresh (null). */
export interface HistorySelection {
  sessionId: string | null
  providerId?: string
  mode: ChatMode
  nonce: number
}

export type AgentStatusMap = Partial<Record<'t1' | 't2' | 't3', AgentStatusInfo>>

function initialChromeSidebarWidth(): number {
  try {
    if (localStorage.getItem('akorith.sidebarCollapsed') === 'true') return 0
    const raw = Number(localStorage.getItem('akorith.sidebarWidth'))
    return Number.isFinite(raw) && raw > 0 && raw <= 520 ? raw : 292
  } catch {
    return 292
  }
}

function AppChrome({
  title,
  scope,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  showWorkbench,
  workbenchOpen,
  onToggleWorkbench,
  showActivity,
  drawerOpen,
  onToggleDrawer
}: {
  title: string
  scope?: string
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  showWorkbench: boolean
  workbenchOpen: boolean
  onToggleWorkbench: () => void
  showActivity: boolean
  drawerOpen: boolean
  onToggleDrawer: () => void
}): JSX.Element {
  const hasWindowControls = Boolean(window.api?.windowControls) && /Mac/i.test(navigator.platform)

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
      </div>
      <div className="app-chrome-title">
        <span>{title}</span>
        {scope && <span className="app-chrome-scope">{scope}</span>}
      </div>
      <div className="app-chrome-right">
        {showWorkbench && (
          <button
            type="button"
            className={`activity-button ${workbenchOpen ? 'is-active' : ''}`}
            onClick={onToggleWorkbench}
            title="Toggle the bottom workbench (changes, runtime, missions)"
          >
            Workbench
          </button>
        )}
        {showActivity && (
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
  const [theme, setTheme] = useState<AppTheme>(() => {
    try {
      return localStorage.getItem('akorith.theme') === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })
  const [historyVersion, setHistoryVersion] = useState(0)
  const [projectVersion, setProjectVersion] = useState(0)
  const [startupSnapshot, setStartupSnapshot] = useState<StartupSnapshot | null>(null)
  const [startupHydrated, setStartupHydrated] = useState(false)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [startupRetry, setStartupRetry] = useState(0)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeProject, setActiveProject] = useState<ProjectRow | null>(null)
  const [historySel, setHistorySel] = useState<HistorySelection | null>(null)
  // Phase 13.1: terminals are hidden by default behind an activity drawer.
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Phase 33.17: the bottom workbench (Changes / Runtime / Missions) panel.
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [, setAgentStatus] = useState<AgentStatusMap>({})
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
      setAgentStatus({})
      if (!project?.id) {
        selectHistory(null, 'workspace')
        setActiveSessionId(null)
        return
      }
      try {
        const session = await latestSession(project.id)
        selectHistory(session?.id ?? null, 'workspace', session?.providerId)
        if (!session) setActiveSessionId(null)
      } catch {
        selectHistory(null, 'workspace')
        setActiveSessionId(null)
      }
    },
    [latestSession, selectHistory]
  )

  const openGeneralChat = useCallback(
    async (providerId?: string): Promise<void> => {
      setView('general')
      if (providerId) {
        selectHistory(null, 'general', providerId)
        setActiveSessionId(null)
        return
      }
      try {
        const session = await latestSession(null)
        selectHistory(session?.id ?? null, 'general', session?.providerId)
        if (!session) setActiveSessionId(null)
      } catch {
        selectHistory(null, 'general')
        setActiveSessionId(null)
      }
    },
    [latestSession, selectHistory]
  )

  // Phase 14.1: the sidebar "New chat" action — always opens a FRESH general chat
  // (never loads the latest), keeping the user's currently selected/default model.
  const startNewGeneralChat = useCallback((): void => {
    setView('general')
    selectHistory(null, 'general')
    setActiveSessionId(null)
  }, [selectHistory])

  // Phase 33.6: start a FRESH chat inside a specific project (multiple chats per
  // project). Keeps the project active so its agents/cwd stay bound, but opens an
  // empty workspace thread instead of loading the project's latest session. The
  // new session is persisted on first message via history.create(projectId).
  const startNewProjectChat = useCallback(
    (project: ProjectRow): void => {
      setActiveProject(project)
      setView('workspace')
      setAgentStatus({})
      selectHistory(null, 'workspace')
      setActiveSessionId(null)
    },
    [selectHistory]
  )

  const applyStartupSnapshot = useCallback(
    (snapshot: StartupSnapshot): void => {
      const projectById = new Map(snapshot.projects.map((project) => [project.id, project]))
      const sessionById = new Map(snapshot.sessions.map((session) => [session.id, session]))
      const restoredProject = snapshot.restore.projectId ? projectById.get(snapshot.restore.projectId) ?? null : null
      const restoredSession = snapshot.restore.sessionId ? sessionById.get(snapshot.restore.sessionId) ?? null : null

      setAgentStatus({})
      if (snapshot.restore.view === 'general') {
        setActiveProject(null)
        setView('general')
        setActiveSessionId(restoredSession?.id ?? null)
        selectHistory(restoredSession?.id ?? null, 'general', restoredSession?.providerId)
        return
      }

      if (snapshot.restore.view === 'workspace') {
        const project = restoredProject ?? snapshot.projects[0] ?? null
        const session = restoredSession ?? (project ? latestSessionFrom(snapshot.sessions, project.id) : null)
        setActiveProject(project)
        setView('workspace')
        setActiveSessionId(session?.id ?? null)
        selectHistory(session?.id ?? null, 'workspace', session?.providerId)
        return
      }

      setActiveProject(restoredProject)
      setView(snapshot.restore.view)
      setActiveSessionId(restoredSession?.id ?? null)
      if (restoredSession) {
        selectHistory(restoredSession.id, restoredSession.projectId ? 'workspace' : 'general', restoredSession.providerId)
      }
    },
    [selectHistory]
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

  // Persist the active project id; reset agent status when the project changes
  // (the drawer remounts its terminals for the new cwd).
  useEffect(() => {
    if (!startupHydrated) return
    try {
      if (activeProject?.id) localStorage.setItem('akorith.lastActiveProjectId', activeProject.id)
      else localStorage.removeItem('akorith.lastActiveProjectId')
    } catch {
      /* ignore */
    }
    setAgentStatus({})
    // Phase 13.3: point the bridge's logical targets (t1/t2) at this project's
    // live sessions, matching the per-project keys used in AgentDrawer.
    const projectKey = activeProject?.id ? activeProject.id.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 40) : ''
    window.api.pty.setActiveProject(projectKey)
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
      setView(nextView)
    },
    [activeProject, openGeneralChat, openWorkspaceForProject]
  )

  const selectSession = useCallback(
    (sessionId: string, project?: ProjectRow | null, providerId?: string) => {
      setActiveSessionId(sessionId)
      if (project) {
        setActiveProject(project)
        setView('workspace')
        selectHistory(sessionId, 'workspace', providerId)
        return
      }
      setView('general')
      selectHistory(sessionId, 'general', providerId)
    },
    [selectHistory]
  )

  const handleAgentStatus = useCallback((id: 't1' | 't2' | 't3', info: AgentStatusInfo) => {
    setAgentStatus((prev) => ({ ...prev, [id]: info }))
  }, [])

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
  const chromeTitle =
    view === 'general'
      ? 'General chat'
      : view === 'workspace'
        ? activeProject?.name ?? 'Workspace'
        : view === 'dashboard'
          ? 'Dashboard'
          : view === 'test'
            ? 'Benchmark'
            : view === 'loops'
              ? 'Loop'
              : view === 'plugins'
                ? 'Plugins'
                : view === 'companions'
                  ? 'Companions'
                  : 'Agents'
  const chromeScope =
    view === 'general'
      ? 'Model chat'
      : view === 'workspace'
        ? activeProject?.path
          ? 'Project workspace'
          : 'Workspace'
        : undefined
  const showChromeWorkbench = view === 'general' || view === 'workspace'
  const showChromeActivity = view === 'workspace' && Boolean(activeProject?.path)

  return (
    <div
      className="app"
      data-theme={theme}
      style={{ ['--chrome-sidebar-width' as string]: `${chromeSidebarWidth}px` } as CSSProperties}
    >
      <AppChrome
        title={chromeTitle}
        scope={chromeScope}
        canGoBack={navBackStack.length > 0}
        canGoForward={navForwardStack.length > 0}
        onBack={goBack}
        onForward={goForward}
        showWorkbench={showChromeWorkbench}
        workbenchOpen={workbenchOpen}
        onToggleWorkbench={() => setWorkbenchOpen((v) => !v)}
        showActivity={showChromeActivity}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
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
      />
      {/* Chat-first workspace. Terminals are not part of this column anymore —
          they live in the AgentDrawer overlay (kept mounted to stay alive). */}
      <div className="workspace" style={{ display: view === 'workspace' || view === 'general' ? 'flex' : 'none' }}>
        <ChatPanel
          mode={view === 'general' ? 'general' : 'workspace'}
          historySel={historySel}
          activeProject={view === 'general' ? null : activeProject}
          drawerOpen={drawerOpen}
          onToggleDrawer={() => setDrawerOpen((v) => !v)}
          onOpenProject={() => void openProject()}
          onCreateProject={requestCreateProject}
          onHistoryChange={bumpHistory}
          onActiveSession={setActiveSessionId}
          pendingSessions={pendingSessions}
          onPendingChange={setSessionPending}
        />
        <BottomWorkbench
          activeProject={view === 'general' ? null : activeProject}
          open={workbenchOpen}
          onClose={() => setWorkbenchOpen(false)}
        />
        {view === 'workspace' && (
          <AgentDrawer
            activeProject={activeProject}
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            onAgentStatus={handleAgentStatus}
          />
        )}
      </div>
      {/* The test page stays mounted while hidden so a streaming run is never
          interrupted by navigating to the Workspace or Dashboard. */}
      <div className="test-page-wrap" style={{ display: view === 'test' ? 'flex' : 'none' }}>
        <TestPage active={view === 'test'} activeProject={activeProject} />
      </div>
      {/* Loops stay mounted so an in-progress "create" or live timers survive nav. */}
      <div className="loops-page-wrap" style={{ display: view === 'loops' ? 'flex' : 'none' }}>
        <ProjectLoopPage active={view === 'loops'} />
      </div>
      {view === 'dashboard' && <Dashboard activeProject={activeProject} />}
      {view === 'plugins' && <Plugins />}
      <div className="companions-page-wrap" style={{ display: view === 'companions' ? 'flex' : 'none' }}>
        <CompanionsPage active={view === 'companions'} />
      </div>
      {view === 'agents' && <AgentsPage active={view === 'agents'} />}
      </div>
    </div>
  )
}
