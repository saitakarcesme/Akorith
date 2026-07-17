import { createRequire } from 'module'
import { load } from 'cheerio'
import { assertPublicResearchUrl } from './network-policy'

const require = createRequire(__filename)
const pdfParse = require('pdf-parse') as (buffer: Buffer) => Promise<{ text: string; numpages: number; info?: unknown }>

const MAX_REDIRECTS = 5
const MAX_SOURCE_BYTES = 12 * 1024 * 1024
const MAX_EXTRACTED_CHARS = 180_000
const FETCH_TIMEOUT_MS = 25_000
const HOST_INTERVAL_MS = 650

const lastHostFetch = new Map<string, number>()

export interface RetrievedResearchSource {
  requestedUrl: string
  canonicalUrl: string
  status: number
  mimeType: string
  title: string
  publisher?: string
  publishedAt?: string
  text: string
  byteSize: number
  pageCount?: number
  etag?: string
  lastModified?: string
}

export async function fetchResearchSource(rawUrl: string, signal?: AbortSignal): Promise<RetrievedResearchSource> {
  let url = await assertPublicResearchUrl(rawUrl)
  const requestedUrl = url.toString()
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await respectHostInterval(url.hostname, signal)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Source request timed out.')), FETCH_TIMEOUT_MS)
    const abort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,application/json;q=0.8,*/*;q=0.2',
          'accept-language': 'en-US,en;q=0.8',
          'user-agent': 'AkorithResearch/1.0 (+https://akorith.space)'
        }
      })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`Source redirected without a location (${response.status}).`)
      if (redirect === MAX_REDIRECTS) throw new Error('Source exceeded the redirect limit.')
      url = await assertPublicResearchUrl(new URL(location, url).toString())
      continue
    }
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_SOURCE_BYTES) throw new Error('Source exceeds the 12 MB research limit.')
    const bytes = await readLimitedBody(response, MAX_SOURCE_BYTES)
    const mimeType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase()
    const extracted = await extractSource(bytes, mimeType, url)
    return {
      requestedUrl,
      canonicalUrl: url.toString(),
      status: response.status,
      mimeType,
      title: extracted.title,
      publisher: extracted.publisher,
      publishedAt: extracted.publishedAt,
      text: extracted.text.slice(0, MAX_EXTRACTED_CHARS),
      byteSize: bytes.byteLength,
      pageCount: extracted.pageCount,
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined
    }
  }
  throw new Error('Source fetch failed.')
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel('source size limit exceeded')
      throw new Error('Source exceeds the 12 MB research limit.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

async function extractSource(
  bytes: Buffer,
  mimeType: string,
  url: URL
): Promise<{ title: string; publisher?: string; publishedAt?: string; text: string; pageCount?: number }> {
  if (mimeType === 'application/pdf' || bytes.subarray(0, 4).toString('ascii') === '%PDF') {
    const parsed = await pdfParse(bytes)
    return {
      title: titleFromUrl(url),
      publisher: url.hostname,
      text: normalizeExtractedText(parsed.text),
      pageCount: parsed.numpages
    }
  }
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (mimeType.includes('html') || /<html[\s>]/i.test(decoded.slice(0, 2_000))) {
    const $ = load(decoded)
    $('script,style,noscript,svg,canvas,iframe,form,nav,footer').remove()
    const title = cleanInline(
      $('meta[property="og:title"]').attr('content') || $('title').first().text() || $('h1').first().text()
    ) || titleFromUrl(url)
    const publisher = cleanInline(
      $('meta[property="og:site_name"]').attr('content') || $('meta[name="application-name"]').attr('content')
    ) || url.hostname
    const publishedAt = cleanInline(
      $('meta[property="article:published_time"]').attr('content') || $('time[datetime]').first().attr('datetime')
    ) || undefined
    const root = $('main').first().length
      ? $('main').first()
      : $('article').first().length
        ? $('article').first()
        : $('body')
    return { title, publisher, publishedAt, text: normalizeExtractedText(root.text()) }
  }
  return {
    title: titleFromUrl(url),
    publisher: url.hostname,
    text: normalizeExtractedText(decoded)
  }
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function cleanInline(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
}

function titleFromUrl(url: URL): string {
  const part = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
  return cleanInline(part.replace(/[-_]+/g, ' ')) || url.hostname
}

async function respectHostInterval(host: string, signal?: AbortSignal): Promise<void> {
  const last = lastHostFetch.get(host) ?? 0
  const wait = Math.max(0, HOST_INTERVAL_MS - (Date.now() - last))
  if (wait > 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait)
      const abort = (): void => {
        clearTimeout(timer)
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Research cancelled.'))
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  lastHostFetch.set(host, Date.now())
}
