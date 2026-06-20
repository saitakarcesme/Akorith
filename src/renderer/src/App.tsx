import { useCallback, useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import AgentDrawer from './components/AgentDrawer'
import ChatPanel from './components/ChatPanel'
import Dashboard from './components/Dashboard'
import TestPage from './components/TestPage'
import LoopsPage from './components/LoopsPage'
import type { AgentStatusInfo } from './components/TerminalPane'
import type { ProjectRow, SessionRow } from '../../preload/index.d'

export type ChatMode = 'workspace' | 'general'
export type AppView = ChatMode | 'dashboard' | 'test' | 'loops'
export type AppTheme = 'dark' | 'light'

/** A sidebar→chat instruction: load a session (id) or start fresh (null). */
export interface HistorySelection {
  sessionId: string | null
  providerId?: string
  mode: ChatMode
  nonce: number
}

export type AgentStatusMap = Partial<Record<'t1' | 't2', AgentStatusInfo>>

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
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeProject, setActiveProject] = useState<ProjectRow | null>(null)
  const [historySel, setHistorySel] = useState<HistorySelection | null>(null)
  // Phase 13.1: terminals are hidden by default behind an activity drawer.
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [agentStatus, setAgentStatus] = useState<AgentStatusMap>({})
  // Lets the center empty-state "Create Project" button open the sidebar modal.
  const [createSignal, setCreateSignal] = useState(0)

  const bumpHistory = useCallback(() => setHistoryVersion((v) => v + 1), [])
  const bumpProjects = useCallback(() => setProjectVersion((v) => v + 1), [])
  const selectHistory = useCallback((sessionId: string | null, mode: ChatMode, providerId?: string) => {
    setHistorySel((prev) => ({ sessionId, providerId, mode, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [])

  const latestSession = useCallback(async (projectId: string | null): Promise<SessionRow | null> => {
    const sessions = await window.api.history.list()
    return sessions.find((session) => session.projectId === projectId) ?? null
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

  // Phase 13: workspace continuity. On launch, restore the last active project so
  // the app resumes previous work instead of opening empty. Restoring a project
  // re-starts its Codex/Claude terminals through the existing safe PTY startup
  // (a logged-in CLI launch in the project cwd — never a destructive command).
  useEffect(() => {
    let cancelled = false
    try {
      const lastId = localStorage.getItem('akorith.lastActiveProjectId')
      if (!lastId) return
      void window.api.projects
        .list()
        .then((projects) => {
          if (cancelled) return
          const match = projects.find((p) => p.id === lastId)
          if (match) void openWorkspaceForProject(match)
        })
        .catch(() => {})
    } catch {
      // localStorage unavailable — fall back to the empty workspace.
    }
    return () => {
      cancelled = true
    }
  }, [openWorkspaceForProject])

  // Persist the active project id; reset agent status when the project changes
  // (the drawer remounts its terminals for the new cwd).
  useEffect(() => {
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
  }, [activeProject?.id])

  useEffect(() => {
    try {
      if (activeSessionId) localStorage.setItem('akorith.lastActiveSessionId', activeSessionId)
    } catch {
      /* ignore */
    }
  }, [activeSessionId])

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

  const handleAgentStatus = useCallback((id: 't1' | 't2', info: AgentStatusInfo) => {
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

  return (
    <div className="app" data-theme={theme}>
      <Sidebar
        view={view}
        theme={theme}
        onThemeChange={setTheme}
        onNavigate={handleNavigate}
        historyVersion={historyVersion}
        projectVersion={projectVersion}
        activeSessionId={activeSessionId}
        activeProject={activeProject}
        createSignal={createSignal}
        onSelectProject={(project) => void openWorkspaceForProject(project)}
        onSelectSession={(id, project, providerId) => selectSession(id, project, providerId)}
        onNewChat={(providerId) => void openGeneralChat(providerId)}
        onNewGeneralChat={startNewGeneralChat}
        onHistoryChange={bumpHistory}
        onProjectsChange={bumpProjects}
      />
      {/* Chat-first workspace. Terminals are not part of this column anymore —
          they live in the AgentDrawer overlay (kept mounted to stay alive). */}
      <div className="workspace" style={{ display: view === 'workspace' || view === 'general' ? 'flex' : 'none' }}>
        <ChatPanel
          mode={view === 'general' ? 'general' : 'workspace'}
          historySel={historySel}
          activeProject={view === 'general' ? null : activeProject}
          agentStatus={agentStatus}
          drawerOpen={drawerOpen}
          onToggleDrawer={() => setDrawerOpen((v) => !v)}
          onOpenProject={() => void openProject()}
          onCreateProject={requestCreateProject}
          onHistoryChange={bumpHistory}
          onActiveSession={setActiveSessionId}
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
        <LoopsPage active={view === 'loops'} />
      </div>
      {view === 'dashboard' && <Dashboard />}
    </div>
  )
}
