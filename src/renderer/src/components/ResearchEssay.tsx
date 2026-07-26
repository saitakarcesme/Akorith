import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ResearchEssayPreview } from '../../../preload/index.d'

interface ResearchEssayProps {
  essay: ResearchEssayPreview
  actionPending?: boolean
  onOpenSource: (id: string) => Promise<void>
}

export default function ResearchEssay({
  essay,
  actionPending = false,
  onOpenSource
}: ResearchEssayProps): JSX.Element {
  const citationsByNumber = useMemo(
    () => new Map(essay.citations.map((citation) => [citation.number, citation])),
    [essay.citations]
  )
  const citationsById = useMemo(
    () => new Map(essay.citations.map((citation) => [citation.sourceId, citation])),
    [essay.citations]
  )
  const markdown = useMemo(
    () => linkEssayCitations(stripLeadingTitle(essay.markdown), citationsByNumber),
    [citationsByNumber, essay.markdown]
  )
  const hasSummarySection = /^##\s+(?:abstract|executive summary|summary|özet)\b/im.test(essay.markdown)
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => {
      const sourceId = researchSourceId(href)
      if (sourceId) {
        const citation = citationsById.get(sourceId)
        return (
          <button
            type="button"
            className="research-essay-citation"
            aria-label={citation ? `Open source ${citation.number}: ${citation.label}` : 'Open research source'}
            title={citation?.label || 'Open research source'}
            disabled={actionPending}
            onClick={() => void onOpenSource(sourceId)}
          >
            {children}
          </button>
        )
      }
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>
    },
    table: ({ children }) => <div className="research-essay-table"><table>{children}</table></div>
  }), [actionPending, citationsById, onOpenSource])

  return (
    <section className="research-essay" aria-label="Research essay">
      {!hasSummarySection && <p className="research-essay-summary">{essay.summary}</p>}
      <div className="research-essay-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{markdown}</ReactMarkdown>
      </div>
      <section className="research-essay-bibliography" aria-labelledby={`research-bibliography-${essay.jobId}`}>
        <h2 id={`research-bibliography-${essay.jobId}`}>Bibliography</h2>
        {essay.citations.length > 0 ? (
          <ol>
            {essay.citations.map((citation) => (
              <li key={citation.sourceId}>
                <button
                  type="button"
                  disabled={actionPending}
                  onClick={() => void onOpenSource(citation.sourceId)}
                >
                  <span>{citation.number}</span>
                  <strong>{citation.label}</strong>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p>No external sources were retained for this publication.</p>
        )}
      </section>
    </section>
  )
}

function stripLeadingTitle(markdown: string): string {
  return markdown.replace(/^\s*#\s+.+?(?:\r?\n)+/, '').trim()
}

function linkEssayCitations(
  markdown: string,
  citations: Map<number, ResearchEssayPreview['citations'][number]>
): string {
  return markdown.replace(/\[((?:\d+\s*,\s*)*\d+)\](?!\s*[:(])/g, (original, group: string) => {
    const linked = group
      .split(',')
      .map((value) => Number(value.trim()))
      .map((number) => {
        const citation = citations.get(number)
        return citation ? `[${number}](#research-source-${citation.sourceId})` : String(number)
      })
    return linked.some((value) => value.startsWith('[')) ? linked.join(', ') : original
  })
}

function researchSourceId(href?: string): string | null {
  if (!href?.startsWith('#research-source-')) return null
  const id = href.slice('#research-source-'.length)
  return /^[\w-]{1,64}$/.test(id) ? id : null
}
