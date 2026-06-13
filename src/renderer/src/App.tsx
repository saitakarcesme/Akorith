import { useCallback, useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import TerminalColumn from './components/TerminalColumn'
import ChatPanel from './components/ChatPanel'
import Dashboard from './components/Dashboard'
import TestPage from './components/TestPage'
import type { ProjectRow } from '../../preload/index.d'

export type AppView = 'workspace' | 'dashboard' | 'test'

/** A sidebar→chat instruction: load a session (id) or start fresh (null). */
export interface HistorySelection {
  sessionId: string | null
  providerId?: string
  nonce: number
}

export default function App(): JSX.Element {
  const [view, setView] = useState<AppView>('workspace')
  const [historyVersion, setHistoryVersion] = useState(0)
  const [projectVersion, setProjectVersion] = useState(0)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeProject, setActiveProject] = useState<ProjectRow | null>(null)
  const [historySel, setHistorySel] = useState<HistorySelection | null>(null)

  const bumpHistory = useCallback(() => setHistoryVersion((v) => v + 1), [])
  const bumpProjects = useCallback(() => setProjectVersion((v) => v + 1), [])

  // Phase 13: workspace continuity. On launch, restore the last active project so
  // the app resumes previous work instead of opening empty. Restoring a project
  // re-starts its Codex/Claude terminals through the existing safe PTY startup
  // (a logged-in CLI launch in the project cwd — never a destructive command),
  // and the panes show visible live/exited status, so the resume is never hidden.
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

  // Persist the active project id so the next launch can resume it.
  useEffect(() => {
    try {
      if (activeProject?.id) localStorage.setItem('akorith.lastActiveProjectId', activeProject.id)
      else localStorage.removeItem('akorith.lastActiveProjectId')
    } catch {
      /* ignore */
    }
  }, [activeProject?.id])

  // Persist the last active chat session id (recent chats remain one click to resume).
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

  return (
    <div className="app">
      <Sidebar
        view={view}
        onNavigate={setView}
        historyVersion={historyVersion}
        projectVersion={projectVersion}
        activeSessionId={activeSessionId}
        activeProject={activeProject}
        onSelectProject={setActiveProject}
        onSelectSession={(id, project) => selectSession(id, undefined, project)}
        onNewChat={(providerId) => selectSession(null, providerId)}
        onHistoryChange={bumpHistory}
        onProjectsChange={bumpProjects}
      />
      {/* The workspace stays mounted while the dashboard is shown (display:none)
          so the terminals' PTYs and scrollback are never disturbed. */}
      <div className="workspace" style={{ display: view === 'workspace' ? 'flex' : 'none' }}>
        <ChatPanel
          historySel={historySel}
          activeProject={activeProject}
          onHistoryChange={bumpHistory}
          onActiveSession={setActiveSessionId}
        />
        <TerminalColumn
          activeProject={activeProject}
          onProjectSelected={setActiveProject}
          onProjectsChange={bumpProjects}
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
