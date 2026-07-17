import type { ResearchClaim, ResearchJob, ResearchPlan, ResearchSource } from './types'
import {
  buildResearchVisualEvidence,
  type ResearchVisualEvidence
} from './visual-evidence'

export interface ResearchDocumentSection {
  id: string
  title: string
  body: string
  claims: ResearchClaim[]
}

export interface ResearchDocument {
  title: string
  subtitle: string
  requestedBy: string
  generatedAt: number
  depthLabel: string
  providerLabel: string
  modelLabel: string
  methodology: string[]
  verificationCriteria: string[]
  executiveSummary: string
  sections: ResearchDocumentSection[]
  sources: ResearchSource[]
  visuals: ResearchVisualEvidence[]
}

export function buildResearchDocument(input: {
  job: ResearchJob
  plan?: ResearchPlan
  reportMarkdown: string
  claims: ResearchClaim[]
  sources: ResearchSource[]
}): ResearchDocument {
  const parsed = splitMarkdownSections(input.reportMarkdown)
  const planSections = input.plan?.sections ?? []
  const sectionIds = new Set<string>()
  const sections: ResearchDocumentSection[] = []

  for (const planned of planSections) {
    sectionIds.add(planned.id)
    const matched = parsed.find((section) => normalizeHeading(section.title) === normalizeHeading(planned.title))
    sections.push({
      id: planned.id,
      title: planned.title,
      body: matched?.body || planned.objective,
      claims: input.claims.filter((claim) => claim.sectionId === planned.id)
    })
  }
  for (const section of parsed) {
    if (isReservedReportSection(section.title)) continue
    const id = normalizeHeading(section.title) || `section-${sections.length + 1}`
    if (sectionIds.has(id) || sections.some((item) => normalizeHeading(item.title) === id)) continue
    sections.push({
      id,
      title: section.title,
      body: section.body,
      claims: input.claims.filter((claim) => claim.sectionId === id)
    })
  }
  if (sections.length === 0) {
    sections.push({ id: 'findings', title: 'Findings', body: input.reportMarkdown.trim(), claims: input.claims })
  }

  const generatedAt = Date.now()
  return {
    title: input.plan?.title || input.job.title,
    subtitle: input.plan?.thesis || input.job.prompt,
    requestedBy: 'Akorith Research',
    generatedAt,
    depthLabel: input.job.depth,
    providerLabel: input.job.providerId,
    modelLabel: input.job.model || 'Default model',
    methodology: input.plan?.sourceStrategy ?? [],
    verificationCriteria: input.plan?.verificationCriteria ?? [],
    executiveSummary: input.job.summary || firstUsefulParagraph(input.reportMarkdown),
    sections,
    sources: input.sources,
    visuals: buildResearchVisualEvidence({
      claims: input.claims,
      sources: input.sources,
      generatedAt
    })
  }
}

export function splitMarkdownSections(markdown: string): Array<{ title: string; body: string }> {
  const lines = markdown.replace(/\r/g, '').split('\n')
  const sections: Array<{ title: string; body: string }> = []
  let currentTitle = ''
  let body: string[] = []
  const flush = (): void => {
    const text = body.join('\n').trim()
    if (currentTitle || text) sections.push({ title: currentTitle || 'Overview', body: text })
    body = []
  }
  for (const line of lines) {
    const heading = /^(?:##|###)\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flush()
      currentTitle = heading[1].replace(/[*_`]/g, '').trim()
    } else if (!/^#\s+/.test(line)) {
      body.push(line)
    }
  }
  flush()
  return sections.filter((section) => section.title || section.body)
}

export function sourceCitationLabel(source: ResearchSource, index: number): string {
  const author = source.publisher || new URL(source.url).hostname
  return `[${index + 1}] ${author}. ${source.title}. ${source.url}`
}

function normalizeHeading(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function isReservedReportSection(title: string): boolean {
  return ['executive-summary', 'sources', 'methodology'].includes(normalizeHeading(title))
}

function firstUsefulParagraph(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+.*$/gm, '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .find(Boolean)
    ?.slice(0, 2_000) || 'Research completed.'
}
