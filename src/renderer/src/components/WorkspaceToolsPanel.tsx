import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { ProjectRow } from '../../../preload/index.d'
import {
  CloseIcon,
  FolderIcon,
  GlobeIcon,
  PanelsIcon,
  QueueIcon
} from './icons'

const BottomWorkbench = lazy(() => import('./BottomWorkbench'))
const ProjectPreviewPanel = lazy(() =>
  import('./ProjectPreviewPanel').then((module) => ({ default: module.ProjectPreviewPanel }))
)
const TerminalPane = lazy(() => import('./TerminalPane'))
const WorkspaceFilesPanel = lazy(() => import('./WorkspaceFilesPanel'))

export type WorkspaceToolId = 'review' | 'terminal' | 'browser' | 'computer' | 'files'

export interface WorkspaceToolRequest {
  projectId: string
  tool: WorkspaceToolId
  nonce: number
}

const PANEL_WIDTH_MIN = 520
const PANEL_WIDTH_DEFAULT = 720
const PANEL_WIDTH_MAX = 980

const TOOLS: Array<{
  id: WorkspaceToolId
  label: string
  shortcut?: string
  icon: typeof QueueIcon
}> = [
  { id: 'review', label: 'Review', shortcut: 'Ctrl+Shift+G', icon: QueueIcon },
  { id: 'terminal', label: 'Terminal', icon: PanelsIcon },
  { id: 'browser', label: 'Browser', shortcut: 'Ctrl+T', icon: GlobeIcon },
  { id: 'computer', label: 'Computer Use', icon: PanelsIcon },
  { id: 'files', label: 'Files', shortcut: 'Ctrl+P', icon: FolderIcon }
]

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function panelMax(): number {
  if (typeof window === 'undefined') return PANEL_WIDTH_MAX
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, window.innerWidth - 420))
}

function storedPanelWidth(): number {
  try {
    const raw = localStorage.getItem('akorith.workspaceToolsWidth')
    const value = raw === null ? PANEL_WIDTH_DEFAULT : Number(raw)
    return Number.isFinite(value) ? clamp(value, PANEL_WIDTH_MIN, panelMax()) : PANEL_WIDTH_DEFAULT
  } catch {
    return PANEL_WIDTH_DEFAULT
  }
}

function ToolPaneFallback({ label }: { label: string }): JSX.Element {
  return (
    <div className="workspace-tool-loading" role="status" aria-live="polite">
      {label}
    </div>
  )
}

export default function WorkspaceToolsPanel({
  project,
  open,
  active,
  refreshKey,
  requestedTool,
  onOpen,
  onClose
}: {
  project: ProjectRow | null
  open: boolean
  active: boolean
  refreshKey?: string | number
  requestedTool?: WorkspaceToolRequest | null
  onOpen: () => void
  onClose: () => void
}): JSX.Element | null {
  const [activeTool, setActiveTool] = useState<WorkspaceToolId | null>(null)
  const [openTabs, setOpenTabs] = useState<WorkspaceToolId[]>([])
  const [mountedTools, setMountedTools] = useState<Set<WorkspaceToolId>>(() => new Set())
  const [width, setWidth] = useState(storedPanelWidth)
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const handledRequestRef = useRef<number | null>(null)

  const openTool = useCallback((tool: WorkspaceToolId): void => {
    setOpenTabs((current) => current.includes(tool) ? current : [...current, tool])
    setMountedTools((current) => {
      if (current.has(tool)) return current
      const next = new Set(current)
      next.add(tool)
      return next
    })
    setActiveTool(tool)
    onOpen()
  }, [onOpen])

  useEffect(() => {
    if (
      !project ||
      !requestedTool ||
      requestedTool.projectId !== project.id ||
      handledRequestRef.current === requestedTool.nonce
    ) return
    handledRequestRef.current = requestedTool.nonce
    openTool(requestedTool.tool)
  }, [openTool, project, requestedTool])

  useEffect(() => {
    try { localStorage.setItem('akorith.workspaceToolsWidth', String(width)) } catch { /* ignore */ }
  }, [width])

  useEffect(() => {
    if (!active) return
    const handleShortcut = (event: globalThis.KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      const tool = event.shiftKey && key === 'g'
        ? 'review'
        : !event.shiftKey && key === 't'
          ? 'browser'
          : !event.shiftKey && key === 'p'
            ? 'files'
            : null
      if (!tool) return
      event.preventDefault()
      openTool(tool)
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [active, openTool])

  if (!project?.path) return null

  const terminalId = `workspace-shell::${project.id.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 40)}`
  const previewActive = activeTool === 'browser' || activeTool === 'computer'
  const previewMounted = mountedTools.has('browser') || mountedTools.has('computer')

  const closeTab = (tool: WorkspaceToolId): void => {
    const index = openTabs.indexOf(tool)
    const next = openTabs.filter((item) => item !== tool)
    const nextActive = activeTool === tool
      ? next[index] ?? next[index - 1] ?? null
      : activeTool
    setOpenTabs(next)
    setMountedTools((current) => {
      if (!current.has(tool)) return current
      const mounted = new Set(current)
      mounted.delete(tool)
      return mounted
    })
    if (activeTool === tool) setActiveTool(nextActive)
    window.requestAnimationFrame(() => {
      if (nextActive) document.getElementById(`workspace-tool-tab-${nextActive}`)?.focus()
    })
  }

  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, tool: WorkspaceToolId): void => {
    if (event.key === 'Delete') {
      event.preventDefault()
      closeTab(tool)
      return
    }
    const index = openTabs.indexOf(tool)
    let nextIndex = index
    if (event.key === 'ArrowLeft') nextIndex = index > 0 ? index - 1 : openTabs.length - 1
    else if (event.key === 'ArrowRight') nextIndex = index < openTabs.length - 1 ? index + 1 : 0
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = openTabs.length - 1
    else return
    event.preventDefault()
    const next = openTabs[nextIndex]
    if (!next) return
    setActiveTool(next)
    window.requestAnimationFrame(() => document.getElementById(`workspace-tool-tab-${next}`)?.focus())
  }

  const startWidthResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width }
  }

  const moveWidthResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    setWidth(clamp(resize.startWidth + resize.startX - event.clientX, PANEL_WIDTH_MIN, panelMax()))
  }

  const stopWidthResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (resizeRef.current?.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    resizeRef.current = null
  }

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setWidth((value) =>
      clamp(value + (event.key === 'ArrowLeft' ? 24 : -24), PANEL_WIDTH_MIN, panelMax())
    )
  }

  return (
    <aside
      className={`workspace-tools ${open ? 'is-open' : 'is-closed'}`}
      aria-label="Workspace tools"
      aria-hidden={!open}
      style={{ '--workspace-tools-width': `${width}px` } as CSSProperties}
    >
      {open && (
        <div
          className="workspace-tools-resizer"
          role="separator"
          aria-label="Resize workspace tools"
          aria-orientation="vertical"
          aria-valuemin={PANEL_WIDTH_MIN}
          aria-valuemax={panelMax()}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={startWidthResize}
          onPointerMove={moveWidthResize}
          onPointerUp={stopWidthResize}
          onPointerCancel={stopWidthResize}
          onLostPointerCapture={() => { resizeRef.current = null }}
          onKeyDown={resizeWithKeyboard}
          onDoubleClick={() => setWidth(clamp(PANEL_WIDTH_DEFAULT, PANEL_WIDTH_MIN, panelMax()))}
        />
      )}

      {open && (
        <nav className="workspace-tool-tabs" aria-label="Open workspace tools">
          <div className="workspace-tool-tab-list" role="tablist">
            {openTabs.map((tool) => {
              const item = TOOLS.find((candidate) => candidate.id === tool)!
              const Icon = item.icon
              const selected = activeTool === tool
              return (
                <div className={`workspace-tool-tab ${selected ? 'is-active' : ''}`} role="presentation" key={tool}>
                  <button
                    type="button"
                    className="workspace-tool-tab-select"
                    role="tab"
                    id={`workspace-tool-tab-${tool}`}
                    aria-controls={`workspace-tool-panel-${tool === 'browser' || tool === 'computer' ? 'preview' : tool}`}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setActiveTool(tool)}
                    onKeyDown={(event) => navigateTabs(event, tool)}
                  >
                    <Icon size={13} />
                    <span>{item.label}</span>
                  </button>
                  <button
                    type="button"
                    className="workspace-tool-tab-close"
                    aria-label={`Close ${item.label}`}
                    onClick={() => closeTab(tool)}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              )
            })}
          </div>
          <button
            type="button"
            className="workspace-tools-close"
            aria-label="Close workspace tools"
            title="Close workspace tools"
            onClick={onClose}
          >
            <PanelsIcon size={15} />
          </button>
        </nav>
      )}

      <div className={`workspace-tools-content ${openTabs.length > 0 ? 'has-tabs' : 'is-launcher'}`}>
        {openTabs.length === 0 && (
          <div className="workspace-tools-launcher">
            <div className="workspace-tools-cards" aria-label="Choose a workspace tool">
              {TOOLS.map((item) => {
                const Icon = item.icon
                return (
                  <button type="button" key={item.id} onClick={() => openTool(item.id)}>
                    <Icon size={14} />
                    <strong>{item.label}</strong>
                    {item.shortcut ? <kbd>{item.shortcut}</kbd> : <span aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        <section
          className={`workspace-tool-pane is-review ${activeTool === 'review' ? 'is-active' : ''}`}
          id="workspace-tool-panel-review"
          role="tabpanel"
          aria-labelledby="workspace-tool-tab-review"
          aria-hidden={activeTool !== 'review'}
        >
          {mountedTools.has('review') && (
            <Suspense fallback={<ToolPaneFallback label="Opening Review…" />}>
              <BottomWorkbench
                activeProject={project}
                open={open && activeTool === 'review'}
                refreshKey={refreshKey}
                embedded
              />
            </Suspense>
          )}
        </section>

        <section
          className={`workspace-tool-pane is-terminal ${activeTool === 'terminal' ? 'is-active' : ''}`}
          id="workspace-tool-panel-terminal"
          role="tabpanel"
          aria-labelledby="workspace-tool-tab-terminal"
          aria-hidden={activeTool !== 'terminal'}
        >
          {mountedTools.has('terminal') && (
            <Suspense fallback={<ToolPaneFallback label="Opening Terminal…" />}>
              <div className="workspace-terminal-shell">
                <TerminalPane
                  id={terminalId}
                  title="Terminal"
                  identity="terminal"
                  cwd={project.path}
                  commandKind="shell"
                  active={active && open && activeTool === 'terminal'}
                />
              </div>
            </Suspense>
          )}
        </section>

        <section
          className={`workspace-tool-pane is-preview ${previewActive ? 'is-active' : ''}`}
          id="workspace-tool-panel-preview"
          role="tabpanel"
          aria-labelledby={activeTool === 'computer' ? 'workspace-tool-tab-computer' : 'workspace-tool-tab-browser'}
          aria-hidden={!previewActive}
        >
          {previewMounted && (
            <Suspense fallback={<ToolPaneFallback label={`Opening ${activeTool === 'computer' ? 'Computer Use' : 'Browser'}…`} />}>
              <ProjectPreviewPanel
                projectPath={project.path}
                projectName={project.name}
                active={active && open && previewActive}
                refreshKey={refreshKey}
                variant="workspace"
                title={activeTool === 'computer' ? 'Computer Use' : 'Browser'}
                interactive={activeTool === 'computer'}
              />
            </Suspense>
          )}
        </section>

        <section
          className={`workspace-tool-pane is-files ${activeTool === 'files' ? 'is-active' : ''}`}
          id="workspace-tool-panel-files"
          role="tabpanel"
          aria-labelledby="workspace-tool-tab-files"
          aria-hidden={activeTool !== 'files'}
        >
          {mountedTools.has('files') && (
            <Suspense fallback={<ToolPaneFallback label="Opening Files…" />}>
              <WorkspaceFilesPanel project={project} />
            </Suspense>
          )}
        </section>
      </div>
    </aside>
  )
}
