import { useMemo, useState } from 'react'
import type { ResearchJob } from '../../../preload/index.d'
import { FileIcon } from './icons'

type LibraryFilter = 'all' | 'published' | 'active'

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
  synthesizing: 'Synthesizing',
  exporting: 'Publishing',
  completed: 'Published',
  paused: 'Paused',
  error: 'Needs attention',
  archived: 'Archived'
}

interface ResearchLibraryProps {
  jobs: ResearchJob[]
  covers: Record<string, string | null>
  onSelect: (id: string) => void
}

export default function ResearchLibrary({ jobs, covers, onSelect }: ResearchLibraryProps): JSX.Element {
  const [filter, setFilter] = useState<LibraryFilter>('all')
  const visibleJobs = useMemo(() => jobs.filter((job) => {
    if (filter === 'published') return job.status === 'completed' && Boolean(job.artifactPath)
    if (filter === 'active') return !['completed', 'archived'].includes(job.status)
    return job.status !== 'archived'
  }), [filter, jobs])

  return (
    <section className="research-library">
      <header className="research-library-header">
        <div>
          <span className="research-eyebrow">RESEARCH LIBRARY</span>
          <h1>Reports built to keep</h1>
          <p>Every investigation, source ledger, and validated output remains available here.</p>
        </div>
        <div className="research-library-filters" role="group" aria-label="Research library filter">
          {(['all', 'published', 'active'] as LibraryFilter[]).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={filter === item}
              className={filter === item ? 'is-active' : ''}
              onClick={() => setFilter(item)}
            >
              {item === 'all' ? 'All' : item === 'published' ? 'Published' : 'In progress'}
            </button>
          ))}
        </div>
      </header>

      {visibleJobs.length === 0 ? (
        <div className="research-library-empty">
          <FileIcon size={22} />
          <strong>No research in this shelf yet</strong>
          <span>Start an investigation and its cover will appear here.</span>
        </div>
      ) : (
        <div className="research-library-grid">
          {visibleJobs.map((job) => (
            <button
              key={job.id}
              type="button"
              className="research-book"
              aria-label={`Open ${job.plan?.title || job.title}. Status: ${STATUS_LABELS[job.status]}.`}
              onClick={() => onSelect(job.id)}
            >
              <span className="research-book-cover">
                {covers[job.id]
                  ? <img src={covers[job.id] ?? undefined} alt={`Cover of ${job.title}`} />
                  : (
                    <span className="research-book-draft">
                      <small>AKORITH RESEARCH</small>
                      <strong>{job.plan?.title || job.title}</strong>
                      <em>{job.depth} · {job.outputFormat.toUpperCase()}</em>
                    </span>
                  )}
                <span className={`research-book-status is-${job.status}`} aria-hidden="true">
                  <span className="research-book-status-symbol" />
                  <span className="research-book-status-label">{STATUS_LABELS[job.status]}</span>
                </span>
              </span>
              <span className="research-book-meta">
                <strong>{job.plan?.title || job.title}</strong>
                <small>{job.sourceCount} sources · {job.findingCount} findings</small>
                <em>{formatDate(job.updatedAt)}</em>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function formatDate(timestamp: number): string {
  return DATE_FORMATTER.format(new Date(timestamp))
}
