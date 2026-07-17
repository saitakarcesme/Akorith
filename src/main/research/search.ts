import { load } from 'cheerio'
import { assertPublicResearchUrl } from './network-policy'
import { canonicalizeResearchUrl } from './source-policy'

const SEARCH_TIMEOUT_MS = 20_000
const MAX_SEARCH_HTML = 2 * 1024 * 1024

export interface ResearchSearchResult {
  title: string
  url: string
  snippet: string
  engine: 'duckduckgo' | 'bing-rss'
}

export async function searchResearchWeb(
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<ResearchSearchResult[]> {
  const clean = query.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, 1_000)
  if (!clean) return []
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 20)
  try {
    const results = await searchDuckDuckGo(clean, limit, options.signal)
    if (results.length > 0) return results
  } catch {
    // A public search frontend may rate-limit automated requests. The RSS
    // fallback keeps the job moving without pretending results were found.
  }
  return searchBingRss(clean, limit, options.signal)
}

async function searchDuckDuckGo(query: string, limit: number, signal?: AbortSignal): Promise<ResearchSearchResult[]> {
  const url = await assertPublicResearchUrl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`)
  const html = await fetchSearchDocument(url, signal)
  const $ = load(html)
  const results: ResearchSearchResult[] = []
  $('.result').each((_index, element) => {
    if (results.length >= limit) return false
    const anchor = $(element).find('a.result__a').first()
    const rawHref = anchor.attr('href') ?? ''
    const url = unwrapDuckDuckGoUrl(rawHref)
    const canonical = canonicalizeResearchUrl(url)
    if (!canonical || isSearchEngineUrl(canonical)) return
    results.push({
      title: anchor.text().replace(/\s+/g, ' ').trim().slice(0, 500) || new URL(canonical).hostname,
      url: canonical,
      snippet: $(element).find('.result__snippet').first().text().replace(/\s+/g, ' ').trim().slice(0, 2_000),
      engine: 'duckduckgo'
    })
  })
  return uniqueResults(results).slice(0, limit)
}

async function searchBingRss(query: string, limit: number, signal?: AbortSignal): Promise<ResearchSearchResult[]> {
  const url = await assertPublicResearchUrl(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`)
  const xml = await fetchSearchDocument(url, signal)
  const $ = load(xml, { xmlMode: true })
  const results: ResearchSearchResult[] = []
  $('item').each((_index, element) => {
    if (results.length >= limit) return false
    const rawUrl = $(element).find('link').first().text().trim()
    const canonical = canonicalizeResearchUrl(rawUrl)
    if (!canonical || isSearchEngineUrl(canonical)) return
    results.push({
      title: $(element).find('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 500) || new URL(canonical).hostname,
      url: canonical,
      snippet: $(element).find('description').first().text().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2_000),
      engine: 'bing-rss'
    })
  })
  return uniqueResults(results).slice(0, limit)
}

async function fetchSearchDocument(url: URL, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Search timed out.')), SEARCH_TIMEOUT_MS)
  const abort = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/rss+xml,application/xml;q=0.9',
        'accept-language': 'en-US,en;q=0.8',
        'user-agent': 'AkorithResearch/1.0 (+https://akorith.space)'
      }
    })
    if (!response.ok) throw new Error(`Search returned HTTP ${response.status}.`)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_SEARCH_HTML) throw new Error('Search response is too large.')
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_SEARCH_HTML) throw new Error('Search response is too large.')
    return text
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const url = new URL(href, 'https://html.duckduckgo.com')
    return url.searchParams.get('uddg') ?? url.toString()
  } catch {
    return href
  }
}

function isSearchEngineUrl(url: string): boolean {
  const host = new URL(url).hostname
  return host.endsWith('duckduckgo.com') || host.endsWith('bing.com')
}

function uniqueResults(results: ResearchSearchResult[]): ResearchSearchResult[] {
  const seen = new Set<string>()
  return results.filter((result) => {
    if (seen.has(result.url)) return false
    seen.add(result.url)
    return true
  })
}
