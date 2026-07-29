import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { GitChangeFile, GitStatusResult, ProjectRow } from '../../../preload/index.d'
import { buildWorkspaceFileTree, type WorkspaceTreeNode } from '../workspaceFileTree'
import { highlightWorkspaceCode } from '../workspaceSyntax'
import { ChevronIcon, FileIcon, FolderIcon, MoreIcon, RefreshIcon, SearchIcon } from './icons'

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

function ChangedFilesTree({
  nodes,
  filesByPath,
  depth,
  expanded,
  selectedPath,
  queryActive,
  onToggle,
  onSelect,
  onToggleStaged
}: {
  nodes: WorkspaceTreeNode[]
  filesByPath: Map<string, GitChangeFile>
  depth: number
  expanded: Set<string>
  selectedPath: string | null
  queryActive: boolean
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  onToggleStaged: (file: GitChangeFile) => void
}): JSX.Element {
  return (
    <>
      {nodes.map((node) => {
        if (!node.file) {
          const isExpanded = queryActive || expanded.has(node.path)
          return (
            <div key={node.path}>
              <button
                type="button"
                className="workbench-tree-row is-directory"
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => onToggle(node.path)}
              >
                <ChevronIcon size={12} direction={isExpanded ? 'down' : 'right'} />
                <FolderIcon size={13} />
                <span>{node.name}</span>
              </button>
              {isExpanded && (
                <ChangedFilesTree
                  nodes={node.children}
                  filesByPath={filesByPath}
                  depth={depth + 1}
                  expanded={expanded}
                  selectedPath={selectedPath}
                  queryActive={queryActive}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  onToggleStaged={onToggleStaged}
                />
              )}
            </div>
          )
        }

        const file = filesByPath.get(node.path)
        if (!file) return null
        return (
          <div
            className={`workbench-tree-row is-file ${selectedPath === file.path ? 'is-active' : ''}`}
            style={{ paddingLeft: 24 + depth * 14 }}
            key={file.path}
          >
            <button type="button" className="workbench-tree-file-select" title={file.path} onClick={() => onSelect(file.path)}>
              <span className={`workbench-file-status status-${statusWord(file.status)}`}>{file.status}</span>
              <FileIcon size={13} />
              <span>{node.name}</span>
              <span className="workbench-file-counts">
                {file.additions > 0 && <b>+{file.additions}</b>}
                {file.deletions > 0 && <i>−{file.deletions}</i>}
              </span>
            </button>
            <button
              type="button"
              className={`workbench-tree-stage ${file.staged ? 'is-staged' : ''}`}
              title={file.staged ? `Unstage ${file.path}` : `Stage ${file.path}`}
              aria-label={file.staged ? `Unstage ${file.path}` : `Stage ${file.path}`}
              onClick={() => onToggleStaged(file)}
            >
              <span />
            </button>
          </div>
        )
      })}
    </>
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
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const loadSequenceRef = useRef(0)

  const files = changes?.ok && changes.isRepo ? changes.files : []
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const filteredFiles = useMemo(
    () => deferredQuery ? files.filter((file) => file.path.toLowerCase().includes(deferredQuery)) : files,
    [deferredQuery, files]
  )
  const filesByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files])
  const changedFileTree = useMemo(() => buildWorkspaceFileTree(filteredFiles.map((file) => file.path)), [filteredFiles])
  const selected = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath]
  )
  const diffRows = useMemo(() => parseDiffRows(diff), [diff])
  const visibleDiffRows = useMemo(
    () => diffRows.slice(0, visibleDiffRowCount),
    [diffRows, visibleDiffRowCount]
  )
  const visibleDiffTokens = useMemo(
    () => visibleDiffRows.map((row) =>
      selectedPath ? highlightWorkspaceCode(row.content, selectedPath)[0]?.tokens ?? [] : []
    ),
    [selectedPath, visibleDiffRows]
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
        const nextTree = buildWorkspaceFileTree(result.files.map((file) => file.path))
        setExpanded(nextTree.directories)
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

  if (!open) return null

  return (
    <section
      className={`workbench ${embedded ? 'is-embedded' : ''}`}
      aria-label="Project changes"
      aria-busy={busy || diffBusy}
    >
      <div className="workbench-scm-toolbar">
        <div className="workbench-scm-branch">
          <button type="button" title="Current branch">
            Branch <ChevronIcon size={12} direction="down" />
          </button>
          {changes?.ok && changes.isRepo && (
            <span className="workbench-toolbar-summary">
              <b>+{totalAdditions}</b> <i>−{totalDeletions}</i>
            </span>
          )}
        </div>
        <div className="workbench-scm-actions">
          <button type="button" className="is-icon" title="More review actions" aria-label="More review actions">
            <MoreIcon size={14} />
          </button>
          <button
            type="button"
            className="is-icon"
            disabled={busy}
            title="Refresh changes"
            aria-label="Refresh changes"
            onClick={() => void load()}
          >
            <RefreshIcon size={14} />
          </button>
          <button
            type="button"
            className="workbench-commit-action"
            disabled={!changes?.ok || !changes.isRepo || changes.clean}
            onClick={() => window.dispatchEvent(new CustomEvent('akorith:request-git-action'))}
          >
            Commit or push <ChevronIcon size={12} direction="down" />
          </button>
        </div>
      </div>
      {changes?.ok && changes.isRepo && (
        <div className="workbench-branch-route">
          <span>{changes.branch}</span>
          {changes.upstream && (
            <>
              <span aria-hidden="true">→</span>
              <span>{changes.upstream}</span>
            </>
          )}
        </div>
      )}
      {changes?.ok && changes.isRepo && changes.truncated && (
        <div className="workbench-truncation-notice" role="status">
          <div>
            <strong>Showing the first {files.length} changed files</strong>
            <span>Review is bounded to keep the workspace responsive. Narrow the project changes, then refresh.</span>
          </div>
          <button type="button" disabled={busy} onClick={() => void load()}>Refresh</button>
        </div>
      )}

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
                    <div
                      className="workbench-diff"
                      id="workbench-diff-panel"
                      role="region"
                      aria-label={selected ? `Diff for ${selected.path}` : 'Changed file diff'}
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
                                    <code role="cell">
                                      {visibleDiffTokens[index]?.length
                                        ? visibleDiffTokens[index].map((token, tokenIndex) => (
                                            <span className={`workspace-syntax-token is-${token.kind}`} key={tokenIndex}>{token.text}</span>
                                          ))
                                        : row.content || ' '}
                                    </code>
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
                    <aside className="workbench-changes-tree" aria-label="Changed files">
                      <label className="workbench-changes-filter">
                        <SearchIcon size={13} />
                        <input
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          placeholder="Filter files…"
                          aria-label="Filter changed files"
                        />
                      </label>
                      <div className="workbench-changes-tree-body">
                        {changedFileTree.tree.length > 0
                          ? (
                            <ChangedFilesTree
                              nodes={changedFileTree.tree}
                              filesByPath={filesByPath}
                              depth={0}
                              expanded={expanded}
                              selectedPath={selectedPath}
                              queryActive={Boolean(deferredQuery)}
                              onToggle={(path) => setExpanded((current) => {
                                const next = new Set(current)
                                if (next.has(path)) next.delete(path)
                                else next.add(path)
                                return next
                              })}
                              onSelect={setSelectedPath}
                              onToggleStaged={(file) => void toggleStaged(file)}
                            />
                          )
                          : <WorkbenchEmpty title="No matching files" description="Try a different file filter." />}
                      </div>
                    </aside>
                  </div>
                )}
    </section>
  )
}
