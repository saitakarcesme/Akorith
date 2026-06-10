import TerminalPane from './TerminalPane'

// Stacked executor terminals: Terminal 2 on top, Terminal 1 on the bottom,
// matching the Phase 1 sketch.
// TODO(phase 2): these panes host the real `claude` / `codex` CLI PTY sessions.
export default function TerminalColumn(): JSX.Element {
  return (
    <main className="terminal-column">
      <TerminalPane title="Terminal 2" />
      <TerminalPane title="Terminal 1" />
    </main>
  )
}
