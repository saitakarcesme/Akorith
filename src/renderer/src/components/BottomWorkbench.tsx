import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { GitChangeFile, GitStatusResult, ProjectRow } from '../../../preload/index.d'
import { FileIcon } from './icons'

interface BottomWorkbenchProps {
  activeProject: ProjectRow | null
  open: boolean
  refreshKey?: string | number
  embedded?: boolean
}

export interface DiffRow {
  kind: 'addition' | 'deletion' | 'context' | 'hunk' | 'meta'
  content: string
  marker: '+' | '-' | ' ' | '@@' | ''
  oldLine: number | null
  newLine: number | null
}

const DIFF_ROW_PAGE_SIZE = 600

function statusWord(code: string): string {
  const clean = code.replace(/\s/g, '')
  if (clean.includes('?')) return 'new'
  if (clean.includes('M')) return 'modified'
  if (clean.includes('A')) return 'added'
  if (clean.includes('D')) return 'deleted'
  if (clean.includes('R')) return 'renamed'
  return code || 'changed'
}

function lineLabel(row: DiffRow): string {
  const position = [
    row.oldLine === null ? null : `old line ${row.oldLine}`,
    row.newLine === null ? null : `new line ${row.newLine}`
  ].filter(Boolean).join(', ')
  const action = row.kind === 'addition'
    ? 'added'
    : row.kind === 'deletion'
      ? 'deleted'
      : row.kind === 'hunk'
        ? 'diff section'
        : row.kind
  return position ? `${position}, ${action}` : action
}

/** Parse a unified Git diff without confusing changed source that begins with ++ or --. */
export function parseDiffRows(value: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const text of value.split('\n')) {
    if (text.startsWith('diff --git ')) {
      inHunk = false
      continue
    }

    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      rows.push({ kind: 'hunk', content: text, marker: '@@', oldLine: null, newLine: null })
      continue
    }

    if (text.startsWith('[Akorith]')) {
      rows.push({ kind: 'meta', content: text, marker: '', oldLine: null, newLine: null })
      inHunk = false
      continue
    }

    if (!inHunk) {
      if (
        text.startsWith('Binary files ') ||
        text.startsWith('GIT binary patch') ||
        text.startsWith('rename from ') ||
        text.startsWith('rename to ')
      ) {
        rows.push({ kind: 'meta', content: text, marker: '', oldLine: null, newLine: null })
      }
      continue
    }

    if (text.startsWith('\\')) {
      rows.push({ kind: 'meta', content: text, marker: '', oldLine: null, newLine: null })
      continue
    }
    if (text.startsWith('+')) {
      rows.push({ kind: 'addition', content: text.slice(1), marker: '+', oldLine: null, newLine })
      newLine += 1
      continue
    }
    if (text.startsWith('-')) {
      rows.push({ kind: 'deletion', content: text.slice(1), marker: '-', oldLine, newLine: null })
      oldLine += 1
      continue
    }
    if (text.startsWith(' ')) {
      rows.push({ kind: 'context', content: text.slice(1), marker: ' ', oldLine, newLine })
      oldLine += 1
      newLine += 1
      continue
    }

    // A bare trailing newline is a separator, not a numbered context line.
    inHunk = false
  }

  return rows
}

function WorkbenchEmpty({
  title,
  description,
  action,
  error = false
}: {
  title: string
  description: string
  action?: () => void
  error?: boolean
}): JSX.Element {
  return (
    <div className={`workbench-empty-state ${error ? 'is-error' : ''}`} role={error ? 'alert' : undefined}>
      <span className="workbench-empty-icon"><FileIcon size={17} /></span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action && <button type="button" onClick={action}>Refresh</button>}
    </div>
  )
}

export default function BottomWorkbench({
  activeProject,
  open,
  refreshKey,
  embedded = false
}: BottomWorkbenchProps): JSX.Element | null {
  const [changes, setChanges] = useState<GitStatusResult | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [busy, setBusy] = useState(false)
  const [diffBusy, setDiffBusy] = useState(false)
  const [diffRevision, setDiffRevision] = useState(0)
  const [visibleDiffRowCount, setVisibleDiffRowCount] = useState(DIFF_ROW_PAGE_SIZE)
  const [error, setError] = useState<string | null>(null)
  const loadSequenceRef = useRef(0)

  const files = changes?.ok && changes.isRepo ? changes.files : []
  const selected = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath]
  )
  const diffRows = useMemo(() => parseDiffRows(diff), [diff])
  const visibleDiffRows = useMemo(
    () => diffRows.slice(0, visibleDiffRowCount),
    [diffRows, visibleDiffRowCount]
  )
  const totalAdditions = files.reduce((total, file) => total + file.additions, 0)
  const totalDeletions = files.reduce((total, file) => total + file.deletions, 0)

  const load = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequenceRef.current
    if (!activeProject?.path) {
      setChanges(null)
      setSelectedPath(null)
      setBusy(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.git.status(activeProject.path)
      if (sequence !== loadSequenceRef.current) return
      setChanges(result)
      setDiffRevision((revision) => revision + 1)
      if (result.ok && result.isRepo) {
        setSelectedPath((current) =>
          result.files.some((file) => file.path === current)
            ? current
            : result.files[0]?.path ?? null
        )
      } else {
        setSelectedPath(null)
      }
    } catch (nextError) {
      if (sequence !== loadSequenceRef.current) return
      setChanges({ ok: false, error: nextError instanceof Error ? nextError.message : String(nextError) })
      setSelectedPath(null)
    } finally {
      if (sequence === loadSequenceRef.current) setBusy(false)
    }
  }, [activeProject?.path])

  useEffect(() => {
    if (open) void load()
  }, [open, load, refreshKey])

  useEffect(() => {
    if (!open || !activeProject?.path || !selectedPath) {
      setDiff('')
      setDiffBusy(false)
      return
    }
    let cancelled = false
    setDiffBusy(true)
    setError(null)
    void window.api.git.diff(activeProject.path, selectedPath)
      .then((result) => {
        if (cancelled) return
        if (result.ok) setDiff(result.diff)
        else {
          setDiff('')
          setError(result.error)
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setDiff('')
          setError(nextError instanceof Error ? nextError.message : String(nextError))
        }
      })
      .finally(() => {
        if (!cancelled) setDiffBusy(false)
      })
    return () => { cancelled = true }
  }, [activeProject?.path, diffRevision, open, selectedPath])

  useEffect(() => {
    setVisibleDiffRowCount(DIFF_ROW_PAGE_SIZE)
  }, [diff, selectedPath])

  const toggleStaged = async (file: GitChangeFile): Promise<void> => {
    if (!activeProject?.path) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.git.setStaged(activeProject.path, file.path, !file.staged)
      if (!result.ok) {
        setError(result.error ?? 'Git operation failed.')
        return
      }
      await load()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setBusy(false)
    }
  }

  const navigateFileTabs = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex = index
    if (event.key === 'ArrowLeft') nextIndex = index > 0 ? index - 1 : files.length - 1
    else if (event.key === 'ArrowRight') nextIndex = index < files.length - 1 ? index + 1 : 0
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = files.length - 1
    else return
    event.preventDefault()
    const next = files[nextIndex]
    if (!next) return
    setSelectedPath(next.path)
    window.requestAnimationFrame(() => document.getElementById(`workbench-file-tab-${nextIndex}`)?.focus())
  }

  if (!open) return null

  return (
    <section
      className={`workbench ${embedded ? 'is-embedded' : ''}`}
      aria-label="Project changes"
      aria-busy={busy || diffBusy}
    >
      <div className="workbench-tabs">
        <div className="workbench-tab-group">
          <strong className="workbench-tab is-active">Changes</strong>
          {changes?.ok && changes.isRepo && (
            <span className="workbench-branch" title={`Current branch: ${changes.branch}`}>{changes.branch}</span>
          )}
        </div>
        <div className="workbench-spacer" />
        {changes?.ok && changes.isRepo && (
          <span className="workbench-toolbar-summary">
            {files.length} files <b>+{totalAdditions}</b> <i>−{totalDeletions}</i>
          </span>
        )}
        <button type="button" className="workbench-action" disabled={busy} onClick={() => void load()}>
          {busy ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      {!activeProject?.path
        ? <WorkbenchEmpty title="No project open" description="Open a project to review its working-tree changes." />
        : !changes
          ? <WorkbenchEmpty title="Reading changes" description="Akorith is checking this project's Git working tree." />
          : !changes.ok
            ? <WorkbenchEmpty title="Review unavailable" description={changes.error} action={() => void load()} error />
            : !changes.isRepo
              ? <WorkbenchEmpty title="Git repository required" description="Initialize Git in this project to inspect file changes here." action={() => void load()} />
              : changes.clean
                ? <WorkbenchEmpty title="Working tree clean" description="There are no staged or unstaged changes to review." action={() => void load()} />
                : (
                  <div className="workbench-review">
                    <nav className="workbench-file-tabs" role="tablist" aria-label="Changed files">
                      {files.map((file, index) => (
                        <button
                          type="button"
                          role="tab"
                          id={`workbench-file-tab-${index}`}
                          aria-controls="workbench-diff-panel"
                          aria-selected={selectedPath === file.path}
                          tabIndex={selectedPath === file.path ? 0 : -1}
                          key={file.path}
                          className={`workbench-file-tab ${selectedPath === file.path ? 'is-active' : ''}`}
                          title={file.path}
                          onClick={() => setSelectedPath(file.path)}
                          onKeyDown={(event) => navigateFileTabs(event, index)}
                        >
                          <span className={`workbench-file-status status-${statusWord(file.status)}`}>{file.status}</span>
                          <span className="workbench-file-name"><FileIcon size={12} />{file.path}</span>
                          <span className="workbench-file-counts">
                            {file.additions > 0 && <b>+{file.additions}</b>}
                            {file.deletions > 0 && <i>−{file.deletions}</i>}
                          </span>
                          {file.staged && <em title="Staged">●</em>}
                        </button>
                      ))}
                    </nav>

                    <div
                      className="workbench-diff"
                      id="workbench-diff-panel"
                      role="tabpanel"
                      aria-labelledby={`workbench-file-tab-${Math.max(0, files.findIndex((file) => file.path === selectedPath))}`}
                    >
                      {selected && (
                        <div className="workbench-diff-head">
                          <div className="workbench-diff-title">
                            <FileIcon size={13} />
                            <strong>{selected.path}</strong>
                            <span className={`status-${statusWord(selected.status)}`}>{statusWord(selected.status)}</span>
                            <span className="workbench-selected-counts">
                              <b>+{selected.additions}</b>
                              <i>−{selected.deletions}</i>
                            </span>
                          </div>
                          <div>
                            <button
                              type="button"
                              aria-label={`Reveal ${selected.path}`}
                              onClick={() => void window.api.git.revealFile(activeProject.path!, selected.path)}
                            >
                              Reveal
                            </button>
                            <button
                              type="button"
                              className={selected.staged ? '' : 'is-primary'}
                              aria-label={`${selected.staged ? 'Unstage' : 'Stage'} ${selected.path}`}
                              disabled={busy}
                              onClick={() => void toggleStaged(selected)}
                            >
                              {selected.staged ? 'Unstage' : 'Stage'}
                            </button>
                          </div>
                        </div>
                      )}
                      {error && <div className="workbench-inline-error" role="alert">{error}</div>}
                      {diffBusy
                        ? <WorkbenchEmpty title="Reading diff" description="Preparing the selected file for review." />
                        : diffRows.length > 0
                          ? (
                            <div className="workbench-diff-scroll">
                              <div className="workbench-diff-lines" role="table" aria-label={selected ? `Unified diff for ${selected.path}` : 'Unified diff'}>
                                {visibleDiffRows.map((row, index) => (
                                  <div
                                    className={`workbench-diff-line is-${row.kind}`}
                                    role="row"
                                    aria-label={lineLabel(row)}
                                    key={`${row.oldLine ?? 'x'}-${row.newLine ?? 'x'}-${index}`}
                                  >
                                    <span className="workbench-line-number is-old" role="cell" aria-hidden="true">{row.oldLine ?? ''}</span>
                                    <span className="workbench-line-number is-new" role="cell" aria-hidden="true">{row.newLine ?? ''}</span>
                                    <span className="workbench-line-marker" role="cell" aria-hidden="true">{row.marker}</span>
                                    <code role="cell">{row.content || ' '}</code>
                                  </div>
                                ))}
                              </div>
                              {visibleDiffRows.length < diffRows.length && (
                                <button
                                  type="button"
                                  className="workbench-load-more"
                                  onClick={() => startTransition(() => {
                                    setVisibleDiffRowCount((current) => Math.min(current + DIFF_ROW_PAGE_SIZE, diffRows.length))
                                  })}
                                >
                                  Show next {Math.min(DIFF_ROW_PAGE_SIZE, diffRows.length - visibleDiffRows.length)} lines
                                  <small>{diffRows.length - visibleDiffRows.length} remaining</small>
                                </button>
                              )}
                            </div>
                          )
                          : <WorkbenchEmpty title="No textual diff" description="This file has no text changes that can be displayed." />}
                    </div>
                  </div>
                )}
    </section>
  )
}
