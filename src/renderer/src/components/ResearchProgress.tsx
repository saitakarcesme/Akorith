import type {
  ResearchJobDetail,
  ResearchOutputFormat,
  ResearchPhase,
  ResearchStatus
} from '../../../preload/index.d'
import ChatMarkdown from './ChatMarkdown'
import { FileIcon, FolderOpenIcon, PauseIcon, PlayIcon } from './icons'

const PHASES: Array<{ id: ResearchPhase; label: string }> = [
  { id: 'understand', label: 'Understand' },
  { id: 'plan', label: 'Plan' },
  { id: 'research', label: 'Research' },
  { id: 'verify', label: 'Verify' },
  { id: 'synthesize', label: 'Write' },
  { id: 'export', label: 'Publish' }
]

const PHASE_COPY: Record<ResearchPhase, string> = {
  understand: 'Interpreting the requested outcome and defining an evidence boundary.',
  plan: 'Building search tracks, verification rules, and the final report structure.',
  research: 'Collecting sources and turning verifiable evidence into cited findings.',
  verify: 'Checking claim coverage, conflicts, source quality, and open evidence gaps.',
  synthesize: 'Writing the report while preserving source links and uncertainty.',
  export: 'Packaging and validating the selected deliverable for the Research library.'
}

const CLOCK_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit'
})

interface ResearchProgressProps {
  detail: ResearchJobDetail
  actionPending?: boolean
  onPause: () => Promise<void>
  onResume: () => Promise<void>
  onExport: (format: ResearchOutputFormat) => Promise<void>
  onOpenArtifact: (id: string) => Promise<void>
  onRevealArtifact: (id: string) => Promise<void>
  onOpenSource: (id: string) => Promise<void>
}

export default function ResearchProgress({
  detail,
  actionPending = false,
  onPause,
  onResume,
  onExport,
  onOpenArtifact,
  onRevealArtifact,
  onOpenSource
}: ResearchProgressProps): JSX.Element {
  const { job } = detail
  const currentIndex = PHASES.findIndex((phase) => phase.id === job.phase)
  const terminal = job.status === 'completed' || job.status === 'archived'
  const paused = job.status === 'paused' || job.status === 'error'
  const duration = formatDuration((job.completedAt ?? Date.now()) - (job.startedAt ?? job.createdAt))
  const recentEvents = detail.events.slice(-80)

  return (
    <article className="research-progress">
      <div className="research-request-bubble"><span>{job.prompt}</span></div>

      <header className="research-progress-header">
        <div>
          <span className="research-eyebrow">{statusLabel(job.status)}</span>
          <h1>{job.plan?.title || job.title}</h1>
          <p>{PHASE_COPY[job.phase]}</p>
        </div>
        <div className="research-progress-actions">
          {!terminal && (
            <button
              type="button"
              className="research-icon-action"
              title={paused ? 'Resume research' : 'Pause research'}
              aria-label={paused ? 'Resume research' : 'Pause research'}
              disabled={actionPending}
              onClick={() => void (paused ? onResume() : onPause())}
            >
              {paused ? <PlayIcon size={15} /> : <PauseIcon size={15} />}
            </button>
          )}
          <span className={`research-status-badge is-${job.status}`} role="status" aria-live="polite">
            <i aria-hidden="true" />{statusLabel(job.status)}
          </span>
        </div>
      </header>

      <section className="research-phase-rail" role="list" aria-label="Research phases">
        {PHASES.map((phase, index) => {
          const complete = terminal || index < currentIndex
          const active = !terminal && index === currentIndex
          return (
            <div
              key={phase.id}
              role="listitem"
              aria-current={active ? 'step' : undefined}
              className={`research-phase ${complete ? 'is-complete' : ''} ${active ? 'is-active' : ''}`}
            >
              <span className="research-phase-dot" aria-hidden="true">{complete ? '✓' : index + 1}</span>
              <span>{phase.label}</span>
            </div>
          )
        })}
      </section>

      <section className="research-metrics" aria-label="Research metrics">
        <Metric label="Worked for" value={duration} />
        <Metric label="Cycles" value={String(job.cycleCount)} />
        <Metric label="Sources" value={String(job.sourceCount)} />
        <Metric label="Findings" value={String(job.findingCount)} />
        <Metric label="Output" value={job.outputFormat.toUpperCase()} />
      </section>

      {job.error && <div className="research-error" role="alert"><strong>Research needs attention</strong><span>{job.error}</span></div>}

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
          <div className="research-event-list">
            {recentEvents.map((event, index) => (
              <div key={event.id} className={`research-event is-${event.kind}`}>
                <span className="research-event-marker" />
                <div className="research-event-copy">
                  <div><span>Step {index + 1}</span><time dateTime={new Date(event.createdAt).toISOString()}>{formatClock(event.createdAt)}</time></div>
                  <strong>{event.title}</strong>
                  {event.detail && <ChatMarkdown text={event.detail} />}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {detail.sources.length > 0 && (
        <details className="research-source-panel">
          <summary><span>Sources</span><em>{detail.sources.length} collected</em></summary>
          <div className="research-source-list">
            {detail.sources.map((source, index) => (
              <button key={source.id} type="button" disabled={actionPending} onClick={() => void onOpenSource(source.id)}>
                <span>{index + 1}</span>
                <div><strong>{source.title}</strong><small>{source.publisher || sourceHostname(source.url)}</small></div>
                <em>{Math.round((source.credibilityScore ?? 0) * 100)}%</em>
              </button>
            ))}
          </div>
        </details>
      )}

      {detail.artifacts.length > 0 && (
        <section className="research-artifacts">
          <div className="research-section-heading">
            <div><span className="research-eyebrow">DELIVERABLES</span><h2>Validated outputs</h2></div>
            <div className="research-export-menu">
              {(['pdf', 'md', 'docx', 'xlsx'] as ResearchOutputFormat[]).map((format) => (
                <button key={format} type="button" disabled={actionPending} onClick={() => void onExport(format)}>{format.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div className="research-artifact-list">
            {detail.artifacts.map((artifact) => (
              <div key={artifact.id} className="research-artifact-row">
                <span className="research-artifact-icon"><FileIcon size={17} /></span>
                <div><strong>{artifact.title}</strong><small>{artifact.format.toUpperCase()} · {formatBytes(artifact.byteSize)} · v{artifact.version}</small></div>
                <button type="button" title="Open output" aria-label={`Open ${artifact.title}`} disabled={actionPending} onClick={() => void onOpenArtifact(artifact.id)}><FileIcon size={15} /></button>
                <button type="button" title="Reveal in Finder" aria-label={`Reveal ${artifact.title} in Finder`} disabled={actionPending} onClick={() => void onRevealArtifact(artifact.id)}><FolderOpenIcon size={15} /></button>
              </div>
            ))}
          </div>
        </section>
      )}
    </article>
  )
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return <div><strong>{value}</strong><span>{label}</span></div>
}

function statusLabel(status: ResearchStatus): string {
  return status.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
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

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

function sourceHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
