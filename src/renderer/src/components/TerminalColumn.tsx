import TerminalPane from './TerminalPane'

// Stacked executor terminals: Terminal 2 on top, Terminal 1 on the bottom.
// Each runs an independent interactive shell PTY keyed by its id.
// TODO(phase 4): the chat→terminal bridge targets these panes by the same ids.
export default function TerminalColumn(): JSX.Element {
  return (
    <main className="terminal-column">
      <TerminalPane id="t2" title="Terminal 2" />
      <TerminalPane id="t1" title="Terminal 1" />
    </main>
  )
}
