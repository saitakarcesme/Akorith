import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalPaneProps {
  title: string
}

export default function TerminalPane({ title }: TerminalPaneProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const terminal = new Terminal({
      // Read-only in Phase 1: there is no PTY to receive keystrokes.
      disableStdin: true,
      cursorBlink: false,
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#0d1117',
        selectionBackground: 'rgba(63, 185, 80, 0.25)'
      }
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    fitAddon.fit()

    terminal.write(`\x1b[90m${title} — not connected\x1b[0m`)

    // TODO(phase 2): attach this pane to a node-pty session over IPC —
    //                terminal.onData -> pty stdin, pty stdout -> terminal.write,
    //                and propagate fit() results as pty resize events.
    // TODO(phase 3): expose a programmatic "paste prompt" entry point so the
    //                planner chat can inject prompts into this terminal.

    const resizeObserver = new ResizeObserver(() => {
      // Skip fits while the pane is collapsed (e.g. during layout churn).
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        fitAddon.fit()
      }
    })
    resizeObserver.observe(host)

    return () => {
      resizeObserver.disconnect()
      terminal.dispose()
    }
  }, [title])

  return (
    <section className="terminal-pane">
      <header className="terminal-pane-header">
        <span className="terminal-pane-dot" />
        <span>{title}</span>
        <span className="terminal-pane-status">not connected</span>
      </header>
      <div className="terminal-host" ref={hostRef} />
    </section>
  )
}
