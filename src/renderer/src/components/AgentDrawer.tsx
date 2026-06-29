import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ProjectRow } from '../../../preload/index.d'
import TerminalPane, { type AgentStatusInfo } from './TerminalPane'

/** Phase 33.16: where the agent terminals are docked. Switching modes never
 *  remounts the TerminalPanes (same component tree, only the container class
 *  changes), so the PTYs and their buffers keep running. */
export type AgentDockMode = 'drawer' | 'dock' | 'full' | 'right'

interface AgentDrawerProps {
  activeProject: ProjectRow | null
  open: boolean
  onClose: () => void
  /** Phase 37: t3 = Gaia (OpenCode), between Olympus (t2) and Atlantis (t1). */
  onAgentStatus: (id: 't1' | 't2' | 't3', info: AgentStatusInfo) => void
}

function storageMode(key: string, fallback: AgentDockMode): AgentDockMode {
  try {
    const v = localStorage.getItem(key)
    return v === 'drawer' || v === 'dock' || v === 'full' || v === 'right' ? v : fallback
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

// Phase 34.9: bottom-dock vertical resize bounds.
const DOCK_MIN = 180
const DOCK_DEFAULT = 360
function dockMax(): number {
  return Math.round((typeof window !== 'undefined' ? window.innerHeight : 900) * 0.75)
}

// Phase 36.6: right-dock horizontal resize bounds (beside the chat).
const RIGHT_MIN = 320
const RIGHT_DEFAULT = 460
function rightMax(): number {
  return Math.round((typeof window !== 'undefined' ? window.innerWidth : 1200) * 0.6)
}

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
  const asideRef = useRef<HTMLElement>(null)
  const [split, setSplit] = useState(() => sanitizeSplit(storageNumber('akorith.terminalSplit', 50)))
  const [width, setWidth] = useState(() => clamp(storageNumber('akorith.drawerWidth', 620), WIDTH_MIN, WIDTH_MAX))
  const [olympusCollapsed, setOlympusCollapsed] = useState(() => storageBoolean('akorith.olympusCollapsed', false))
  const [gaiaCollapsed, setGaiaCollapsed] = useState(() => storageBoolean('akorith.gaiaCollapsed', false))
  const [atlantisCollapsed, setAtlantisCollapsed] = useState(() => storageBoolean('akorith.atlantisCollapsed', false))
  const [mode, setMode] = useState<AgentDockMode>(() => storageMode('akorith.agentDockMode', 'drawer'))
  const [dockHeight, setDockHeight] = useState(() =>
    clamp(storageNumber('akorith.agentDockHeight', DOCK_DEFAULT), DOCK_MIN, dockMax())
  )
  const [rightWidth, setRightWidth] = useState(() =>
    clamp(storageNumber('akorith.agentRightWidth', RIGHT_DEFAULT), RIGHT_MIN, rightMax())
  )

  useEffect(() => {
    localStorage.setItem('akorith.agentDockMode', mode)
  }, [mode])
  useEffect(() => {
    localStorage.setItem('akorith.agentDockHeight', String(dockHeight))
  }, [dockHeight])
  useEffect(() => {
    localStorage.setItem('akorith.agentRightWidth', String(rightWidth))
  }, [rightWidth])

  // Phase 36.6: in right mode, push the chat over by the dock width (via a CSS
  // var + class on the parent .workspace) so the agents sit BESIDE the chat
  // instead of overlaying it. Cleared whenever right mode isn't active/open.
  useEffect(() => {
    const ws = asideRef.current?.parentElement
    if (!ws) return
    if (mode === 'right' && open) {
      ws.style.setProperty('--agent-right-width', `${rightWidth}px`)
      ws.classList.add('has-agent-right')
    } else {
      ws.classList.remove('has-agent-right')
      ws.style.removeProperty('--agent-right-width')
    }
    return () => {
      ws.classList.remove('has-agent-right')
      ws.style.removeProperty('--agent-right-width')
    }
  }, [mode, open, rightWidth])

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
    localStorage.setItem('akorith.gaiaCollapsed', String(gaiaCollapsed))
  }, [gaiaCollapsed])
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

  // Phase 34.9: drag the top edge of the bottom dock to resize it vertically.
  // Dragging up increases the height. The terminal panes refit via their own
  // ResizeObserver — no remount, no PTY restart.
  const startDockResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = dockHeight
    const move = (moveEvent: PointerEvent): void => {
      setDockHeight(clamp(startHeight + (startY - moveEvent.clientY), DOCK_MIN, dockMax()))
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  const resetDockHeight = (): void => setDockHeight(clamp(DOCK_DEFAULT, DOCK_MIN, dockMax()))

  // Phase 36.6: drag the left edge of the right dock to resize it horizontally.
  // Dragging left widens it. Terminals refit via their ResizeObserver — no remount.
  const startRightResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidthPx = rightWidth
    const move = (moveEvent: PointerEvent): void => {
      setRightWidth(clamp(startWidthPx + (startX - moveEvent.clientX), RIGHT_MIN, rightMax()))
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

  // Phase 37: three panes share the height equally; each collapsed pane shrinks
  // to just its header so the expanded ones fill the rest.
  const olympusGrow = olympusCollapsed ? 0 : 1
  const gaiaGrow = gaiaCollapsed ? 0 : 1
  const atlantisGrow = atlantisCollapsed ? 0 : 1

  // Per-project session keys (Phase 13.3): each project keeps its own live
  // Codex/Claude/OpenCode session, so switching projects and back reuses them.
  const projectKey = activeProject.id.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 40)
  const olympusId = `t2::${projectKey}`
  const gaiaId = `t3::${projectKey}`
  const atlantisId = `t1::${projectKey}`

  const modeButtons: { id: AgentDockMode; label: string; title: string }[] = [
    { id: 'drawer', label: 'Drawer', title: 'Dock as a right-side overlay drawer' },
    { id: 'dock', label: 'Bottom', title: 'Dock to the bottom workbench' },
    { id: 'right', label: 'Right', title: 'Dock to the right, beside the chat' },
    { id: 'full', label: 'Focus', title: 'Expand to a focus view' }
  ]

  const asideStyle =
    mode === 'drawer' ? { width } : mode === 'dock' ? { height: dockHeight } : mode === 'right' ? { width: rightWidth } : undefined

  return (
    <>
      <div className={`agent-drawer-scrim ${open ? 'is-open' : ''} mode-${mode}`} onClick={onClose} />
      <aside
        ref={asideRef}
        className={`agent-drawer ${open ? 'is-open' : ''} mode-${mode}`}
        style={asideStyle}
        aria-hidden={!open}
      >
        {(mode === 'drawer' || mode === 'right') && (
          <div
            className="agent-drawer-resizer"
            onPointerDown={mode === 'right' ? startRightResize : startWidthResize}
            title="Drag to resize"
          />
        )}
        {mode === 'dock' && (
          <div
            className="agent-dock-resizer"
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize · double-click to reset"
            onPointerDown={startDockResize}
            onDoubleClick={resetDockHeight}
          />
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
          <div
            className={`terminal-slot ${gaiaCollapsed ? 'is-collapsed' : ''}`}
            style={{ flexGrow: gaiaGrow, flexBasis: 0, flexShrink: gaiaCollapsed ? 0 : 1 }}
          >
            <TerminalPane
              key={gaiaId}
              id={gaiaId}
              title="Gaia"
              identity="gaia"
              cwd={activeProject.path}
              commandKind="opencode"
              collapsed={gaiaCollapsed}
              onToggleCollapse={() => setGaiaCollapsed((v) => !v)}
              onStatus={(info) => onAgentStatus('t3', info)}
            />
          </div>
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
