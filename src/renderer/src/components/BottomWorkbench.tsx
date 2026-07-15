import { useCallback, useEffect, useState } from 'react'
import type { GitStatusResult, ProjectRow } from '../../../preload/index.d'

interface BottomWorkbenchProps {
  activeProject: ProjectRow | null
  open: boolean
  onClose: () => void
}

function statusWord(code: string): string {
  const clean = code.replace(/\s/g, '')
  if (clean.includes('?')) return 'new'
  if (clean.includes('M')) return 'modified'
  if (clean.includes('A')) return 'added'
  if (clean.includes('D')) return 'deleted'
  if (clean.includes('R')) return 'renamed'
  return code || '·'
}

/** A read-only Codex-style view of the files changed by the workspace task. */
export default function BottomWorkbench({ activeProject, open, onClose }: BottomWorkbenchProps): JSX.Element | null {
  const [changes, setChanges] = useState<GitStatusResult | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!activeProject?.path) {
      setChanges(null)
      return
    }
    setBusy(true)
    try {
      setChanges(await window.api.git.status(activeProject.path))
    } catch (err) {
      setChanges({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }, [activeProject?.path])

  useEffect(() => { if (open) void load() }, [open, load])
  if (!open) return null

  return (
    <section className="workbench" aria-label="Project changes">
      <div className="workbench-tabs">
        <strong className="workbench-tab is-active">Changes</strong>
        <div className="workbench-spacer" />
        <button type="button" className="workbench-action" disabled={busy} onClick={() => void load()}>{busy ? 'Reading…' : 'Refresh'}</button>
        <button type="button" className="workbench-close" title="Hide changes" onClick={onClose}>✕</button>
      </div>
      <div className="workbench-body">
        <div className="workbench-changes">
          {!activeProject?.path ? <div className="workbench-empty">Open a project to see changes.</div>
            : !changes ? <div className="workbench-empty">{busy ? 'Reading git status…' : 'No data yet.'}</div>
              : !changes.ok ? <div className="workbench-empty is-error">{changes.error}</div>
                : !changes.isRepo ? <div className="workbench-empty">This folder is not a git repository.</div>
                  : <><div className="workbench-changes-head"><span className="workbench-branch">{changes.branch}</span><span className="workbench-count">{changes.clean ? 'working tree clean' : `${changes.files.length} changed${changes.truncated ? '+' : ''}`}</span></div>
                    {changes.files.length > 0 && <ul className="workbench-file-list">{changes.files.map((file) => <li key={file.path} className="workbench-file"><span className={`workbench-file-status status-${statusWord(file.status)}`}>{file.status}</span><span className="workbench-file-path">{file.path}</span><em className="workbench-file-word">{statusWord(file.status)}</em></li>)}</ul>}
                    {changes.stat && <pre className="workbench-diffstat">{changes.stat}</pre>}
                    <div className="workbench-note">Read-only overview. Workspace tasks never push automatically.</div></>}
        </div>
      </div>
    </section>
  )
}
