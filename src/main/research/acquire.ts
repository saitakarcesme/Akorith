import type { ResearchJob, ResearchPlanSection, ResearchSource } from './types'
import { fetchResearchSource } from './fetcher'
import { searchResearchWeb, type ResearchSearchResult } from './search'
import {
  listResearchSources,
  logResearchEvent,
  recordResearchSource
} from './store'
import { safeResearchPath, writeJsonAtomic } from './workspace'

const FETCH_LIMITS: Record<ResearchJob['depth'], { queries: number; results: number; fetches: number }> = {
  quick: { queries: 2, results: 6, fetches: 4 },
  standard: { queries: 3, results: 8, fetches: 6 },
  deep: { queries: 4, results: 12, fetches: 8 },
  continuous: { queries: 3, results: 8, fetches: 5 }
}

export async function acquireResearchSources(input: {
  job: ResearchJob
  section: ResearchPlanSection
  cycleId: string
  signal?: AbortSignal
}): Promise<ResearchSource[]> {
  const limits = FETCH_LIMITS[input.job.depth]
  const queries = (input.section.queries.length > 0
    ? input.section.queries
    : [input.section.objective]
  ).slice(0, limits.queries)
  const known = new Set(listResearchSources(input.job.id).map((source) => source.url))
  const candidates: Array<ResearchSearchResult & { query: string }> = []
  for (const query of queries) {
    if (input.signal?.aborted) throw input.signal.reason
    try {
      const results = await searchResearchWeb(query, { limit: limits.results, signal: input.signal })
      for (const result of results) {
        if (!known.has(result.url)) candidates.push({ ...result, query })
      }
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error
      logResearchEvent({
        jobId: input.job.id,
        cycleId: input.cycleId,
        kind: 'warning',
        title: 'A search endpoint was unavailable; continuing with alternatives',
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const deduped = [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()]
    .slice(0, limits.fetches)
  const fetched = await mapWithConcurrency(deduped, 3, async (candidate) => {
    try {
      const retrieved = await fetchResearchSource(candidate.url, input.signal)
      if (!retrieved.text.trim()) return null
      const source = recordResearchSource({
        jobId: input.job.id,
        cycleId: input.cycleId,
        url: retrieved.canonicalUrl,
        title: retrieved.title || candidate.title,
        publisher: retrieved.publisher,
        publishedAt: retrieved.publishedAt,
        excerpt: retrieved.text,
        relevance: `Query: ${candidate.query}. ${candidate.snippet}`.slice(0, 4_000),
        verified: true
      })
      if (!source) return null
      writeJsonAtomic(safeResearchPath(input.job.workspaceDir, 'sources', `${source.id}.json`), {
        ...retrieved,
        text: retrieved.text.slice(0, 180_000),
        researchSourceId: source.id
      })
      logResearchEvent({
        jobId: input.job.id,
        cycleId: input.cycleId,
        kind: 'source_found',
        title: retrieved.title,
        detail: retrieved.canonicalUrl
      })
      return source
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error
      logResearchEvent({
        jobId: input.job.id,
        cycleId: input.cycleId,
        kind: 'warning',
        title: `Skipped inaccessible source · ${candidate.title.slice(0, 120)}`,
        detail: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  })
  const sources = fetched.filter((source): source is ResearchSource => source !== null)
  writeJsonAtomic(
    safeResearchPath(input.job.workspaceDir, 'SOURCES.json'),
    listResearchSources(input.job.id)
  )
  return sources
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const run = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  return results
}
