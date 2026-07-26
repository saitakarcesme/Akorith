import { useEffect, useRef } from 'react'
import type { ResearchLiveDetail, ResearchPhase } from '../../../preload/index.d'
import ChatMarkdown from './ChatMarkdown'
import { researchDurationLabel } from './researchDuration'

const PHASES: Array<{ id: ResearchPhase; label: string }> = [
  { id: 'understand', label: 'Understand' },
  { id: 'plan', label: 'Plan' },
  { id: 'research', label: 'Research' },
  { id: 'verify', label: 'Verify' },
  { id: 'synthesize', label: 'Write' },
  { id: 'export', label: 'Publish' }
]

const CLOCK_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit'
})

interface ResearchOperationalDetailsProps {
  detail: ResearchLiveDetail
  collapsed?: boolean
  actionPending?: boolean
  onOpenSource: (id: string) => Promise<void>
}

export default function ResearchOperationalDetails({
  detail,
  collapsed = false,
  actionPending = false,
  onOpenSource
}: ResearchOperationalDetailsProps): JSX.Element {
  const { job } = detail
  const terminal = job.status === 'completed' || job.status === 'archived'
  const currentIndex = PHASES.findIndex((phase) => phase.id === job.phase)
  const recentEvents = detail.events.slice(-80)
  const recentEventOffset = detail.events.length - recentEvents.length
  const eventListRef = useRef<HTMLDivElement>(null)
  const eventListJobRef = useRef<string | null>(null)
  const followLatestEventRef = useRef(true)
  const latestEventId = recentEvents.at(-1)?.id
  const duration = formatDuration(
    job.activeElapsedMs
    + (job.activeAccountingAt == null
      ? 0
      : Math.min(15_000, Math.max(0, Date.now() - job.activeAccountingAt)))
  )

  useEffect(() => {
    const list = eventListRef.current
    if (!list || !latestEventId) return
    const openedJob = eventListJobRef.current !== job.id
    if (openedJob || followLatestEventRef.current) list.scrollTop = list.scrollHeight
    eventListJobRef.current = job.id
  }, [job.id, latestEventId])

  const content = (
    <div className="research-details-content">
      <div className="research-phase-scroll">
        <section className="research-phase-rail" role="list" aria-label="Research phases">
          {PHASES.map((phase, index) => {
            const complete = terminal || index < currentIndex
            const active = !terminal && index === currentIndex
            const stateLabel = complete ? 'Done' : active ? 'Current' : 'Pending'
            return (
              <div
                key={phase.id}
                role="listitem"
                aria-current={active ? 'step' : undefined}
                className={`research-phase ${complete ? 'is-complete' : ''} ${active ? 'is-active' : ''}`}
              >
                <span className="research-phase-dot" aria-hidden="true">{complete ? '\u2713' : index + 1}</span>
                <span className="research-phase-copy"><strong>{phase.label}</strong><small>{stateLabel}</small></span>
              </div>
            )
          })}
        </section>
      </div>

      <section className="research-metrics" aria-label="Research metrics">
        <Metric label="Active research" value={duration} />
        <Metric label="Research duration" value={researchDurationLabel(job.depth)} />
        <Metric label="Cycles" value={String(job.cycleCount)} />
        <Metric label="Sources" value={String(job.sourceCount)} />
        <Metric label="Findings" value={String(job.findingCount)} />
        <Metric label="Output" value={job.outputFormat.toUpperCase()} />
      </section>

      {job.error && <div className="research-error" role="alert"><strong>Research needs attention</strong><span>{job.error}</span></div>}

      {(job.plan || recentEvents.length > 0) && (
        <div className="research-workbench-grid">
          {job.plan && (
            <section className="research-plan-panel">
              <div className="research-section-heading">
                <div><span className="research-eyebrow">PLAN</span><h2>Evidence program</h2></div>
                <span>{job.plan.sections.filter((section) => section.status === 'complete').length}/{job.plan.sections.length} tracks</span>
              </div>
              <p className="research-plan-thesis">{job.plan.thesis}</p>
              <div className="research-plan-list">
                {job.plan.sections.map((section, index) => (
                  <div key={section.id} className={`research-plan-row is-${section.status}`}>
                    <span className="research-plan-index">{String(index + 1).padStart(2, '0')}</span>
                    <div><strong>{section.title}</strong><p>{section.objective}</p></div>
                    <span className="research-plan-state">{section.status}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {recentEvents.length > 0 && (
            <section className="research-event-stream">
              <div className="research-section-heading">
                <div><span className="research-eyebrow">LIVE NOTES</span><h2>Research log</h2></div>
                {detail.running && <span className="research-live-label" role="status"><i aria-hidden="true" />working</span>}
              </div>
              <div
                ref={eventListRef}
                className="research-event-list"
                role="log"
                aria-label="Research activity, newest step last"
                aria-live="polite"
                aria-relevant="additions"
                tabIndex={0}
                onScroll={(event) => {
                  const list = event.currentTarget
                  followLatestEventRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 72
                }}
              >
                {recentEvents.map((event, index) => {
                  const current = detail.running && index === recentEvents.length - 1
                  return (
                    <div
                      key={event.id}
                      aria-current={current ? 'step' : undefined}
                      className={`research-event is-${event.kind} ${current ? 'is-current' : ''}`}
                    >
                      <span className="research-event-marker" aria-hidden="true" />
                      <div className="research-event-copy">
                        <div>
                          <span className="research-event-step">Step {recentEventOffset + index + 1}{current && <em>Current</em>}</span>
                          <time dateTime={new Date(event.createdAt).toISOString()}>{formatClock(event.createdAt)}</time>
                        </div>
                        <strong>{event.title}</strong>
                        {event.detail && <ChatMarkdown text={event.detail} />}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      )}

      {detail.sources.length > 0 && (
        <details className="research-source-panel">
          <summary><span>Sources</span><em>{detail.sources.length} collected</em></summary>
          <div className="research-source-list">
            {detail.sources.map((source, index) => (
              <button key={source.id} type="button" disabled={actionPending} onClick={() => void onOpenSource(source.id)}>
                <span>{index + 1}</span>
                <div><strong>{source.title}</strong><small>{source.publisher || sourceHostname(source.url)}</small></div>
                <em>{source.credibilityScore == null ? 'Not scored' : `${Math.round(source.credibilityScore * 100)}%`}</em>
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  )

  if (!collapsed) return content
  return (
    <details className="research-details-panel">
      <summary>
        <span><strong>Research details</strong><small>Method, activity, evidence, and collected sources</small></span>
        <em>{job.sourceCount} sources</em>
      </summary>
      {content}
    </details>
  )
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return <div><strong>{value}</strong><span>{label}</span></div>
}

function formatClock(timestamp: number): string {
  return CLOCK_FORMATTER.format(new Date(timestamp))
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function sourceHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
