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
import type { WorkspaceWorkflowSnapshot } from '../workspaceWorkflow'
import {
  CloseIcon,
  FolderIcon,
  GlobeIcon,
  PanelsIcon,
  PlanIcon,
  PlusIcon,
  QueueIcon
} from './icons'

const BottomWorkbench = lazy(() => import('./BottomWorkbench'))
const ProjectPreviewPanel = lazy(() =>
  import('./ProjectPreviewPanel').then((module) => ({ default: module.ProjectPreviewPanel }))
)
const TerminalPane = lazy(() => import('./TerminalPane'))
const WorkspaceFilesPanel = lazy(() => import('./WorkspaceFilesPanel'))
const WorkspaceStepsPanel = lazy(() => import('./WorkspaceStepsPanel'))

export type WorkspaceToolId = 'steps' | 'review' | 'terminal' | 'browser' | 'computer' | 'files'

export interface WorkspaceToolRequest {
  projectId: string
  tool: WorkspaceToolId
  nonce: number
}

interface WorkspaceToolTab {
  id: string
  tool: WorkspaceToolId | null
  title: string
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
  { id: 'steps', label: 'Steps', icon: PlanIcon },
  { id: 'review', label: 'Review', shortcut: 'Ctrl+Shift+G', icon: QueueIcon },
  { id: 'terminal', label: 'Terminal', icon: PanelsIcon },
  { id: 'browser', label: 'Browser', shortcut: 'Ctrl+T', icon: GlobeIcon },
  { id: 'computer', label: 'Computer Use', icon: PanelsIcon },
  { id: 'files', label: 'Files', shortcut: 'Ctrl+P', icon: FolderIcon }
]

function titleForTool(tool: WorkspaceToolId): string {
  if (tool === 'browser') return 'New tab'
  if (tool === 'files') return 'Open file'
  return TOOLS.find((item) => item.id === tool)?.label ?? tool
}

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
  workflow,
  onOpen,
  onClose
}: {
  project: ProjectRow | null
  open: boolean
  active: boolean
  refreshKey?: string | number
  requestedTool?: WorkspaceToolRequest | null
  workflow?: WorkspaceWorkflowSnapshot | null
  onOpen: () => void
  onClose: () => void
}): JSX.Element | null {
  const tabSequenceRef = useRef(0)
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [openTabs, setOpenTabs] = useState<WorkspaceToolTab[]>([])
  const [width, setWidth] = useState(storedPanelWidth)
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const handledRequestRef = useRef<number | null>(null)

  const nextTabId = useCallback((): string => {
    tabSequenceRef.current += 1
    return `workspace-tab-${tabSequenceRef.current}`
  }, [])

  const openTool = useCallback((tool: WorkspaceToolId, reuse = true): void => {
    const existing = reuse ? openTabs.find((tab) => tab.tool === tool) : undefined
    if (existing) {
      setActiveTabId(existing.id)
      onOpen()
      return
    }
    const activeTab = openTabs.find((tab) => tab.id === activeTabId)
    if (activeTab?.tool === null) {
      setOpenTabs((current) => current.map((tab) => tab.id === activeTab.id
        ? { ...tab, tool, title: titleForTool(tool) }
        : tab))
      setActiveTabId(activeTab.id)
      onOpen()
      return
    }
    const tab: WorkspaceToolTab = { id: nextTabId(), tool, title: titleForTool(tool) }
    setOpenTabs((current) => [...current, tab])
    setActiveTabId(tab.id)
    onOpen()
  }, [activeTabId, nextTabId, onOpen, openTabs])

  const openLauncher = useCallback((): void => {
    const tab: WorkspaceToolTab = { id: nextTabId(), tool: null, title: 'New tab' }
    setOpenTabs((current) => [...current, tab])
    setActiveTabId(tab.id)
    onOpen()
  }, [nextTabId, onOpen])

  useEffect(() => {
    if (!open || openTabs.length > 0) return
    const tab: WorkspaceToolTab = { id: nextTabId(), tool: null, title: 'New tab' }
    setOpenTabs([tab])
    setActiveTabId(tab.id)
  }, [nextTabId, open, openTabs.length])

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

  const projectPath = project.path
  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null

  const closeTab = (tabId: string): void => {
    const index = openTabs.findIndex((tab) => tab.id === tabId)
    const remaining = openTabs.filter((tab) => tab.id !== tabId)
    if (remaining.length === 0) {
      const launcher: WorkspaceToolTab = { id: nextTabId(), tool: null, title: 'New tab' }
      setOpenTabs([launcher])
      setActiveTabId(launcher.id)
      window.requestAnimationFrame(() => document.getElementById(`workspace-tool-tab-${launcher.id}`)?.focus())
      return
    }
    const nextActiveId = activeTabId === tabId
      ? remaining[index]?.id ?? remaining[index - 1]?.id ?? remaining[0].id
      : activeTabId
    setOpenTabs(remaining)
    setActiveTabId(nextActiveId)
    window.requestAnimationFrame(() => {
      if (nextActiveId) document.getElementById(`workspace-tool-tab-${nextActiveId}`)?.focus()
    })
  }

  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, tabId: string): void => {
    if (event.key === 'Delete') {
      event.preventDefault()
      closeTab(tabId)
      return
    }
    const index = openTabs.findIndex((tab) => tab.id === tabId)
    let nextIndex = index
    if (event.key === 'ArrowLeft') nextIndex = index > 0 ? index - 1 : openTabs.length - 1
    else if (event.key === 'ArrowRight') nextIndex = index < openTabs.length - 1 ? index + 1 : 0
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = openTabs.length - 1
    else return
    event.preventDefault()
    const next = openTabs[nextIndex]
    if (!next) return
    setActiveTabId(next.id)
    window.requestAnimationFrame(() => document.getElementById(`workspace-tool-tab-${next.id}`)?.focus())
  }

  const renameTab = (tabId: string, title: string): void => {
    setOpenTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, title } : tab))
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
            {openTabs.map((tab) => {
              const item = tab.tool ? TOOLS.find((candidate) => candidate.id === tab.tool) : null
              const Icon = item?.icon ?? GlobeIcon
              const selected = activeTabId === tab.id
              return (
                <div className={`workspace-tool-tab ${selected ? 'is-active' : ''}`} role="presentation" key={tab.id}>
                  <button
                    type="button"
                    className="workspace-tool-tab-select"
                    role="tab"
                    id={`workspace-tool-tab-${tab.id}`}
                    aria-controls={`workspace-tool-panel-${tab.id}`}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setActiveTabId(tab.id)}
                    onKeyDown={(event) => navigateTabs(event, tab.id)}
                  >
                    <Icon size={13} />
                    <span>{tab.title}</span>
                  </button>
                  <button
                    type="button"
                    className="workspace-tool-tab-close"
                    aria-label={`Close ${tab.title}`}
                    onClick={() => closeTab(tab.id)}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              )
            })}
            <button
              type="button"
              className="workspace-tool-tab-add"
              aria-label="Open a new tool tab"
              title="New tab"
              onClick={openLauncher}
            >
              <PlusIcon size={14} />
            </button>
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
        {activeTab?.tool === null && (
          <div
            className="workspace-tools-launcher"
            id={`workspace-tool-panel-${activeTab.id}`}
            role="tabpanel"
            aria-labelledby={`workspace-tool-tab-${activeTab.id}`}
          >
            <div className="workspace-tools-cards" aria-label="Choose a workspace tool">
              {TOOLS.map((item) => {
                const Icon = item.icon
                return (
                  <button type="button" key={item.id} onClick={() => openTool(item.id, false)}>
                    <Icon size={14} />
                    <strong>{item.label}</strong>
                    {item.shortcut ? <kbd>{item.shortcut}</kbd> : <span aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {openTabs.filter((tab) => tab.tool !== null).map((tab) => {
          const selected = activeTabId === tab.id
          const panelProps = {
            className: `workspace-tool-pane is-${tab.tool} ${selected ? 'is-active' : ''}`,
            id: `workspace-tool-panel-${tab.id}`,
            role: 'tabpanel',
            'aria-labelledby': `workspace-tool-tab-${tab.id}`,
            'aria-hidden': !selected
          } as const

          if (tab.tool === 'review') {
            return (
              <section {...panelProps} key={tab.id}>
                <Suspense fallback={<ToolPaneFallback label="Opening Review…" />}>
                  <BottomWorkbench activeProject={project} open={open && selected} refreshKey={refreshKey} embedded />
                </Suspense>
              </section>
            )
          }

          if (tab.tool === 'steps') {
            return (
              <section {...panelProps} key={tab.id}>
                <Suspense fallback={<ToolPaneFallback label="Opening Steps…" />}>
                  <WorkspaceStepsPanel
                    snapshot={workflow?.projectId === project.id ? workflow : null}
                    projectName={project.name}
                  />
                </Suspense>
              </section>
            )
          }

          if (tab.tool === 'terminal') {
            const terminalId = `workspace-shell::${project.id.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 32)}::${tab.id}`
            return (
              <section {...panelProps} key={tab.id}>
                <Suspense fallback={<ToolPaneFallback label="Opening Terminal…" />}>
                  <div className="workspace-terminal-shell">
                    <TerminalPane
                      id={terminalId}
                      title="Terminal"
                      identity="terminal"
                      cwd={projectPath}
                      commandKind="shell"
                      active={active && open && selected}
                    />
                  </div>
                </Suspense>
              </section>
            )
          }

          if (tab.tool === 'browser' || tab.tool === 'computer') {
            return (
              <section {...panelProps} key={tab.id}>
                <Suspense fallback={<ToolPaneFallback label={`Opening ${tab.tool === 'computer' ? 'Computer Use' : 'Browser'}…`} />}>
                  <ProjectPreviewPanel
                    projectPath={projectPath}
                    projectName={project.name}
                    active={active && open && selected}
                    refreshKey={refreshKey}
                    variant="workspace"
                    title={tab.tool === 'computer' ? 'Computer Use' : 'Browser'}
                    interactive={tab.tool === 'computer'}
                    pointerInput
                  />
                </Suspense>
              </section>
            )
          }

          return (
            <section {...panelProps} key={tab.id}>
              <Suspense fallback={<ToolPaneFallback label="Opening Files…" />}>
                <WorkspaceFilesPanel
                  project={project}
                  refreshKey={refreshKey}
                  onSelectionChange={(path) => renameTab(tab.id, path?.split('/').at(-1) ?? 'Open file')}
                />
              </Suspense>
            </section>
          )
        })}
      </div>
    </aside>
  )
}
