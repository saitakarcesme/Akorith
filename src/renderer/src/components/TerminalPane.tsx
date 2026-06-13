import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { PtyCommandKind } from '../../../preload/index.d'
import { MountainIcon, WaveIcon } from './icons'

type PaneStatus = 'connecting' | 'live' | 'exited'
type TerminalRole = 'shell' | 'claude' | 'codex'

export interface AgentStatusInfo {
  status: PaneStatus
  role: TerminalRole
}

interface TerminalPaneProps {
  /** PTY session id ("t1", "t2") — routes IPC streams to this pane only. */
  id: string
  title: string
  identity: 'olympus' | 'atlantis'
  cwd: string
  commandKind: Extract<PtyCommandKind, 'codex' | 'claude'>
  /** Bubble status/role up so the chat can show "Codex ready" without the
   *  terminal being visible (the pane keeps running inside the hidden drawer). */
  onStatus?: (info: AgentStatusInfo) => void
}

const ROLES: { id: TerminalRole; label: string }[] = [
  { id: 'shell', label: 'Shell' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' }
]

export default function TerminalPane({ id, title, identity, cwd, commandKind, onStatus }: TerminalPaneProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<PaneStatus>('connecting')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [role, setRole] = useState<TerminalRole>(commandKind)

  // Report status/role upward whenever they change (decoupled from xterm wiring).
  useEffect(() => {
    onStatus?.({ status, role })
  }, [status, role, onStatus])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setStatus('connecting')
    setExitCode(null)
    setRole(commandKind)

    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: '#0b0b10',
        foreground: '#e6e1ea',
        cursor: '#a996ff',
        selectionBackground: 'rgba(169, 150, 255, 0.22)'
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
      .create(id, { cols: terminal.cols, rows: terminal.rows, cwd, commandKind })
      .then((res) => {
        if (disposed) return
        if (res.ok) {
          setRole(res.started)
          setStatus('live')
          if (res.message) terminal.write(`\r\n\x1b[33m${res.message}\x1b[0m`)
          terminal.focus()
          return
        }
        setRole('shell')
        setStatus('exited')
        terminal.write(`\r\n\x1b[31m[akorith] ${res.error}\x1b[0m\r\n`)
      })
      .catch((err) => {
        if (!disposed) {
          setRole('shell')
          setStatus('exited')
          terminal.write(`\r\n\x1b[31m[akorith] ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`)
        }
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
  }, [id, cwd, commandKind])

  const statusLabel =
    status === 'connecting' ? 'connecting…' : status === 'live' ? 'live' : `exited (${exitCode ?? '?'})`
  const IdentityIcon = identity === 'olympus' ? MountainIcon : WaveIcon

  return (
    <section className="terminal-pane">
      <header className="terminal-pane-header">
        <span className={`terminal-pane-dot ${status === 'live' ? 'is-live' : ''}`} />
        <IdentityIcon size={15} />
        <span className="terminal-pane-title">
          <strong>{title}</strong>
        </span>
        <span className={`terminal-role-pill role-${role}`}>{ROLES.find((item) => item.id === role)?.label ?? 'Shell'}</span>
        <span className="terminal-pane-status">{statusLabel}</span>
      </header>
      <div className="terminal-host" ref={hostRef} />
    </section>
  )
}
