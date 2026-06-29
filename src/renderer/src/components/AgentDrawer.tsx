import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ProjectRow } from '../../../preload/index.d'
import TerminalPane, { type AgentStatusInfo } from './TerminalPane'

/** Phase 33.16: where the agent terminals are docked. Switching modes never
 *  remounts the TerminalPanes (same component tree, only the container class
 *  changes), so the PTYs and their buffers keep running. */
export type AgentDockMode = 'drawer' | 'dock' | 'full'

interface AgentDrawerProps {
  activeProject: ProjectRow | null
  open: boolean
  onClose: () => void
  onAgentStatus: (id: 't1' | 't2', info: AgentStatusInfo) => void
}

function storageMode(key: string, fallback: AgentDockMode): AgentDockMode {
  try {
    const v = localStorage.getItem(key)
    return v === 'drawer' || v === 'dock' || v === 'full' ? v : fallback
  } catch {
    return fallback
  }
}

function storageNumber(key: string, fallback: number): number {
  try {
    const item = localStorage.getItem(key)
    if (item === null || item.trim() === '') return fallback
    const raw = Number(item)
    return Number.isFinite(raw) ? raw : fallback
  } catch {
    return fallback
  }
}

function storageBoolean(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === 'true'
  } catch {
    return fallback
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// Keep the split sane: never tiny-vs-huge (30–70); anything else resets to 50/50.
const SPLIT_MIN = 30
const SPLIT_MAX = 70
function sanitizeSplit(value: number): number {
  return value >= SPLIT_MIN && value <= SPLIT_MAX ? value : 50
}

const WIDTH_MIN = 380
const WIDTH_MAX = 980

/**
 * The agent activity drawer. Terminals (Olympus=Codex, Atlantis=Claude) live here
 * and run in the background: this panel is ALWAYS mounted while a project with a
 * path is active, so closing the drawer only hides it (CSS transform) — the PTYs
 * and their snapshot buffers keep running. The drawer is width-resizable, and
 * each agent can be collapsed independently so the other takes the full height.
 * The only programmatic write path remains bridgeSend → PtyManager.write().
 */
export default function AgentDrawer({ activeProject, open, onClose, onAgentStatus }: AgentDrawerProps): JSX.Element | null {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [split, setSplit] = useState(() => sanitizeSplit(storageNumber('akorith.terminalSplit', 50)))
  const [width, setWidth] = useState(() => clamp(storageNumber('akorith.drawerWidth', 620), WIDTH_MIN, WIDTH_MAX))
  const [olympusCollapsed, setOlympusCollapsed] = useState(() => storageBoolean('akorith.olympusCollapsed', false))
  const [atlantisCollapsed, setAtlantisCollapsed] = useState(() => storageBoolean('akorith.atlantisCollapsed', false))
  const [mode, setMode] = useState<AgentDockMode>(() => storageMode('akorith.agentDockMode', 'drawer'))

  useEffect(() => {
    localStorage.setItem('akorith.agentDockMode', mode)
  }, [mode])

  useEffect(() => {
    localStorage.setItem('akorith.terminalSplit', String(split))
  }, [split])
  useEffect(() => {
    localStorage.setItem('akorith.drawerWidth', String(width))
  }, [width])
  useEffect(() => {
    localStorage.setItem('akorith.olympusCollapsed', String(olympusCollapsed))
  }, [olympusCollapsed])
  useEffect(() => {
    localStorage.setItem('akorith.atlantisCollapsed', String(atlantisCollapsed))
  }, [atlantisCollapsed])

  const startSplitResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startY = event.clientY
    const startSplit = split
    const height = bodyRef.current?.clientHeight ?? 1
    const move = (moveEvent: PointerEvent): void => {
      const delta = ((moveEvent.clientY - startY) / height) * 100
      setSplit(clamp(startSplit + delta, SPLIT_MIN, SPLIT_MAX))
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  const startWidthResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const move = (moveEvent: PointerEvent): void => {
      // Dragging the left edge leftwards widens the right-anchored drawer.
      setWidth(clamp(startWidth + (startX - moveEvent.clientX), WIDTH_MIN, WIDTH_MAX))
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  // No project folder → no agents to host; the drawer simply isn't mounted.
  if (!activeProject?.path) return null

  const bothExpanded = !olympusCollapsed && !atlantisCollapsed
  // A collapsed pane shrinks to just its header; the expanded one fills the rest.
  const olympusGrow = olympusCollapsed ? 0 : bothExpanded ? split : 1
  const atlantisGrow = atlantisCollapsed ? 0 : bothExpanded ? 100 - split : 1

  // Per-project session keys (Phase 13.3): each project keeps its own live
  // Codex/Claude session, so switching projects and back reuses them.
  const projectKey = activeProject.id.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 40)
  const olympusId = `t2::${projectKey}`
  const atlantisId = `t1::${projectKey}`

  const modeButtons: { id: AgentDockMode; label: string; title: string }[] = [
    { id: 'drawer', label: 'Drawer', title: 'Dock as a right-side drawer' },
    { id: 'dock', label: 'Bottom', title: 'Dock to the bottom workbench' },
    { id: 'full', label: 'Focus', title: 'Expand to a focus view' }
  ]

  return (
    <>
      <div className={`agent-drawer-scrim ${open ? 'is-open' : ''} mode-${mode}`} onClick={onClose} />
      <aside
        className={`agent-drawer ${open ? 'is-open' : ''} mode-${mode}`}
        style={mode === 'drawer' ? { width } : undefined}
        aria-hidden={!open}
      >
        {mode === 'drawer' && (
          <div className="agent-drawer-resizer" onPointerDown={startWidthResize} title="Drag to resize" />
        )}
        <header className="agent-drawer-header">
          <div className="agent-drawer-title">Agent activity</div>
          <div className="agent-drawer-cwd" title={activeProject.path}>{activeProject.path}</div>
          <div className="agent-dock-seg" role="group" aria-label="Terminal dock mode">
            {modeButtons.map((button) => (
              <button
                key={button.id}
                type="button"
                className={mode === button.id ? 'is-active' : ''}
                title={button.title}
                onClick={() => setMode(button.id)}
              >
                {button.label}
              </button>
            ))}
          </div>
          <button type="button" className="agent-drawer-close" onClick={onClose} title="Hide agents">
            ✕
          </button>
        </header>
        <div className="agent-drawer-body" ref={bodyRef}>
          <div
            className={`terminal-slot ${olympusCollapsed ? 'is-collapsed' : ''}`}
            style={{ flexGrow: olympusGrow, flexBasis: 0, flexShrink: olympusCollapsed ? 0 : 1 }}
          >
            <TerminalPane
              key={olympusId}
              id={olympusId}
              title="Olympus"
              identity="olympus"
              cwd={activeProject.path}
              commandKind="codex"
              collapsed={olympusCollapsed}
              onToggleCollapse={() => setOlympusCollapsed((v) => !v)}
              onStatus={(info) => onAgentStatus('t2', info)}
            />
          </div>
          {bothExpanded && (
            <div
              className="terminal-split-resizer"
              role="separator"
              aria-orientation="horizontal"
              onPointerDown={startSplitResize}
            />
          )}
          <div
            className={`terminal-slot ${atlantisCollapsed ? 'is-collapsed' : ''}`}
            style={{ flexGrow: atlantisGrow, flexBasis: 0, flexShrink: atlantisCollapsed ? 0 : 1 }}
          >
            <TerminalPane
              key={atlantisId}
              id={atlantisId}
              title="Atlantis"
              identity="atlantis"
              cwd={activeProject.path}
              commandKind="claude"
              collapsed={atlantisCollapsed}
              onToggleCollapse={() => setAtlantisCollapsed((v) => !v)}
              onStatus={(info) => onAgentStatus('t1', info)}
            />
          </div>
        </div>
      </aside>
    </>
  )
}
