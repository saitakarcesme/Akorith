import {
  RESEARCH_DEPTH_PROFILES,
  type ResearchClaim,
  type ResearchJob,
  type ResearchPlan,
  type ResearchSource
} from './types'
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
  abstract: string
  introduction: string
  executiveSummary: string
  sections: ResearchDocumentSection[]
  conclusion: string
  sources: ResearchSource[]
  visuals: ResearchVisualEvidence[]
}

export function buildResearchDocument(input: {
  job: ResearchJob
  plan?: ResearchPlan
  reportMarkdown: string
  claims: ResearchClaim[]
  sources: ResearchSource[]
  generatedAt?: number
}): ResearchDocument {
  const parsed = splitMarkdownSections(input.reportMarkdown)
  const sourceDisplay = deduplicateResearchSources(input.sources)
  const displayClaims = rankAndDeduplicateResearchClaims(input.claims.map((claim) => ({
    ...claim,
    evidence: claim.evidence.map((evidence) => ({
      ...evidence,
      sourceId: sourceDisplay.redirects.get(evidence.sourceId) ?? evidence.sourceId
    }))
  })))
  const abstractSection = findReportSection(parsed, ['abstract', 'executive-summary', 'summary'])
  const introductionSection = findReportSection(parsed, ['introduction', 'overview'])
  const conclusionSection = findReportSection(parsed, ['conclusion', 'conclusions'])
  const sections: ResearchDocumentSection[] = parsed
    .filter((section) => !isReservedReportSection(section.title))
    .map((section, index) => {
      const id = normalizeHeading(section.title) || `section-${index + 1}`
      const planned = input.plan?.sections.find((candidate) =>
        candidate.id === id || normalizeHeading(candidate.title) === id
      )
      return {
        id,
        title: section.title,
        body: section.body,
        claims: displayClaims.filter((claim) =>
          claim.sectionId === id || (planned && claim.sectionId === planned.id)
        )
      }
    })
  if (sections.length === 0) {
    const body = input.reportMarkdown
      .replace(/^#\s+.*$/m, '')
      .trim()
    sections.push({ id: 'analysis', title: 'Analysis', body, claims: displayClaims })
  }

  const generatedAt = input.generatedAt ?? Date.now()
  const abstract = abstractSection?.body
    || input.job.summary
    || firstUsefulParagraph(input.reportMarkdown)
  const introduction = introductionSection?.body
    || input.plan?.thesis
    || abstract
  const conclusion = conclusionSection?.body
    || lastUsefulParagraph(input.reportMarkdown)
    || abstract
  return {
    title: markdownTitle(input.reportMarkdown) || input.plan?.title || input.job.title,
    subtitle: input.plan?.thesis || input.job.prompt,
    requestedBy: 'Akorith Research',
    generatedAt,
    depthLabel: RESEARCH_DEPTH_PROFILES[input.job.depth]?.label ?? input.job.depth,
    providerLabel: input.job.providerId,
    modelLabel: input.job.model || 'Default model',
    methodology: input.plan?.sourceStrategy ?? [],
    verificationCriteria: input.plan?.verificationCriteria ?? [],
    abstract,
    introduction,
    executiveSummary: abstract,
    sections,
    conclusion,
    sources: sourceDisplay.sources,
    visuals: buildResearchVisualEvidence({
      claims: displayClaims,
      sources: sourceDisplay.sources,
      generatedAt
    })
  }
}

/**
 * Builds the private editorial claim set without mutating or deleting persisted
 * evidence. Equivalent claims from repeated autonomous cycles are merged, their
 * source links are retained, and the strongest record wins deterministically.
 */
export function rankAndDeduplicateResearchClaims(claims: ResearchClaim[]): ResearchClaim[] {
  const groups = new Map<string, ResearchClaim[]>()
  const ungrouped: ResearchClaim[][] = []
  for (const claim of claims) {
    const key = normalizedClaimText(claim.text)
    // Empty text has no semantic identity. In particular, never let two
    // non-Latin claims collapse merely because an ASCII-only normalizer erased
    // both of them.
    if (!key) {
      ungrouped.push([claim])
      continue
    }
    const groupKey = `${normalizeComparableText(claim.sectionId ?? '')}\u0000${key}`
    const group = groups.get(groupKey) ?? []
    group.push(claim)
    groups.set(groupKey, group)
  }

  return [...groups.values(), ...ungrouped]
    .map((group) => {
      const ranked = [...group].sort(compareClaimQuality)
      const winner = ranked[0]
      const evidence = new Map<string, ResearchClaim['evidence'][number]>()
      for (const claim of ranked) {
        for (const item of claim.evidence) {
          const key = `${item.sourceId}\u0000${item.relation}\u0000${normalizeComparableText(item.evidence ?? '')}`
          if (!evidence.has(key)) evidence.set(key, item)
        }
      }
      const mergedEvidence = [...evidence.values()]
      const conflicted = ranked.some((claim) => claim.status === 'conflicted')
        || mergedEvidence.some((item) => item.relation === 'contradicts')
      return {
        ...winner,
        status: conflicted ? 'conflicted' as const : winner.status,
        evidence: mergedEvidence
      }
    })
    .sort(compareClaimQuality)
}

export function deduplicateResearchSources(sources: ResearchSource[]): {
  sources: ResearchSource[]
  redirects: Map<string, string>
} {
  const groups = new Map<string, ResearchSource[]>()
  for (const source of sources) {
    const key = canonicalResearchSourceKey(source)
    const group = groups.get(key) ?? []
    group.push(source)
    groups.set(key, group)
  }
  const redirects = new Map<string, string>()
  const unique = [...groups.values()].map((group) => {
    const winner = [...group].sort(compareSourceQuality)[0]
    group.forEach((source) => redirects.set(source.id, winner.id))
    return winner
  })
  return { sources: unique, redirects }
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
    const heading = /^##\s+(.+?)\s*$/.exec(line)
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
  return [
    'abstract',
    'executive-summary',
    'summary',
    'introduction',
    'overview',
    'conclusion',
    'conclusions',
    'sources',
    'references',
    'bibliography',
    'methodology',
    'verification-criteria',
    'evidence-ledger',
    'research-log'
  ].includes(normalizeHeading(title))
}

function findReportSection(
  sections: Array<{ title: string; body: string }>,
  names: string[]
): { title: string; body: string } | undefined {
  return sections.find((section) => names.includes(normalizeHeading(section.title)))
}

function markdownTitle(markdown: string): string {
  return /^#\s+(.+?)\s*$/m.exec(markdown)?.[1]?.replace(/[*_`]/g, '').trim() ?? ''
}

function firstUsefulParagraph(markdown: string): string {
  const paragraph = markdown
    .replace(/^#{1,6}\s+.*$/gm, '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .find(Boolean)
  return paragraph ? Array.from(paragraph).slice(0, 2_000).join('') : 'Research completed.'
}

function lastUsefulParagraph(markdown: string): string {
  const paragraphs = markdown
    .replace(/^#{1,6}\s+.*$/gm, '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const paragraph = paragraphs.at(-1)
  return paragraph ? Array.from(paragraph).slice(0, 4_000).join('') : ''
}

function normalizedClaimText(value: string): string {
  return normalizeComparableText(value)
}

function normalizeComparableText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim()
}

function compareClaimQuality(left: ResearchClaim, right: ResearchClaim): number {
  const status = claimStatusRank(right.status) - claimStatusRank(left.status)
  if (status !== 0) return status
  const confidence = right.confidenceScore - left.confidenceScore
  if (confidence !== 0) return confidence
  const evidence = right.evidence.length - left.evidence.length
  if (evidence !== 0) return evidence
  const detail = right.text.length - left.text.length
  if (detail !== 0) return detail
  return left.id.localeCompare(right.id)
}

function claimStatusRank(status: ResearchClaim['status']): number {
  if (status === 'verified') return 3
  if (status === 'conflicted') return 2
  return 1
}

export function canonicalResearchSourceKey(source: ResearchSource): string {
  try {
    const url = new URL(source.url)
    url.hash = ''
    const retainedParameters = [...url.searchParams.entries()].filter(([key]) => !isTrackingParameter(key))
    url.search = ''
    for (const [key, value] of retainedParameters) {
      url.searchParams.append(key, value)
    }
    // WHATWG URL parsing canonicalizes the scheme and hostname to lowercase.
    // Do not lowercase the serialized URL: paths and query values can be
    // case-sensitive identifiers.
    return url.toString()
  } catch {
    const title = normalizeComparableText(source.title)
    const publisher = normalizeComparableText(source.publisher ?? '')
    return title || publisher
      ? `metadata:${title}\u0000${publisher}`
      : `source:${source.id}`
  }
}

function isTrackingParameter(key: string): boolean {
  return /^utm_/i.test(key)
    || /^(?:fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i.test(key)
}

function compareSourceQuality(left: ResearchSource, right: ResearchSource): number {
  if (left.verified !== right.verified) return right.verified ? 1 : -1
  const credibility = (right.credibilityScore ?? 0) - (left.credibilityScore ?? 0)
  if (credibility !== 0) return credibility
  const detail = `${right.excerpt ?? ''}${right.relevance ?? ''}`.length - `${left.excerpt ?? ''}${left.relevance ?? ''}`.length
  if (detail !== 0) return detail
  return left.id.localeCompare(right.id)
}
