import { useCallback, useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import AgentDrawer from './components/AgentDrawer'
import ChatPanel from './components/ChatPanel'
import Dashboard from './components/Dashboard'
import TestPage from './components/TestPage'
import type { AgentStatusInfo } from './components/TerminalPane'
import type { ProjectRow } from '../../preload/index.d'

export type AppView = 'workspace' | 'dashboard' | 'test'

/** A sidebar→chat instruction: load a session (id) or start fresh (null). */
export interface HistorySelection {
  sessionId: string | null
  providerId?: string
  nonce: number
}

export type AgentStatusMap = Partial<Record<'t1' | 't2', AgentStatusInfo>>

export default function App(): JSX.Element {
  const [view, setView] = useState<AppView>('workspace')
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
          if (match) setActiveProject(match)
        })
        .catch(() => {})
    } catch {
      // localStorage unavailable — fall back to the empty workspace.
    }
    return () => {
      cancelled = true
    }
  }, [])

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
  }, [activeProject?.id])

  useEffect(() => {
    try {
      if (activeSessionId) localStorage.setItem('akorith.lastActiveSessionId', activeSessionId)
    } catch {
      /* ignore */
    }
  }, [activeSessionId])

  const selectSession = useCallback((sessionId: string | null, providerId?: string, project?: ProjectRow | null) => {
    setHistorySel((prev) => ({ sessionId, providerId, nonce: (prev?.nonce ?? 0) + 1 }))
    if (project !== undefined) setActiveProject(project)
    setView('workspace')
  }, [])

  const handleAgentStatus = useCallback((id: 't1' | 't2', info: AgentStatusInfo) => {
    setAgentStatus((prev) => ({ ...prev, [id]: info }))
  }, [])

  // Centralized "Open Project" used by both the sidebar and the center empty
  // state. Same validated main-process dialog; selecting it starts the agents.
  const openProject = useCallback(async () => {
    const res = await window.api.projects.openFolder(activeProject?.id ?? null)
    if (res.ok) {
      setActiveProject(res.project)
      bumpProjects()
    }
  }, [activeProject?.id, bumpProjects])

  const requestCreateProject = useCallback(() => setCreateSignal((n) => n + 1), [])

  return (
    <div className="app">
      <Sidebar
        view={view}
        onNavigate={setView}
        historyVersion={historyVersion}
        projectVersion={projectVersion}
        activeSessionId={activeSessionId}
        activeProject={activeProject}
        createSignal={createSignal}
        onSelectProject={setActiveProject}
        onSelectSession={(id, project) => selectSession(id, undefined, project)}
        onNewChat={(providerId) => selectSession(null, providerId)}
        onHistoryChange={bumpHistory}
        onProjectsChange={bumpProjects}
      />
      {/* Chat-first workspace. Terminals are not part of this column anymore —
          they live in the AgentDrawer overlay (kept mounted to stay alive). */}
      <div className="workspace" style={{ display: view === 'workspace' ? 'flex' : 'none' }}>
        <ChatPanel
          historySel={historySel}
          activeProject={activeProject}
          agentStatus={agentStatus}
          drawerOpen={drawerOpen}
          onToggleDrawer={() => setDrawerOpen((v) => !v)}
          onOpenProject={() => void openProject()}
          onCreateProject={requestCreateProject}
          onHistoryChange={bumpHistory}
          onActiveSession={setActiveSessionId}
        />
        <AgentDrawer
          activeProject={activeProject}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onAgentStatus={handleAgentStatus}
        />
      </div>
      {/* The test page stays mounted while hidden so a streaming run is never
          interrupted by navigating to the Workspace or Dashboard. */}
      <div className="test-page-wrap" style={{ display: view === 'test' ? 'flex' : 'none' }}>
        <TestPage active={view === 'test'} />
      </div>
      {view === 'dashboard' && <Dashboard />}
    </div>
  )
}
