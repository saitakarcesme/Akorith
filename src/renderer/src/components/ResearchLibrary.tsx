import { useEffect, useMemo, useState } from 'react'
import type { ResearchJob } from '../../../preload/index.d'
import { FileIcon } from './icons'
import { researchDurationLabel } from './researchDuration'

type LibraryFilter = 'all' | 'published' | 'active'
const LIBRARY_PAGE_SIZE = 48

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
})

const STATUS_LABELS: Record<ResearchJob['status'], string> = {
  draft: 'Draft',
  planning: 'Planning',
  researching: 'Researching',
  verifying: 'Verifying',
  synthesizing: 'Deciding',
  exporting: 'Reporting',
  completed: 'Completed',
  paused: 'Paused',
  error: 'Needs attention',
  archived: 'Archived'
}

interface ResearchLibraryProps {
  jobs: ResearchJob[]
  covers: Record<string, string | null>
  onNeedCovers: (ids: string[]) => void
  onSelect: (id: string) => void
}

export default function ResearchLibrary({
  jobs,
  covers,
  onNeedCovers,
  onSelect
}: ResearchLibraryProps): JSX.Element {
  const [filter, setFilter] = useState<LibraryFilter>('all')
  const [visibleLimit, setVisibleLimit] = useState(LIBRARY_PAGE_SIZE)
  const visibleJobs = useMemo(() => jobs.filter((job) => {
    if (filter === 'published') return job.status === 'completed'
    if (filter === 'active') return !['completed', 'archived'].includes(job.status)
    return job.status !== 'archived'
  }), [filter, jobs])
  const renderedJobs = useMemo(() => visibleJobs.slice(0, visibleLimit), [visibleJobs, visibleLimit])

  useEffect(() => {
    onNeedCovers(renderedJobs.filter((job) => Boolean(job.coverPath)).map((job) => job.id))
  }, [onNeedCovers, renderedJobs])

  return (
    <section className="research-library">
      <header className="research-library-header">
        <div>
          <span className="research-eyebrow">EXPERIMENT LIBRARY</span>
          <h1>Every run, decision, and best checkpoint</h1>
          <p>Completed programs keep their baseline, retained improvements, rejected candidates, logs, and reproducible report.</p>
        </div>
        <div className="research-library-filters" role="group" aria-label="Experiment library filter">
          {(['all', 'published', 'active'] as LibraryFilter[]).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={filter === item}
              className={filter === item ? 'is-active' : ''}
              onClick={() => {
                setFilter(item)
                setVisibleLimit(LIBRARY_PAGE_SIZE)
              }}
            >
              {item === 'all' ? 'All' : item === 'published' ? 'Completed' : 'In progress'}
            </button>
          ))}
        </div>
      </header>

      {visibleJobs.length === 0 ? (
        <div className="research-library-empty">
          <FileIcon size={22} />
          <strong>No experiment programs yet</strong>
          <span>Start Autoresearch and its measured ledger will appear here.</span>
        </div>
      ) : (
        <div className="research-library-grid">
          {renderedJobs.map((job) => (
            <button
              key={job.id}
              type="button"
              className="research-book"
              aria-label={`Open ${job.plan?.title || job.title}. Status: ${STATUS_LABELS[job.status]}.`}
              onClick={() => onSelect(job.id)}
            >
              <span className="research-book-cover">
                {covers[job.id]
                  ? <img src={covers[job.id] ?? undefined} alt={`Cover of ${job.title}`} loading="lazy" decoding="async" />
                  : (
                    <span className="research-book-draft">
                      <small>{job.mode === 'autoresearch' ? 'AKORITH AUTORESEARCH' : 'AKORITH RESEARCH'}</small>
                      <strong>{job.plan?.title || job.title}</strong>
                      <em>{researchDurationLabel(job.depth)} · {job.mode === 'autoresearch' ? job.experimentConfig?.metric.name ?? 'experiment' : job.outputFormat.toUpperCase()}</em>
                    </span>
                  )}
                <span className={`research-book-status is-${job.status}`} aria-hidden="true">
                  <span className="research-book-status-symbol" />
                  <span className="research-book-status-label">{STATUS_LABELS[job.status]}</span>
                </span>
              </span>
              <span className="research-book-meta">
                <strong>{job.plan?.title || job.title}</strong>
                <small>{job.mode === 'autoresearch'
                  ? `${job.cycleCount} experiments · best ${formatMetric(job.experimentState?.bestMetric)}`
                  : `${job.outputFormat.toUpperCase()} · ${job.sourceCount} cited sources`}</small>
                <em>{formatDate(job.updatedAt)}</em>
              </span>
            </button>
          ))}
          {renderedJobs.length < visibleJobs.length && (
            <button
              type="button"
              className="research-library-more"
              onClick={() => setVisibleLimit((current) => current + LIBRARY_PAGE_SIZE)}
            >
              Load {Math.min(LIBRARY_PAGE_SIZE, visibleJobs.length - renderedJobs.length)} more
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function formatDate(timestamp: number): string {
  return DATE_FORMATTER.format(new Date(timestamp))
}

function formatMetric(value: number | undefined): string {
  return value === undefined ? 'pending' : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}
