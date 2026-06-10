import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalPaneProps {
  /** PTY session id ("t1", "t2") — routes IPC streams to this pane only. */
  id: string
  title: string
}

type PaneStatus = 'connecting' | 'live' | 'exited'

export default function TerminalPane({ id, title }: TerminalPaneProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<PaneStatus>('connecting')
  const [exitCode, setExitCode] = useState<number | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#3fb950',
        selectionBackground: 'rgba(63, 185, 80, 0.25)'
      }
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    fitAddon.fit()

    // Subscribe before create so no early shell output is dropped.
    const offData = window.api.pty.onData(id, (data) => terminal.write(data))
    const offExit = window.api.pty.onExit(id, (code) => {
      setStatus('exited')
      setExitCode(code)
      terminal.write(`\r\n\x1b[90m[shell exited with code ${code}]\x1b[0m\r\n`)
    })

    const inputSub = terminal.onData((data) => window.api.pty.input(id, data))
    const resizeSub = terminal.onResize(({ cols, rows }) =>
      window.api.pty.resize(id, cols, rows)
    )

    let disposed = false
    window.api.pty
      .create(id, { cols: terminal.cols, rows: terminal.rows })
      .then(() => {
        if (!disposed) setStatus('live')
        terminal.focus()
      })
      .catch(() => {
        if (!disposed) setStatus('exited')
      })

    const resizeObserver = new ResizeObserver(() => {
      // Skip fits while the pane is collapsed (e.g. during layout churn).
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        fitAddon.fit() // triggers terminal.onResize → pty:resize
      }
    })
    resizeObserver.observe(host)

    return () => {
      disposed = true
      resizeObserver.disconnect()
      inputSub.dispose()
      resizeSub.dispose()
      offData()
      offExit()
      window.api.pty.kill(id)
      terminal.dispose()
    }
  }, [id])

  const statusLabel =
    status === 'connecting' ? 'connecting…' : status === 'live' ? 'live' : `exited (${exitCode ?? '?'})`

  return (
    <section className="terminal-pane">
      <header className="terminal-pane-header">
        <span className={`terminal-pane-dot ${status === 'live' ? 'is-live' : ''}`} />
        <span>{title}</span>
        <span className="terminal-pane-status">{statusLabel}</span>
      </header>
      <div className="terminal-host" ref={hostRef} />
    </section>
  )
}
