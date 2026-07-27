import { memo } from 'react'
import type {
  ResearchEssayPreview,
  ResearchLiveDetail,
  ResearchOutputFormat,
  ResearchPhase,
  ResearchStatus
} from '../../../preload/index.d'
import { FileIcon, FolderOpenIcon, PauseIcon, PlayIcon } from './icons'
import ResearchEssay from './ResearchEssay'
import ResearchOperationalDetails from './ResearchOperationalDetails'

const PHASE_COPY: Record<ResearchPhase, string> = {
  understand: 'Interpreting the requested outcome and defining an evidence boundary.',
  plan: 'Building search tracks, verification rules, and the final report structure.',
  research: 'Collecting sources and turning verifiable evidence into cited findings.',
  verify: 'Checking claim coverage, conflicts, source quality, and open evidence gaps.',
  synthesize: 'Writing the report while preserving source links and uncertainty.',
  export: 'Packaging and validating the selected deliverable for the Research library.'
}

const EXPORT_FORMATS = [
  { id: 'pdf', label: 'PDF' },
  { id: 'html', label: 'Web page' },
  { id: 'md', label: 'Markdown' },
  { id: 'docx', label: 'DOCX' },
  { id: 'xlsx', label: 'Evidence XLSX' },
  { id: 'pptx', label: 'PowerPoint' }
] as const satisfies ReadonlyArray<{ id: ResearchOutputFormat; label: string }>

interface ResearchProgressProps {
  detail: ResearchLiveDetail
  essay?: ResearchEssayPreview | null
  actionPending?: boolean
  onPause: () => Promise<void>
  onResume: () => Promise<void>
  onExport: (format: ResearchOutputFormat) => Promise<void>
  onOpenArtifact: (id: string) => Promise<void>
  onRevealArtifact: (id: string) => Promise<void>
  onOpenSource: (id: string) => Promise<void>
}

function ResearchProgress({
  detail,
  essay,
  actionPending = false,
  onPause,
  onResume,
  onExport,
  onOpenArtifact,
  onRevealArtifact,
  onOpenSource
}: ResearchProgressProps): JSX.Element {
  const { job } = detail
  const terminal = job.status === 'completed' || job.status === 'archived'
  const paused = job.status === 'paused' || job.status === 'error'

  const artifacts = detail.artifacts.length > 0 ? (
    <section className="research-artifacts">
      <div className="research-section-heading">
        <div><span className="research-eyebrow">PUBLISH</span><h2>Download or publish</h2></div>
        <div className="research-export-menu" aria-label="Export research essay">
          {EXPORT_FORMATS.map((format) => (
            <button key={format.id} type="button" disabled={actionPending} onClick={() => void onExport(format.id)}>{format.label}</button>
          ))}
        </div>
      </div>
      <div className="research-artifact-list">
        {detail.artifacts.map((artifact) => (
          <div key={artifact.id} className="research-artifact-row">
            <span className="research-artifact-icon"><FileIcon size={17} /></span>
            <div><strong>{artifact.title}</strong><small>{artifact.format.toUpperCase()} · {formatBytes(artifact.byteSize)} · v{artifact.version}</small></div>
            <button type="button" title="Open output" aria-label={`Open ${artifact.title}`} disabled={actionPending} onClick={() => void onOpenArtifact(artifact.id)}><FileIcon size={15} /></button>
            <button type="button" title="Reveal in folder" aria-label={`Reveal ${artifact.title} in folder`} disabled={actionPending} onClick={() => void onRevealArtifact(artifact.id)}><FolderOpenIcon size={15} /></button>
          </div>
        ))}
      </div>
    </section>
  ) : null

  return (
    <article className={`research-progress ${terminal ? 'is-essay-ready' : ''}`}>
      {!terminal && <div className="research-request-bubble"><span>{job.prompt}</span></div>}

      <header className="research-progress-header">
        <div>
          <span className="research-eyebrow">{terminal ? 'RESEARCH ESSAY' : statusLabel(job.status)}</span>
          <h1>{essay?.title || job.plan?.title || job.title}</h1>
          <p>{terminal ? 'A publication-ready synthesis with its supporting research available separately.' : PHASE_COPY[job.phase]}</p>
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

      {terminal && (
        essay === undefined ? (
          <div className="research-essay-loading" role="status"><i aria-hidden="true" /><span>Preparing the essay…</span></div>
        ) : essay ? (
          <ResearchEssay essay={essay} actionPending={actionPending} onOpenSource={onOpenSource} />
        ) : (
          <div className="research-essay-unavailable">
            <strong>Essay preview unavailable</strong>
            <span>The validated files remain available below.</span>
          </div>
        )
      )}

      {terminal && artifacts}

      <ResearchOperationalDetails
        detail={detail}
        collapsed={terminal}
        actionPending={actionPending}
        onOpenSource={onOpenSource}
      />

      {!terminal && artifacts}
    </article>
  )
}

export default memo(ResearchProgress)

function statusLabel(status: ResearchStatus): string {
  return status.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}
