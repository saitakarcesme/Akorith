import { CompanionsIcon } from './icons'

// Phase 43: placeholder page. No companion logic yet — intentional "coming soon".
export default function CompanionsPage(): JSX.Element {
  return (
    <div className="page-wrap soon-page">
      <div className="soon-card">
        <div className="soon-glyph">
          <CompanionsIcon size={26} />
          <span className="soon-pulse" aria-hidden="true" />
        </div>
        <div className="soon-kicker">
          <span className="soon-dot" aria-hidden="true" />
          Soon!
        </div>
        <h1>Companions</h1>
        <p className="soon-sub">Personal AI companions for long-running collaboration.</p>
        <p className="soon-body">
          This page will host personality-driven agents, long-term memory, and companion
          workflows that stay with you across projects and sessions.
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
