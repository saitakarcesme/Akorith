import { useCallback, useState } from 'react'
import Sidebar from './components/Sidebar'
import TerminalColumn from './components/TerminalColumn'
import ChatPanel from './components/ChatPanel'
import Dashboard from './components/Dashboard'
import TestPage from './components/TestPage'

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
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [historySel, setHistorySel] = useState<HistorySelection | null>(null)

  const bumpHistory = useCallback(() => setHistoryVersion((v) => v + 1), [])

  const selectSession = useCallback((sessionId: string | null, providerId?: string) => {
    setHistorySel((prev) => ({ sessionId, providerId, nonce: (prev?.nonce ?? 0) + 1 }))
    setView('workspace')
  }, [])

  return (
    <div className="app">
      <Sidebar
        view={view}
        onNavigate={setView}
        historyVersion={historyVersion}
        activeSessionId={activeSessionId}
        onSelectSession={(id) => selectSession(id)}
        onNewChat={(providerId) => selectSession(null, providerId)}
        onHistoryChange={bumpHistory}
      />
      {/* The workspace stays mounted while the dashboard is shown (display:none)
          so the terminals' PTYs and scrollback are never disturbed. */}
      <div className="workspace" style={{ display: view === 'workspace' ? 'flex' : 'none' }}>
        <TerminalColumn />
        <ChatPanel
          historySel={historySel}
          onHistoryChange={bumpHistory}
          onActiveSession={setActiveSessionId}
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
