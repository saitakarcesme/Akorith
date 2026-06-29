import { useCallback, useEffect, useState } from 'react'
import type { AgentRuntimeSnapshot, GitStatusResult, Mission, ProjectRow } from '../../../preload/index.d'

type WorkbenchTab = 'changes' | 'runtime' | 'missions'

interface BottomWorkbenchProps {
  activeProject: ProjectRow | null
  open: boolean
  onClose: () => void
}

const TABS: { id: WorkbenchTab; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'missions', label: 'Missions' }
]

function statusWord(code: string): string {
  const c = code.replace(/\s/g, '')
  if (c.includes('?')) return 'new'
  if (c.includes('M')) return 'modified'
  if (c.includes('A')) return 'added'
  if (c.includes('D')) return 'deleted'
  if (c.includes('R')) return 'renamed'
  return code || '·'
}

/**
 * Phase 33.17: a Codex/OpenCode-style bottom workbench. Read-only panels only:
 * a git Changes summary for the active project (via the bounded git:status IPC),
 * a Runtime observation snapshot, and a Missions overview. It never executes
 * anything — no staging, commits, or mission runs.
 */
export default function BottomWorkbench({ activeProject, open, onClose }: BottomWorkbenchProps): JSX.Element | null {
  const [tab, setTab] = useState<WorkbenchTab>('changes')
  const [changes, setChanges] = useState<GitStatusResult | null>(null)
  const [changesBusy, setChangesBusy] = useState(false)
  const [runtime, setRuntime] = useState<AgentRuntimeSnapshot | null>(null)
  const [missions, setMissions] = useState<Mission[] | null>(null)

  const loadChanges = useCallback(async (): Promise<void> => {
    if (!activeProject?.path) {
      setChanges(null)
      return
    }
    setChangesBusy(true)
    try {
      setChanges(await window.api.git.status(activeProject.path))
    } catch (err) {
      setChanges({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setChangesBusy(false)
    }
  }, [activeProject?.path])

  // Load the active tab's data when the panel opens, the tab changes, or the
  // project changes. No background polling.
  useEffect(() => {
    if (!open) return
    if (tab === 'changes') void loadChanges()
    else if (tab === 'runtime') void window.api.agent.getRuntimeSnapshot().then(setRuntime).catch(() => setRuntime(null))
    else if (tab === 'missions') void window.api.mission.list().then(setMissions).catch(() => setMissions(null))
  }, [open, tab, loadChanges])

  if (!open) return null

  return (
    <section className="workbench" aria-label="Workbench">
      <div className="workbench-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`workbench-tab ${tab === entry.id ? 'is-active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
        <div className="workbench-spacer" />
        {tab === 'changes' && (
          <button type="button" className="workbench-action" disabled={changesBusy} onClick={() => void loadChanges()}>
            {changesBusy ? 'Reading…' : 'Refresh'}
          </button>
        )}
        <button type="button" className="workbench-close" title="Hide workbench" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="workbench-body">
        {tab === 'changes' && (
          <div className="workbench-changes">
            {!activeProject?.path ? (
              <div className="workbench-empty">Open a project to see its working-tree changes.</div>
            ) : !changes ? (
              <div className="workbench-empty">{changesBusy ? 'Reading git status…' : 'No data yet.'}</div>
            ) : !changes.ok ? (
              <div className="workbench-empty is-error">{changes.error}</div>
            ) : !changes.isRepo ? (
              <div className="workbench-empty">This project folder is not a git repository.</div>
            ) : (
              <>
                <div className="workbench-changes-head">
                  <span className="workbench-branch">{changes.branch}</span>
                  <span className="workbench-count">
                    {changes.clean ? 'working tree clean' : `${changes.files.length} changed${changes.truncated ? '+' : ''}`}
                  </span>
                </div>
                {changes.files.length > 0 && (
                  <ul className="workbench-file-list">
                    {changes.files.map((file) => (
                      <li key={file.path} className="workbench-file" title={file.path}>
                        <span className={`workbench-file-status status-${statusWord(file.status)}`}>{file.status}</span>
                        <span className="workbench-file-path">{file.path}</span>
                        <em className="workbench-file-word">{statusWord(file.status)}</em>
                      </li>
                    ))}
                  </ul>
                )}
                {changes.stat && <pre className="workbench-diffstat">{changes.stat}</pre>}
                <div className="workbench-note">Read-only — Akorith never stages, commits, or pushes from here.</div>
              </>
            )}
          </div>
        )}

        {tab === 'runtime' && (
          <div className="workbench-runtime">
            {!runtime ? (
              <div className="workbench-empty">No runtime snapshot.</div>
            ) : (
              <div className="workbench-stat-grid">
                <div className="workbench-stat">
                  <span>Observed sessions</span>
                  <strong>{runtime.observedSessions.length}</strong>
                </div>
                <div className="workbench-stat">
                  <span>Active provider calls</span>
                  <strong>{runtime.activeProviderCalls.length}</strong>
                </div>
                <div className="workbench-stat">
                  <span>Active PTY sessions</span>
                  <strong>{runtime.activePtySessions.length}</strong>
                </div>
                <div className="workbench-stat">
                  <span>Ollama runtime</span>
                  <strong>{runtime.ollamaStatus?.status ?? 'unknown'}</strong>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'missions' && (
          <div className="workbench-missions">
            {!missions ? (
              <div className="workbench-empty">No missions data.</div>
            ) : missions.length === 0 ? (
              <div className="workbench-empty">No mission drafts yet. Create one from Settings → Missions.</div>
            ) : (
              <ul className="workbench-mission-list">
                {missions.slice(0, 12).map((mission) => (
                  <li key={mission.id} className="workbench-mission">
                    <span className="workbench-mission-title">{mission.title}</span>
                    <em className={`workbench-mission-status status-${mission.status}`}>{mission.status}</em>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
