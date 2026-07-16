import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitChangeFile, GitStatusResult, ProjectRow } from '../../../preload/index.d'
import { CloseIcon, FileIcon } from './icons'

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

export default function BottomWorkbench({ activeProject, open, onClose }: BottomWorkbenchProps): JSX.Element | null {
  const [changes, setChanges] = useState<GitStatusResult | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [busy, setBusy] = useState(false)
  const [diffBusy, setDiffBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const files = changes?.ok && changes.isRepo ? changes.files : []
  const selected = useMemo(() => files.find((file) => file.path === selectedPath) ?? null, [files, selectedPath])

  const load = useCallback(async (): Promise<void> => {
    if (!activeProject?.path) { setChanges(null); setSelectedPath(null); return }
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.git.status(activeProject.path)
      setChanges(result)
      if (result.ok && result.isRepo) {
        setSelectedPath((current) => result.files.some((file) => file.path === current) ? current : result.files[0]?.path ?? null)
      }
    } catch (nextError) {
      setChanges({ ok: false, error: nextError instanceof Error ? nextError.message : String(nextError) })
    } finally { setBusy(false) }
  }, [activeProject?.path])

  useEffect(() => { if (open) void load() }, [open, load])
  useEffect(() => {
    if (!open || !activeProject?.path || !selectedPath) { setDiff(''); return }
    let cancelled = false
    setDiffBusy(true)
    setError(null)
    void window.api.git.diff(activeProject.path, selectedPath).then((result) => {
      if (cancelled) return
      if (result.ok) setDiff(result.diff)
      else { setDiff(''); setError(result.error) }
    }).finally(() => { if (!cancelled) setDiffBusy(false) })
    return () => { cancelled = true }
  }, [activeProject?.path, open, selectedPath])

  const toggleStaged = async (file: GitChangeFile): Promise<void> => {
    if (!activeProject?.path) return
    setBusy(true)
    const result = await window.api.git.setStaged(activeProject.path, file.path, !file.staged)
    if (!result.ok) setError(result.error ?? 'Git operation failed.')
    await load()
  }

  if (!open) return null

  return (
    <section className="workbench" aria-label="Project changes">
      <div className="workbench-tabs">
        <strong className="workbench-tab is-active">Changes</strong>
        {changes?.ok && changes.isRepo && <span className="workbench-branch">{changes.branch}</span>}
        <div className="workbench-spacer" />
        <button type="button" className="workbench-action" disabled={busy} onClick={() => void load()}>{busy ? 'Reading…' : 'Refresh'}</button>
        <button type="button" className="workbench-close" title="Hide changes" onClick={onClose}><CloseIcon size={15} /></button>
      </div>
      {!activeProject?.path ? <div className="workbench-empty">Open a project to review changes.</div>
        : !changes ? <div className="workbench-empty">Reading git status…</div>
          : !changes.ok ? <div className="workbench-empty is-error">{changes.error}</div>
            : !changes.isRepo ? <div className="workbench-empty">This project is not a git repository.</div>
              : changes.clean ? <div className="workbench-empty is-clean"><i />Working tree clean</div>
                : <div className="workbench-review">
                    <aside className="workbench-files">
                      <div className="workbench-files-head"><span>{files.length} changed</span><small>{files.filter((file) => file.staged).length} staged</small></div>
                      <div className="workbench-file-list">{files.map((file) => <button type="button" key={file.path} className={`workbench-file ${selectedPath === file.path ? 'is-active' : ''}`} onClick={() => setSelectedPath(file.path)}><span className={`workbench-file-status status-${statusWord(file.status)}`}>{file.status}</span><span className="workbench-file-name"><FileIcon size={13} />{file.path}</span>{file.staged && <em>staged</em>}</button>)}</div>
                    </aside>
                    <div className="workbench-diff">
                      {selected && <div className="workbench-diff-head"><strong>{selected.path}</strong><div><button type="button" onClick={() => void window.api.git.revealFile(activeProject.path!, selected.path)}>Reveal</button><button type="button" className={selected.staged ? '' : 'is-primary'} disabled={busy} onClick={() => void toggleStaged(selected)}>{selected.staged ? 'Unstage' : 'Stage'}</button></div></div>}
                      {error && <div className="workbench-inline-error">{error}</div>}
                      {diffBusy ? <div className="workbench-empty">Reading diff…</div> : diff ? <pre className="workbench-diff-code">{diff}</pre> : <div className="workbench-empty">No textual diff for this file.</div>}
                    </div>
                  </div>}
    </section>
  )
}
