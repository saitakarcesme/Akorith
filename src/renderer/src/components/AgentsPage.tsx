import { AgentsIcon } from './icons'

// Phase 43: placeholder page. No agent execution controls yet — "coming soon".
export default function AgentsPage(): JSX.Element {
  return (
    <div className="page-wrap soon-page">
      <div className="soon-card">
        <div className="soon-glyph">
          <AgentsIcon size={26} />
          <span className="soon-pulse" aria-hidden="true" />
        </div>
        <div className="soon-kicker">
          <span className="soon-dot" aria-hidden="true" />
          Soon!
        </div>
        <h1>Agents</h1>
        <p className="soon-sub">Configure and monitor coding agents across Claude, Codex, OpenCode, and local runtimes.</p>
        <p className="soon-body">
          This page will become the command center for Olympus, Gaia, Atlantis, and future
          agents. For now, the Agent OS foundation lives under{' '}
          <strong>Settings → Agents</strong>.
        </p>
        <div className="soon-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  )
}
