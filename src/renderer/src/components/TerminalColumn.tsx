import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import TerminalPane from './TerminalPane'

function storageNumber(key: string, fallback: number): number {
  try {
    const raw = Number(localStorage.getItem(key))
    return Number.isFinite(raw) ? raw : fallback
  } catch {
    return fallback
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// Stacked executor terminals: Olympus on top (t2), Atlantis on the bottom (t1).
// Each runs an independent interactive shell PTY keyed by its stable id.
export default function TerminalColumn(): JSX.Element {
  const columnRef = useRef<HTMLElement>(null)
  const [split, setSplit] = useState(() => storageNumber('akorith.terminalSplit', 50))

  useEffect(() => {
    localStorage.setItem('akorith.terminalSplit', String(split))
  }, [split])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startY = event.clientY
    const startSplit = split
    const height = columnRef.current?.clientHeight ?? 1
    const move = (moveEvent: PointerEvent): void => {
      const delta = ((moveEvent.clientY - startY) / height) * 100
      setSplit(clamp(startSplit + delta, 24, 76))
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  return (
    <main className="terminal-column" ref={columnRef}>
      <div className="terminal-slot" style={{ flexBasis: `${split}%` }}>
        <TerminalPane id="t2" title="Olympus" identity="olympus" />
      </div>
      <div className="terminal-split-resizer" role="separator" aria-orientation="horizontal" onPointerDown={startResize} />
      <div className="terminal-slot" style={{ flexBasis: `${100 - split}%` }}>
        <TerminalPane id="t1" title="Atlantis" identity="atlantis" />
      </div>
    </main>
  )
}
