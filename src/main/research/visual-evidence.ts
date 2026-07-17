import type { ResearchClaim, ResearchSource } from './types'

export type ResearchVisualKind =
  | 'quantitative-chart'
  | 'source-quality-chart'
  | 'evidence-table'
  | 'web-snapshot'

export interface ResearchVisualProvenance {
  sourceIds: string[]
  sourceUrls: string[]
  generatedAt: number
  method: 'claim-value-extraction' | 'source-metadata' | 'sanitized-source-snapshot'
}

export interface ResearchVisualPoint {
  label: string
  value: number
  unit: string
  claimId?: string
  sourceIds: string[]
}

export interface ResearchVisualTableRow {
  cells: string[]
  sourceIds: string[]
}

export interface ResearchVisualSnapshot {
  sourceId: string
  title: string
  publisher: string
  url: string
  accessedAt: number
  excerpt: string
}

export interface ResearchVisualEvidence {
  id: string
  kind: ResearchVisualKind
  title: string
  caption: string
  altText: string
  provenance: ResearchVisualProvenance
  points?: ResearchVisualPoint[]
  columns?: string[]
  rows?: ResearchVisualTableRow[]
  snapshot?: ResearchVisualSnapshot
}

const MAX_CHART_POINTS = 8
const MAX_TABLE_ROWS = 12
const MAX_SNAPSHOTS = 2

/**
 * Builds visual evidence only from persisted claims and source records. It does
 * not ask a model to invent chart data and never loads a URL while exporting.
 * That makes repeated exports deterministic and keeps the exporter outside the
 * SSRF boundary enforced by the acquisition layer.
 */
export function buildResearchVisualEvidence(input: {
  claims: ResearchClaim[]
  sources: ResearchSource[]
  generatedAt: number
}): ResearchVisualEvidence[] {
  if (input.sources.length === 0) return []
  const sourceById = new Map(input.sources.map((source) => [source.id, source]))
  const visuals: ResearchVisualEvidence[] = []
  const quantitative = quantitativeChart(input.claims, sourceById, input.generatedAt)
  visuals.push(quantitative ?? sourceQualityChart(input.sources, input.generatedAt))
  visuals.push(evidenceTable(input.sources, input.generatedAt))
  visuals.push(...sourceSnapshots(input.sources, input.generatedAt))
  return visuals
}

export function researchVisualCitationNumbers(
  sourceIds: string[],
  sources: ResearchSource[]
): number[] {
  const numbers = sourceIds
    .map((id) => sources.findIndex((source) => source.id === id))
    .filter((index) => index >= 0)
    .map((index) => index + 1)
  return [...new Set(numbers)]
}

export function renderResearchVisualSvg(visual: ResearchVisualEvidence): string {
  if (visual.kind === 'web-snapshot' && visual.snapshot) return renderSnapshotSvg(visual)
  if (visual.kind === 'evidence-table') return renderTableSvg(visual)
  return renderChartSvg(visual)
}

function quantitativeChart(
  claims: ResearchClaim[],
  sourceById: Map<string, ResearchSource>,
  generatedAt: number
): ResearchVisualEvidence | null {
  const grouped = new Map<string, ResearchVisualPoint[]>()
  for (const claim of claims) {
    if (claim.status !== 'verified') continue
    const sourceIds = [...new Set(claim.evidence.map((item) => item.sourceId))]
      .filter((id) => sourceById.has(id))
    if (sourceIds.length === 0) continue
    for (const measurement of extractMeasurements(claim.text)) {
      const group = grouped.get(measurement.unit) ?? []
      group.push({
        label: compactLabel(claim.text, 62),
        value: measurement.value,
        unit: measurement.unit,
        claimId: claim.id,
        sourceIds
      })
      grouped.set(measurement.unit, group)
    }
  }
  const candidate = [...grouped.entries()]
    .filter(([, points]) => points.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)[0]
  if (!candidate) return null
  const [unit, points] = candidate
  const selected = dedupePoints(points).slice(0, MAX_CHART_POINTS)
  if (selected.length < 2) return null
  return makeVisual({
    id: 'reported-quantities',
    kind: 'quantitative-chart',
    title: `Reported quantitative evidence (${unit})`,
    caption: 'Values are extracted verbatim from verified, cited claims. Differing methodologies may limit direct comparison.',
    altText: `Horizontal comparison chart of ${selected.length} cited values measured in ${unit}.`,
    sourceIds: selected.flatMap((point) => point.sourceIds),
    sources: sourceById,
    generatedAt,
    method: 'claim-value-extraction',
    points: selected
  })
}

function sourceQualityChart(sources: ResearchSource[], generatedAt: number): ResearchVisualEvidence {
  const selected = [...sources]
    .sort((a, b) => (b.credibilityScore ?? 0) - (a.credibilityScore ?? 0))
    .slice(0, MAX_CHART_POINTS)
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  return makeVisual({
    id: 'source-quality',
    kind: 'source-quality-chart',
    title: 'Source confidence profile',
    caption: 'Akorith source-confidence metadata, shown as a quality-control aid rather than a factual ranking of publishers.',
    altText: `Horizontal chart comparing confidence metadata for ${selected.length} research sources.`,
    sourceIds: selected.map((source) => source.id),
    sources: sourceById,
    generatedAt,
    method: 'source-metadata',
    points: selected.map((source) => ({
      label: compactLabel(source.title, 58),
      value: Math.round(Math.max(0, Math.min(1, source.credibilityScore ?? 0)) * 100),
      unit: '%',
      sourceIds: [source.id]
    }))
  })
}

function evidenceTable(sources: ResearchSource[], generatedAt: number): ResearchVisualEvidence {
  const selected = sources.slice(0, MAX_TABLE_ROWS)
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  return makeVisual({
    id: 'source-evidence-table',
    kind: 'evidence-table',
    title: 'Evidence at a glance',
    caption: `A compact provenance table for ${selected.length} of ${sources.length} collected sources.`,
    altText: `Table listing source title, publisher, date, confidence metadata, and verification state for ${selected.length} sources.`,
    sourceIds: selected.map((source) => source.id),
    sources: sourceById,
    generatedAt,
    method: 'source-metadata',
    columns: ['Source', 'Publisher', 'Published', 'Confidence', 'Status'],
    rows: selected.map((source) => ({
      sourceIds: [source.id],
      cells: [
        compactLabel(source.title, 74),
        compactLabel(source.publisher || safeHostname(source.url), 34),
        source.publishedAt?.slice(0, 10) || 'Not reported',
        `${Math.round(Math.max(0, Math.min(1, source.credibilityScore ?? 0)) * 100)}%`,
        source.verified ? 'Verified fetch' : 'Unverified'
      ]
    }))
  })
}

function sourceSnapshots(sources: ResearchSource[], generatedAt: number): ResearchVisualEvidence[] {
  return [...sources]
    .filter((source) => Boolean(source.excerpt?.trim()))
    .sort((a, b) => Number(b.verified) - Number(a.verified) || (b.credibilityScore ?? 0) - (a.credibilityScore ?? 0))
    .slice(0, MAX_SNAPSHOTS)
    .map((source, index) => makeVisual({
      id: `web-evidence-${index + 1}`,
      kind: 'web-snapshot',
      title: `Web evidence snapshot ${index + 1}`,
      caption: 'A local, script-free snapshot of the text Akorith actually retrieved. It is not a live webpage and performs no network request during export.',
      altText: `Sanitized source snapshot for ${source.title}, published by ${source.publisher || safeHostname(source.url)}.`,
      sourceIds: [source.id],
      sources: new Map([[source.id, source]]),
      generatedAt,
      method: 'sanitized-source-snapshot',
      snapshot: {
        sourceId: source.id,
        title: source.title,
        publisher: source.publisher || safeHostname(source.url),
        url: source.url,
        accessedAt: source.accessedAt,
        excerpt: compactWhitespace(source.excerpt ?? '').slice(0, 1_100)
      }
    }))
}

function makeVisual(input: {
  id: string
  kind: ResearchVisualKind
  title: string
  caption: string
  altText: string
  sourceIds: string[]
  sources: Map<string, ResearchSource>
  generatedAt: number
  method: ResearchVisualProvenance['method']
  points?: ResearchVisualPoint[]
  columns?: string[]
  rows?: ResearchVisualTableRow[]
  snapshot?: ResearchVisualSnapshot
}): ResearchVisualEvidence {
  const sourceIds = [...new Set(input.sourceIds)].filter((id) => input.sources.has(id))
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    caption: input.caption,
    altText: input.altText,
    provenance: {
      sourceIds,
      sourceUrls: sourceIds.map((id) => input.sources.get(id)!.url),
      generatedAt: input.generatedAt,
      method: input.method
    },
    points: input.points,
    columns: input.columns,
    rows: input.rows,
    snapshot: input.snapshot
  }
}

function extractMeasurements(text: string): Array<{ value: number; unit: string }> {
  const matches: Array<{ value: number; unit: string }> = []
  const pattern = /(-?\d+(?:[.,]\d+)?)\s*(%|percent(?:age)?|puan|points?|score|ms|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|gb|mb|tb|tokens?(?:\/(?:s|sec|second))?)/giu
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1].replace(',', '.'))
    if (!Number.isFinite(value)) continue
    matches.push({ value, unit: normalizeUnit(match[2]) })
  }
  return matches
}

function normalizeUnit(unit: string): string {
  const normalized = unit.toLocaleLowerCase('en-US')
  if (normalized === 'percent' || normalized === 'percentage') return '%'
  if (normalized === 'puan' || normalized === 'point' || normalized === 'points' || normalized === 'score') return 'points'
  if (normalized === 'millisecond' || normalized === 'milliseconds') return 'ms'
  if (normalized === 'second' || normalized === 'seconds' || normalized === 'sec' || normalized === 'secs') return 'seconds'
  if (normalized === 'minute' || normalized === 'minutes' || normalized === 'min' || normalized === 'mins') return 'minutes'
  if (normalized === 'hour' || normalized === 'hours' || normalized === 'hr' || normalized === 'hrs') return 'hours'
  if (normalized === 'day' || normalized === 'days') return 'days'
  return normalized.toUpperCase()
}

function dedupePoints(points: ResearchVisualPoint[]): ResearchVisualPoint[] {
  return [...new Map(points.map((point) => [`${point.label}:${point.value}:${point.unit}`, point])).values()]
}

function renderChartSvg(visual: ResearchVisualEvidence): string {
  const width = 920
  const points = visual.points ?? []
  const rowHeight = 52
  const height = Math.max(360, 190 + points.length * rowHeight)
  const chartX = 350
  const chartWidth = width - chartX - 82
  const max = Math.max(1, ...points.map((point) => Math.abs(point.value)))
  const rows = points.map((point, index) => {
    const y = 150 + index * rowHeight
    const barWidth = Math.max(2, Math.round((Math.abs(point.value) / max) * chartWidth))
    return `<text x="42" y="${y + 18}" class="label">${escapeXml(compactLabel(point.label, 48))}</text>
      <rect x="${chartX}" y="${y}" width="${chartWidth}" height="24" rx="7" fill="#272B29"/>
      <rect x="${chartX}" y="${y}" width="${barWidth}" height="24" rx="7" fill="#6FD1A4"/>
      <text x="${Math.min(chartX + barWidth + 10, width - 70)}" y="${y + 18}" class="value">${escapeXml(formatValue(point.value, point.unit))}</text>`
  }).join('\n')
  return svgShell(width, height, visual, rows)
}

function renderTableSvg(visual: ResearchVisualEvidence): string {
  const width = 920
  const rows = (visual.rows ?? []).slice(0, 8)
  const height = Math.max(380, 210 + rows.length * 54)
  const columns = visual.columns ?? []
  const header = columns.map((column, index) =>
    `<text x="${[42, 390, 590, 710, 810][index] ?? 42}" y="150" class="tableHead">${escapeXml(column)}</text>`
  ).join('')
  const body = rows.map((row, rowIndex) => {
    const y = 178 + rowIndex * 54
    const cells = row.cells.map((cell, index) =>
      `<text x="${[42, 390, 590, 710, 810][index] ?? 42}" y="${y + 22}" class="tableCell">${escapeXml(compactLabel(cell, [42, 22, 15, 12, 14][index] ?? 16))}</text>`
    ).join('')
    return `<rect x="32" y="${y}" width="856" height="44" rx="6" fill="${rowIndex % 2 === 0 ? '#202422' : '#1A1D1C'}"/>${cells}`
  }).join('')
  return svgShell(width, height, visual, `${header}${body}`)
}

function renderSnapshotSvg(visual: ResearchVisualEvidence): string {
  const width = 920
  const height = 560
  const snapshot = visual.snapshot!
  const titleLines = wrapText(snapshot.title, 62, 2)
  const excerptLines = wrapText(snapshot.excerpt, 92, 7)
  const content = `<rect x="32" y="132" width="856" height="370" rx="14" fill="#1B1F1D" stroke="#353A37"/>
    <circle cx="62" cy="166" r="7" fill="#6FD1A4"/>
    <text x="82" y="172" class="publisher">${escapeXml(snapshot.publisher)}</text>
    ${titleLines.map((line, index) => `<text x="58" y="${220 + index * 35}" class="snapshotTitle">${escapeXml(line)}</text>`).join('')}
    <line x1="58" y1="292" x2="862" y2="292" stroke="#343A36"/>
    ${excerptLines.map((line, index) => `<text x="58" y="${330 + index * 25}" class="excerpt">${escapeXml(line)}</text>`).join('')}
    <text x="58" y="478" class="url">${escapeXml(compactLabel(snapshot.url, 112))}</text>`
  return svgShell(width, height, visual, content)
}

function svgShell(width: number, height: number, visual: ResearchVisualEvidence, content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(visual.title)}</title>
  <desc id="desc">${escapeXml(visual.altText)}</desc>
  <style>
    text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Arial,sans-serif}
    .kicker{fill:#6FD1A4;font-size:12px;font-weight:700;letter-spacing:1.4px}.title{fill:#F4F6F3;font-size:27px;font-weight:700}
    .caption{fill:#989F9A;font-size:13px}.label{fill:#D9DDDA;font-size:14px}.value{fill:#F4F6F3;font-size:13px;font-weight:700}
    .tableHead{fill:#8D9690;font-size:11px;font-weight:700;text-transform:uppercase}.tableCell{fill:#E2E6E3;font-size:12px}
    .publisher{fill:#AEB5B0;font-size:13px;font-weight:600}.snapshotTitle{fill:#F4F6F3;font-size:25px;font-weight:700}
    .excerpt{fill:#C6CBC7;font-size:15px}.url{fill:#6FD1A4;font-size:11px}
  </style>
  <rect width="${width}" height="${height}" rx="18" fill="#121513"/>
  <text x="36" y="39" class="kicker">AKORITH VISUAL EVIDENCE</text>
  <text x="36" y="79" class="title">${escapeXml(visual.title)}</text>
  <text x="36" y="108" class="caption">${escapeXml(compactLabel(visual.caption, 132))}</text>
  ${content}
  <text x="36" y="${height - 20}" class="caption">Provenance: ${visual.provenance.sourceIds.length} cited source${visual.provenance.sourceIds.length === 1 ? '' : 's'} · ${escapeXml(visual.provenance.method)}</text>
</svg>`
}

function wrapText(value: string, maxChars: number, maxLines: number): string[] {
  const words = compactWhitespace(value).split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (candidate.length <= maxChars) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    line = word
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && line) lines.push(line)
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[….]+$/, '')}…`
  }
  return lines
}

function formatValue(value: number, unit: string): string {
  const numeric = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return unit === '%' ? `${numeric}%` : `${numeric} ${unit}`
}

function compactLabel(value: string, max: number): string {
  const clean = compactWhitespace(value)
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

function compactWhitespace(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
}

function safeHostname(rawUrl: string): string {
  try { return new URL(rawUrl).hostname } catch { return 'Unknown publisher' }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
