import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ProjectRow } from '../../../preload/index.d'
import TerminalPane, { type AgentStatusInfo } from './TerminalPane'

interface AgentDrawerProps {
  activeProject: ProjectRow | null
  open: boolean
  onClose: () => void
  onAgentStatus: (id: 't1' | 't2', info: AgentStatusInfo) => void
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// Keep the split sane: never tiny-vs-huge (30–70); anything else resets to 50/50.
const SPLIT_MIN = 30
const SPLIT_MAX = 70
function sanitizeSplit(value: number): number {
  return value >= SPLIT_MIN && value <= SPLIT_MAX ? value : 50
}

/**
 * The agent activity drawer. Terminals (Olympus=Codex, Atlantis=Claude) live here
 * and run in the background: this panel is ALWAYS mounted while a project with a
 * path is active, so closing the drawer only hides it (CSS transform) — the PTYs
 * and their snapshot buffers keep running. Opening it just reveals the live panes.
 * The only programmatic write path remains bridgeSend → PtyManager.write().
 */
export default function AgentDrawer({ activeProject, open, onClose, onAgentStatus }: AgentDrawerProps): JSX.Element | null {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [split, setSplit] = useState(() => sanitizeSplit(storageNumber('akorith.terminalSplit', 50)))

  useEffect(() => {
    localStorage.setItem('akorith.terminalSplit', String(split))
  }, [split])

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

  // No project folder → no agents to host; the drawer simply isn't mounted.
  if (!activeProject?.path) return null

  return (
    <>
      <div className={`agent-drawer-scrim ${open ? 'is-open' : ''}`} onClick={onClose} />
      <aside className={`agent-drawer ${open ? 'is-open' : ''}`} aria-hidden={!open}>
        <header className="agent-drawer-header">
          <div className="agent-drawer-title">Agent activity</div>
          <div className="agent-drawer-cwd" title={activeProject.path}>{activeProject.path}</div>
          <button type="button" className="agent-drawer-close" onClick={onClose} title="Hide agents">
            ✕
          </button>
        </header>
        <div className="agent-drawer-body" ref={bodyRef}>
          <div className="terminal-slot" style={{ flexGrow: split, flexBasis: 0 }}>
            <TerminalPane
              id="t2"
              title="Olympus"
              identity="olympus"
              cwd={activeProject.path}
              commandKind="codex"
              onStatus={(info) => onAgentStatus('t2', info)}
            />
          </div>
          <div
            className="terminal-split-resizer"
            role="separator"
            aria-orientation="horizontal"
            onPointerDown={startSplitResize}
          />
          <div className="terminal-slot" style={{ flexGrow: 100 - split, flexBasis: 0 }}>
            <TerminalPane
              id="t1"
              title="Atlantis"
              identity="atlantis"
              cwd={activeProject.path}
              commandKind="claude"
              onStatus={(info) => onAgentStatus('t1', info)}
            />
          </div>
        </div>
      </aside>
    </>
  )
}
