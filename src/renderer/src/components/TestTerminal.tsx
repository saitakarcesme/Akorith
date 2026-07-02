import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TestTerminalProps {
  /** Bumping this clears the terminal (new run starting). */
  clearKey: number
  /** True when the test page is visible — triggers a refit. */
  active: boolean
}

// Read-only sandbox output viewer. Unlike the workspace panes this is NOT a PTY:
// it only renders the streamed stdout/stderr of the bounded test child process,
// so there is no input path and no PtyManager involvement.
export default function TestTerminal({ clearKey, active }: TestTerminalProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const terminal = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      scrollback: 8000,
      // Phase 36.5: the bounded test child writes plain "\n" line endings. Without
      // convertEol, xterm advances a row without a carriage return, so each line
      // starts where the previous ended — the "staircase"/half-sentence misalignment.
      // Converting \n -> \r\n makes long npm logs wrap cleanly at the terminal width.
      convertEol: true,
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize: 11,
      lineHeight: 1.32,
      theme: {
        // Phase 14.1: lighter, more readable sandbox surface (was near-black).
        background: '#181818',
        foreground: '#ffffff',
        cursor: '#181818',
        selectionBackground: 'rgba(255, 255, 255, 0.22)'
      }
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    fitAddon.fit()
    terminal.write('\x1b[90m[akorith] sandbox ready.\x1b[0m\r\n')
    termRef.current = terminal
    fitRef.current = fitAddon

    const off = window.api.test.onOutput(({ chunk }) => terminal.write(chunk))

    const resizeObserver = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fitAddon.fit()
    })
    resizeObserver.observe(host)

    return () => {
      off()
      resizeObserver.disconnect()
      terminal.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // Clear on a new run.
  useEffect(() => {
    if (clearKey > 0) termRef.current?.reset()
  }, [clearKey])

  // Refit when the page becomes visible (it's display:none while hidden).
  useEffect(() => {
    if (active && hostRef.current && hostRef.current.clientWidth > 0) fitRef.current?.fit()
  }, [active])

  return <div className="test-terminal-host" ref={hostRef} />
}
