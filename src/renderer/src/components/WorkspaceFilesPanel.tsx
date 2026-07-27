import { useEffect, useState } from 'react'
import type { ProjectRow } from '../../../preload/index.d'
import { buildWorkspaceFileTree, type WorkspaceTreeNode } from '../workspaceFileTree'
import { ChevronIcon, EditIcon, FileIcon, FolderIcon, SearchIcon } from './icons'

function TreeBranch({
  nodes,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect
}: {
  nodes: WorkspaceTreeNode[]
  depth: number
  expanded: Set<string>
  selected: string | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}): JSX.Element {
  return (
    <>
      {nodes.map((node) => node.file
        ? (
          <button
            type="button"
            className={`workspace-tree-row is-file ${selected === node.path ? 'is-active' : ''}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => onSelect(node.path)}
            key={node.path}
          >
            <span className="workspace-tree-spacer" />
            <FileIcon size={13} />
            <span>{node.name}</span>
          </button>
        )
        : (
          <div key={node.path}>
            <button
              type="button"
              className="workspace-tree-row is-directory"
              style={{ paddingLeft: 6 + depth * 14 }}
              onClick={() => onToggle(node.path)}
            >
              <ChevronIcon size={12} direction={expanded.has(node.path) ? 'down' : 'right'} />
              <FolderIcon size={13} />
              <span>{node.name}</span>
            </button>
            {expanded.has(node.path) && (
              <TreeBranch
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </div>
        ))}
    </>
  )
}

export default function WorkspaceFilesPanel({ project }: { project: ProjectRow }): JSX.Element {
  const [files, setFiles] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [settledQuery, setSettledQuery] = useState('')
  const [tree, setTree] = useState<WorkspaceTreeNode[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [content, setContent] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadSignal, setReloadSignal] = useState(0)

  useEffect(() => {
    if (query === settledQuery) return
    const timer = window.setTimeout(() => setSettledQuery(query), 160)
    return () => window.clearTimeout(timer)
  }, [query, settledQuery])

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    void window.api.projects.files(project.id, settledQuery).then((next) => {
      if (cancelled) return
      const nextIndex = buildWorkspaceFileTree(next)
      setFiles(next)
      setTree(nextIndex.tree)
      setSelected((current) => current && next.includes(current)
        ? current
        : next.find((path) => /(^|\/)(?:index\.html|package\.json|readme\.md)$/i.test(path)) ?? next[0] ?? null)
      setExpanded(nextIndex.directories)
      setError(null)
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!cancelled) setBusy(false)
    })
    return () => { cancelled = true }
  }, [project.id, settledQuery, reloadSignal])

  useEffect(() => {
    if (!selected) { setContent(''); return }
    let cancelled = false
    setBusy(true)
    void window.api.projects.readFile(project.id, selected).then((result) => {
      if (cancelled) return
      if (result.ok) {
        setContent(result.content)
        setTruncated(result.truncated)
        setError(null)
      } else {
        setContent('')
        setTruncated(false)
        setError(result.error)
      }
    }).finally(() => {
      if (!cancelled) setBusy(false)
    })
    return () => { cancelled = true }
  }, [project.id, selected])

  const requestEdit = (): void => {
    if (!selected) return
    window.dispatchEvent(new CustomEvent('akorith:request-file-edit', { detail: { path: selected } }))
  }

  return (
    <section className="workspace-files-panel">
      <aside className="workspace-file-tree">
        <label className="workspace-file-search">
          <SearchIcon size={13} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter files" />
        </label>
        <div className="workspace-file-tree-head"><span>{project.name}</span><small>{files.length} files</small></div>
        <div className="workspace-file-tree-body">
          {tree.length > 0
            ? <TreeBranch nodes={tree} depth={0} expanded={expanded} selected={selected} onToggle={(path) => setExpanded((current) => {
                const next = new Set(current)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })} onSelect={setSelected} />
            : (
              <div className="workspace-tool-empty-state">
                <span><FolderIcon size={17} /></span>
                <strong>{busy ? 'Reading project files' : 'No reviewable files'}</strong>
                <p>{busy ? 'Building a safe, project-scoped file index.' : 'Add a text or code file, then refresh this view.'}</p>
                {!busy && <button type="button" onClick={() => setReloadSignal((value) => value + 1)}>Refresh files</button>}
              </div>
            )}
        </div>
      </aside>
      <div className="workspace-code-review">
        <header>
          <div><strong>{selected ?? 'Select a file'}</strong>{truncated && <small>Preview truncated</small>}</div>
          <button type="button" disabled={!selected} onClick={requestEdit}><EditIcon size={13} />Ask Akorith to edit</button>
        </header>
        {error
          ? (
            <div className="workspace-tool-empty-state is-error">
              <span><FileIcon size={17} /></span>
              <strong>File preview unavailable</strong>
              <p>{error}</p>
            </div>
          )
          : selected
            ? <pre><code>{content}</code></pre>
            : (
              <div className="workspace-tool-empty-state">
                <span><FileIcon size={17} /></span>
                <strong>Select a file</strong>
                <p>Choose a file from the directory tree to review its contents.</p>
              </div>
            )}
      </div>
    </section>
  )
}
