import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import {
  DETERMINISTIC_RESEARCH_NOW,
  EXPECTED_RESEARCH_FIXTURE_COUNT,
  RESEARCH_CORE_FIXTURE_MATRIX,
  TEST_RESEARCH_DEPTHS,
  TEST_RESEARCH_OUTPUTS,
  TEST_RESEARCH_PROVIDERS,
  createDeterministicResearchDocument,
  createLayoutStressResearchDocument
} from '../src/main/research/__tests__/fixture-matrix.ts'
import { createResearchCoverSvg, layoutResearchCover } from '../src/main/research/cover.ts'
import {
  buildResearchDocument,
  deduplicateResearchSources,
  rankAndDeduplicateResearchClaims
} from '../src/main/research/document.ts'
import { exportResearchDocx } from '../src/main/research/exporters/docx.ts'
import { compactArtifactText, fitArtifactText } from '../src/main/research/exporters/design.ts'
import { exportResearchMarkdown, renderResearchMarkdown } from '../src/main/research/exporters/markdown.ts'
import { exportResearchPdf } from '../src/main/research/exporters/pdf.ts'
import { exportResearchPptx } from '../src/main/research/exporters/pptx.ts'
import { resolveResearchPdfFontPaths } from '../src/main/research/exporters/pdf-fonts.ts'
import { validateResearchArtifact } from '../src/main/research/exporters/validate.ts'
import { exportResearchXlsx } from '../src/main/research/exporters/xlsx.ts'
import {
  buildResearchVisualEvidence,
  renderResearchVisualSvg
} from '../src/main/research/visual-evidence.ts'
import type { ResearchDocument } from '../src/main/research/document.ts'
import type { ResearchJob, ResearchOutputFormat } from '../src/main/research/types.ts'

const require = createRequire(__filename)
const pdfParse = require('pdf-parse') as (buffer: Buffer) => Promise<{ text: string; numpages: number }>

assert.equal(RESEARCH_CORE_FIXTURE_MATRIX.length, EXPECTED_RESEARCH_FIXTURE_COUNT)
assert.equal(
  EXPECTED_RESEARCH_FIXTURE_COUNT,
  TEST_RESEARCH_DEPTHS.length * TEST_RESEARCH_PROVIDERS.length * TEST_RESEARCH_OUTPUTS.length,
  'matrix must cover every bounded depth, provider class, and output format'
)

const tupleKeys = new Set(
  RESEARCH_CORE_FIXTURE_MATRIX.map((fixture) =>
    `${fixture.depth}:${fixture.providerClass}:${fixture.outputFormat}`
  )
)
assert.equal(tupleKeys.size, EXPECTED_RESEARCH_FIXTURE_COUNT, 'fixture dimension tuples must be unique')

async function main(): Promise<void> {
  const retainedRoot = process.env.AKORITH_RESEARCH_ARTIFACT_DIR
    ? resolve(process.env.AKORITH_RESEARCH_ARTIFACT_DIR)
    : null
  const root = retainedRoot ?? mkdtempSync(join(tmpdir(), 'akorith-research-artifacts-'))
  mkdirSync(root, { recursive: true })
  let generated = 0
  const originalFetch = globalThis.fetch

  try {
    verifyPdfFontResolution(root)
    verifyVisualEvidenceModel()
    verifyDisplayLedgerDeduplication()
    verifyCompleteDocumentLedger()
    verifyUnicodeSafeTextCompaction()
    verifyMarkdownAnchorUniqueness()
    globalThis.fetch = async () => {
      throw new Error('Research exporters must not perform network requests.')
    }
    for (const fixture of RESEARCH_CORE_FIXTURE_MATRIX) {
      const workspace = join(root, fixture.id)
      mkdirSync(join(workspace, 'artifacts'), { recursive: true })
      const document = createDeterministicResearchDocument(fixture)
      verifyVisualProvenance(document)
      const cover = createResearchCoverSvg(document)
      verifyCoverLayout(document)
      assert.match(cover, /width="794" height="1123"/, `${fixture.id} must retain an A4 portrait library cover`)
      assert.match(cover, /AKORITH RESEARCH/, `${fixture.id} cover must identify the Research library`)
      assert.match(cover, new RegExp(escapeRegExp(fixture.model)), `${fixture.id} cover must identify its model`)

      const path = await exportFixture(fixture.outputFormat, workspace, document)
      assert.equal(extname(path), `.${fixture.outputFormat}`, `${fixture.id} extension must match its selected format`)
      const validation = await validateResearchArtifact(fixture.outputFormat, path)
      assert.equal(validation.ok, true, `${fixture.id}: ${validation.error ?? 'artifact validation failed'}`)
      assert.ok(validation.byteSize > 100, `${fixture.id} must produce a non-empty report`)
      assert.match(validation.checksum, /^[a-f0-9]{64}$/, `${fixture.id} must have a SHA-256 integrity digest`)
      await verifyContainer(fixture.outputFormat, path, document)
      generated += 1
    }
    generated += await verifyLayoutStressArtifacts(root)
    await verifyPdfUnicodeRoundTrip(root)
    await verifyPptxUnicodeRoundTrip(root)
  } finally {
    globalThis.fetch = originalFetch
    if (!retainedRoot) rmSync(root, { recursive: true, force: true })
  }

  assert.equal(generated, EXPECTED_RESEARCH_FIXTURE_COUNT + TEST_RESEARCH_OUTPUTS.length)
  console.log(`research artifact verifier passed (${generated} offline reports across five formats)${retainedRoot ? `; retained at ${root}` : ''}`)
}

function verifyCoverLayout(document: ResearchDocument): void {
  const layout = layoutResearchCover(document)
  assert.ok(layout.titleTop + layout.title.height + 24 <= layout.subtitleTop, 'cover title and subtitle need a safe gap')
  assert.ok(layout.subtitleTop + layout.subtitle.height <= 875, 'cover subtitle must stay above metadata')
}

function verifyDisplayLedgerDeduplication(): void {
  const fixture = RESEARCH_CORE_FIXTURE_MATRIX[0]
  const document = createDeterministicResearchDocument(fixture)
  const claim = document.sections[0].claims[0]
  const claims = rankAndDeduplicateResearchClaims([
    { ...claim, id: `${claim.id}-low`, status: 'unverified', confidenceScore: 0.4, evidence: [] },
    { ...claim, id: `${claim.id}-best`, status: 'verified', confidenceScore: 0.96 },
    { ...claim, id: `${claim.id}-near`, text: `According to research, ${claim.text}`, confidenceScore: 0.9 }
  ])
  assert.equal(claims.length, 2, 'only exactly equivalent cycle claims may collapse in the display ledger')
  const strongest = claims.find((item) => item.id === `${claim.id}-best`)
  assert.ok(strongest, 'the strongest exact duplicate claim must win')
  assert.ok(strongest.evidence.length > 0, 'deduplication must retain evidence')
  assert.ok(
    claims.some((item) => item.id === `${claim.id}-near`),
    'attribution wording must not cause a distinct claim to be merged'
  )

  const unicodeClaims = rankAndDeduplicateResearchClaims([
    { ...claim, id: 'unicode-japanese', text: '東京の結果は改善した。', evidence: [] },
    { ...claim, id: 'unicode-arabic', text: 'تحسنت النتائج في طوكيو.', evidence: [] },
    { ...claim, id: 'unicode-japanese-copy', text: '  東京の結果は改善した。  ', confidenceScore: 0.99 },
    { ...claim, id: 'empty-one', text: '', evidence: [] },
    { ...claim, id: 'empty-two', text: '   ', evidence: [] }
  ])
  assert.equal(unicodeClaims.length, 4, 'non-Latin and empty claims must retain distinct identities')
  assert.equal(
    unicodeClaims.filter((item) => item.id.startsWith('unicode-japanese')).length,
    1,
    'an exact non-Latin duplicate may be merged safely'
  )

  const conflicted = rankAndDeduplicateResearchClaims([
    { ...claim, id: 'conflict-supported', status: 'verified' },
    {
      ...claim,
      id: 'conflict-opposed',
      status: 'conflicted',
      evidence: [{ ...claim.evidence[0], relation: 'contradicts' }]
    }
  ])
  assert.equal(conflicted.length, 1)
  assert.equal(conflicted[0].status, 'conflicted', 'exact duplicate merging must preserve a conflict state')
  assert.ok(conflicted[0].evidence.some((item) => item.relation === 'contradicts'))

  const source = document.sources[0]
  const deduplicated = deduplicateResearchSources([
    source,
    { ...source, id: `${source.id}-tracking`, url: `${source.url}?utm_source=cycle` }
  ])
  assert.equal(deduplicated.sources.length, 1, 'tracking variants of one source must collapse')
  assert.equal(deduplicated.redirects.get(`${source.id}-tracking`), source.id)

  const caseSensitiveSources = deduplicateResearchSources([
    {
      ...source,
      id: 'case-preserved',
      url: 'HTTPS://Example.COM/Reports/Q2?Token=AbC&utm_source=cycle'
    },
    {
      ...source,
      id: 'case-preserved-tracking-copy',
      url: 'https://example.com/Reports/Q2?Token=AbC&UTM_MEDIUM=agent'
    },
    {
      ...source,
      id: 'different-path-case',
      url: 'https://example.com/reports/q2?Token=AbC'
    },
    {
      ...source,
      id: 'different-query-case',
      url: 'https://example.com/Reports/Q2?Token=abc'
    }
  ])
  assert.equal(
    caseSensitiveSources.sources.length,
    3,
    'source canonicalization must preserve case-sensitive path and query values'
  )
}

function verifyCompleteDocumentLedger(): void {
  const fixture = RESEARCH_CORE_FIXTURE_MATRIX[0]
  const base = createDeterministicResearchDocument(fixture)
  const template = base.sections[0].claims[0]
  const claims = [
    ...Array.from({ length: 16 }, (_, index) => ({
      ...template,
      id: `complete-ledger-${index + 1}`,
      text: `Distinct finding ${index + 1}.`,
      sectionId: 'measured-findings'
    })),
    { ...template, id: 'complete-ledger-unassigned', text: 'An unassigned finding.', sectionId: 'provider-only-section' }
  ]
  const job: ResearchJob = {
    id: fixture.id,
    title: base.title,
    prompt: base.subtitle,
    status: 'completed',
    phase: 'export',
    providerId: fixture.providerId,
    model: fixture.model,
    depth: fixture.depth,
    outputFormat: fixture.outputFormat,
    targetDurationMs: 0,
    maxCycles: 1,
    sourceTarget: base.sources.length,
    cycleCount: 1,
    sourceCount: base.sources.length,
    findingCount: claims.length,
    workspaceDir: '.',
    summary: base.executiveSummary,
    createdAt: DETERMINISTIC_RESEARCH_NOW,
    updatedAt: DETERMINISTIC_RESEARCH_NOW,
    activeElapsedMs: 0,
    revision: 1
  }
  const document = buildResearchDocument({
    job,
    plan: {
      title: base.title,
      thesis: base.subtitle,
      deliverable: 'Research report',
      sections: [{
        id: 'measured-findings',
        title: 'Measured findings',
        objective: 'Record all findings.',
        queries: [],
        status: 'complete'
      }],
      sourceStrategy: [],
      verificationCriteria: []
    },
    reportMarkdown: '## Measured findings\n\nAll findings are listed below.',
    claims,
    sources: base.sources
  })
  assert.equal(
    document.sections.flatMap((section) => section.claims).length,
    claims.length,
    'document construction must expose every distinct claim without a per-section cap'
  )
  assert.ok(
    document.sections.some((section) => section.claims.some((claim) => claim.id === 'complete-ledger-unassigned')),
    'claims with an unknown provider section must remain visible'
  )
}

function verifyUnicodeSafeTextCompaction(): void {
  const compacted = compactArtifactText('A😀B😀C', 4)
  assert.equal(compacted, 'A😀B…')
  assert.equal(hasLoneSurrogate(compacted), false, 'compact text must not split a surrogate pair')

  const fitted = fitArtifactText('😀😀😀😀😀', {
    width: 12,
    maxHeight: 10,
    maxFontSize: 10,
    minFontSize: 10,
    maxLines: 1
  })
  assert.equal(fitted.truncated, true)
  assert.equal(hasLoneSurrogate(fitted.text), false, 'fitted text ellipsis must not split a surrogate pair')
}

function verifyMarkdownAnchorUniqueness(): void {
  const fixture = RESEARCH_CORE_FIXTURE_MATRIX[0]
  const base = createDeterministicResearchDocument(fixture)
  const document: ResearchDocument = {
    ...base,
    sections: [
      { id: 'reserved-summary', title: 'Executive summary', body: 'One.', claims: [] },
      { id: 'reserved-summary-copy', title: 'Executive summary', body: 'Two.', claims: [] },
      { id: 'suffix-collision', title: 'Executive summary 2', body: 'Three.', claims: [] },
      { id: 'reserved-sources', title: 'Sources', body: 'Four.', claims: [] },
      { id: 'reserved-source-entry', title: 'Source 1', body: 'Five.', claims: [] },
      { id: 'unicode-anchor', title: '研究 sonuçları', body: 'Six.', claims: [] }
    ]
  }
  const markdown = renderResearchMarkdown(document)
  const anchors = [...markdown.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1])
  assert.equal(new Set(anchors).size, anchors.length, 'Markdown explicit anchors must be globally unique')
  for (const target of markdown.matchAll(/\]\(#([^)]+)\)/g)) {
    assert.ok(anchors.includes(target[1]), `Markdown table-of-contents target must exist: ${target[1]}`)
  }
  assert.ok(anchors.some((anchor) => anchor.includes('研究')), 'non-Latin section anchors must retain their identity')
}

function hasLoneSurrogate(value: string): boolean {
  return Array.from(value).some((character) => {
    if (character.length !== 1) return false
    const code = character.charCodeAt(0)
    return code >= 0xD800 && code <= 0xDFFF
  })
}

async function verifyLayoutStressArtifacts(root: string): Promise<number> {
  const document = createLayoutStressResearchDocument()
  verifyCoverLayout(document)
  let generated = 0
  for (const format of TEST_RESEARCH_OUTPUTS) {
    const workspace = join(root, 'layout-stress', format)
    mkdirSync(join(workspace, 'artifacts'), { recursive: true })
    const path = await exportFixture(format, workspace, document)
    const validation = await validateResearchArtifact(format, path)
    assert.equal(validation.ok, true, `layout stress ${format}: ${validation.error ?? 'artifact validation failed'}`)
    await verifyContainer(format, path, document)
    generated += 1
  }
  return generated
}

function verifyVisualEvidenceModel(): void {
  const fixture = RESEARCH_CORE_FIXTURE_MATRIX[0]
  const document = createDeterministicResearchDocument(fixture)
  const baseClaim = document.sections.flatMap((section) => section.claims)[0]
  const primary = {
    ...baseClaim,
    text: 'The evaluated model reaches a reproducible quality score of 82 points.'
  }
  const comparison = {
    ...baseClaim,
    id: `${baseClaim.id}-comparison`,
    text: 'The comparison model reaches a reproducible quality score of 74 points.',
    evidence: [{ sourceId: document.sources[1].id, relation: 'supports' as const, evidence: 'Comparison score table.' }]
  }
  const visuals = buildResearchVisualEvidence({
    claims: [primary, comparison],
    sources: document.sources,
    generatedAt: document.generatedAt
  })
  assert.equal(visuals[0].kind, 'quantitative-chart', 'compatible cited measurements should create a chart')
  assert.equal(visuals[0].points?.length, 2)
  assert.equal(visuals.filter((visual) => visual.kind === 'web-snapshot').length, 2)

  const maliciousSvg = renderResearchVisualSvg({
    ...visuals[0],
    title: '<script>alert(1)</script>',
    caption: 'Evidence & provenance'
  })
  assert.doesNotMatch(maliciousSvg, /<script>/, 'visual SVG must escape untrusted research text')
  assert.match(maliciousSvg, /&lt;script&gt;/)
  assert.match(maliciousSvg, /role="img"/, 'visual SVG must expose accessible image semantics')
}

function verifyVisualProvenance(document: ResearchDocument): void {
  assert.ok(document.visuals.length >= 3, 'each report should include a chart, evidence table, and source snapshot')
  const sourcesById = new Map(document.sources.map((source) => [source.id, source]))
  for (const visual of document.visuals) {
    assert.equal(visual.provenance.generatedAt, document.generatedAt)
    assert.ok(visual.provenance.sourceIds.length > 0, `${visual.id} must retain cited provenance`)
    visual.provenance.sourceIds.forEach((sourceId, index) => {
      const source = sourcesById.get(sourceId)
      assert.ok(source, `${visual.id} must reference a source in the canonical ledger`)
      assert.equal(visual.provenance.sourceUrls[index], source.url)
    })
  }
}

function verifyPdfFontResolution(root: string): void {
  const dependencyFonts = resolveResearchPdfFontPaths()
  assert.equal(existsSync(dependencyFonts.regular), true, 'development Unicode PDF font must resolve')
  assert.equal(existsSync(dependencyFonts.bold), true, 'development bold Unicode PDF font must resolve')

  const packagedResources = join(root, 'packaged-resources')
  const packagedFontsDir = join(packagedResources, 'research-fonts')
  mkdirSync(packagedFontsDir, { recursive: true })
  copyFileSync(dependencyFonts.regular, join(packagedFontsDir, 'DejaVuSans.ttf'))
  copyFileSync(dependencyFonts.bold, join(packagedFontsDir, 'DejaVuSans-Bold.ttf'))
  const packagedFonts = resolveResearchPdfFontPaths(packagedResources)
  assert.equal(packagedFonts.regular, join(packagedFontsDir, 'DejaVuSans.ttf'))
  assert.equal(packagedFonts.bold, join(packagedFontsDir, 'DejaVuSans-Bold.ttf'))

  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    build?: { extraResources?: Array<{ from?: string; to?: string }> }
  }
  const packagedTargets = new Set((manifest.build?.extraResources ?? []).map((item) => item.to))
  assert.equal(packagedTargets.has('research-fonts/DejaVuSans.ttf'), true)
  assert.equal(packagedTargets.has('research-fonts/DejaVuSans-Bold.ttf'), true)
  assert.equal(packagedTargets.has('research-fonts/LICENSE'), true, 'packaged font license must be retained')
}

async function verifyPdfUnicodeRoundTrip(root: string): Promise<void> {
  const fixture = RESEARCH_CORE_FIXTURE_MATRIX.find((item) => item.outputFormat === 'pdf')!
  const workspace = join(root, 'research-pdf-unicode-round-trip')
  mkdirSync(join(workspace, 'artifacts'), { recursive: true })
  const base = createDeterministicResearchDocument(fixture)
  const multilingualText = [
    'Türkçe: İnci Aral, Oğuz Atay, Hasan Ali Toptaş, Perihan Mağden, İhsan Oktay Anar, Nâzım Hikmet, Yaşar Kemal.',
    'Français: élève et cœur. Polski: Łódź. Tiếng Việt: Nguyễn. Ελληνικά: Αθήνα. Кириллица: Москва. اردو: اردو. עברית: עברית.'
  ].join(' ')
  const document: ResearchDocument = {
    ...base,
    title: 'Çok dilli araştırma · İnci, Oğuz ve Nâzım',
    subtitle: multilingualText,
    executiveSummary: multilingualText,
    sections: base.sections.map((section, index) =>
      index === 0 ? { ...section, title: 'Ölçülen bulgular', body: multilingualText } : section
    )
  }

  const path = await exportResearchPdf(workspace, document)
  const bytes = readFileSync(path)
  const pdfStructure = bytes.toString('latin1')
  assert.match(pdfStructure, /DejaVuSans/, 'Research PDF must embed its Unicode font')
  assert.doesNotMatch(
    pdfStructure,
    /\/BaseFont\s*\/(?:Helvetica|Courier)/,
    'Research PDF must never fall back to a WinAnsi built-in font'
  )
  const parsed = await pdfParse(bytes)
  const extracted = parsed.text.replace(/\s+/g, ' ')
  for (const expected of [
    'İnci',
    'Oğuz',
    'Toptaş',
    'Mağden',
    'İhsan',
    'Nâzım',
    'Yaşar',
    'Français',
    'Łódź',
    'Nguyễn',
    'Αθήνα',
    'Москва',
    'اردو',
    'עברית'
  ]) {
    assert.ok(extracted.includes(expected), `Research PDF must preserve multilingual text: ${expected}`)
  }
}

async function verifyPptxUnicodeRoundTrip(root: string): Promise<void> {
  const fixture = RESEARCH_CORE_FIXTURE_MATRIX.find((item) => item.outputFormat === 'pptx')!
  const workspace = join(root, 'research-pptx-unicode-round-trip')
  mkdirSync(join(workspace, 'artifacts'), { recursive: true })
  const base = createDeterministicResearchDocument(fixture)
  const multilingualText = [
    'Türkçe: İnci Aral, Oğuz Atay, Hasan Ali Toptaş, Perihan Mağden, İhsan Oktay Anar, Nâzım Hikmet, Yaşar Kemal.',
    'Français: élève et cœur. Polski: Łódź. Tiếng Việt: Nguyễn. Ελληνικά: Αθήνα. Кириллица: Москва. اردو: اردو. עברית: עברית.'
  ].join(' ')
  const document: ResearchDocument = {
    ...base,
    title: 'Çok dilli araştırma · İnci, Oğuz ve Nâzım',
    subtitle: multilingualText,
    executiveSummary: multilingualText,
    sections: base.sections.map((section, index) =>
      index === 0 ? { ...section, title: 'Ölçülen bulgular', body: multilingualText } : section
    )
  }

  const path = await exportResearchPptx(workspace, document)
  const zip = await JSZip.loadAsync(readFileSync(path))
  const presentationXml = await zip.file('ppt/presentation.xml')!.async('text')
  const slideCount = [...presentationXml.matchAll(/<p:sldId\b/g)].length
  const slides = await Promise.all(Array.from({ length: slideCount }, (_, index) =>
    zip.file(`ppt/slides/slide${index + 1}.xml`)!.async('text')
  ))
  const joined = slides.join('\n')
  for (const expected of [
    'İnci',
    'Oğuz',
    'Toptaş',
    'Mağden',
    'İhsan',
    'Nâzım',
    'Yaşar',
    'Français',
    'Łódź',
    'Nguyễn',
    'Αθήνα',
    'Москва',
    'اردو',
    'עברית'
  ]) {
    assert.ok(joined.includes(expected), `Research PPTX must preserve multilingual text: ${expected}`)
  }
  assert.match(presentationXml, /<a:defRPr lang="tr-TR"/, 'Research PPTX must infer a document-level language tag')
  assert.doesNotMatch(joined, /lang="tr-TR"/, 'Research PPTX runs must inherit language instead of hardcoding Turkish')
  const coreXml = await zip.file('docProps/core.xml')!.async('text')
  assert.match(coreXml, /<dc:language>tr-TR<\/dc:language>/, 'Research PPTX core metadata must expose its inferred language')
}

async function exportFixture(
  format: ResearchOutputFormat,
  workspace: string,
  document: ResearchDocument
): Promise<string> {
  if (format === 'md') return exportResearchMarkdown(workspace, document)
  if (format === 'pdf') return exportResearchPdf(workspace, document)
  if (format === 'docx') return exportResearchDocx(workspace, document)
  if (format === 'xlsx') return exportResearchXlsx(workspace, document)
  return exportResearchPptx(workspace, document)
}

async function verifyContainer(
  format: ResearchOutputFormat,
  path: string,
  document: ResearchDocument
): Promise<void> {
  const bytes = readFileSync(path)
  if (format === 'pdf') {
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-', 'PDF must use the PDF file signature')
    assert.match(bytes.toString('latin1'), /\/Type\s*\/Page\b/, 'PDF must contain at least one page object')
    const parsed = await pdfParse(bytes)
    const text = parsed.text.replace(/\s+/g, ' ')
    assert.match(text, /Visual evidence/, 'PDF must include the visual-evidence section')
    assert.match(text, /RETRIEVED TEXT SNAPSHOT/, 'PDF must label sanitized source snapshots honestly')
    return
  }
  if (format === 'md') {
    const markdown = bytes.toString('utf8')
    assert.match(markdown, new RegExp(`^# ${escapeRegExp(document.title)}$`, 'm'))
    assert.match(markdown, /^## Executive summary$/m)
    assert.match(markdown, /^## Visual evidence$/m)
    assert.match(markdown, /^## Sources$/m)
    const anchors = [...markdown.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1])
    assert.equal(new Set(anchors).size, anchors.length, 'Markdown must not emit duplicate explicit anchors')
    const assetDirectory = join(dirname(path), `${basename(path, extname(path))}-assets`)
    for (const visual of document.visuals) {
      const svgPath = join(assetDirectory, `${visual.id}.svg`)
      assert.equal(existsSync(svgPath), true, `Markdown must emit visual asset ${visual.id}`)
      assert.match(markdown, new RegExp(`${escapeRegExp(visual.id)}\\.svg`))
      const svg = readFileSync(svgPath, 'utf8')
      assert.match(svg, /role="img"/)
      assert.match(svg, /Provenance:/)
    }
    return
  }

  const zip = await JSZip.loadAsync(bytes)
  if (format === 'docx') {
    assert.ok(zip.file('[Content_Types].xml'), 'DOCX must contain the package content-types manifest')
    const documentXml = await zip.file('word/document.xml')?.async('text')
    assert.ok(documentXml, 'DOCX must contain its Word document body')
    assert.match(documentXml, /Visual evidence/, 'DOCX must include native visual evidence')
    assert.match(documentXml, /Web evidence snapshot/, 'DOCX must include source snapshot cards')
    return
  }
  if (format === 'pptx') {
    assert.ok(zip.file('ppt/presentation.xml'), 'PPTX must contain its presentation manifest')
    assert.ok(zip.file('ppt/slideMasters/slideMaster1.xml'), 'PPTX must contain its editable slide master')
    assert.ok(zip.file('ppt/theme/theme1.xml'), 'PPTX must contain its Akorith theme')
    const presentationXml = await zip.file('ppt/presentation.xml')!.async('text')
    const slideCount = [...presentationXml.matchAll(/<p:sldId\b/g)].length
    assert.ok(slideCount >= 8, 'PPTX must deliver a complete narrative deck')
    const slideXml = await Promise.all(Array.from({ length: slideCount }, (_, index) =>
      zip.file(`ppt/slides/slide${index + 1}.xml`)!.async('text')
    ))
    const joined = slideXml.join('\n')
    const deckTitleSize = Number(/name="Presentation title"[\s\S]*?<a:rPr\b[^>]*sz="(\d+)"/.exec(slideXml[0])?.[1] ?? 0)
    assert.ok(deckTitleSize >= 4_200, 'PPTX deck titles must stay at 42pt or larger')
    assert.match(joined, /name="Slide title"[\s\S]*?sz="3200"/, 'PPTX slide titles must stay at 32pt or larger')
    assert.match(joined, /<a:tbl>[\s\S]*?<a:rPr\b[^>]*sz="1600"/, 'PPTX native table body text must stay at 16pt or larger')
    assert.doesNotMatch(joined, /<a:spAutoFit\s*\/>/, 'PPTX must not delegate layout to viewer-specific auto-fit')
    assert.match(joined, /Executive takeaway/, 'PPTX must lead with an executive takeaway')
    assert.match(joined, /Methodology &amp; limits/, 'PPTX must explain methodology and limitations')
    assert.match(joined, /What the evidence supports/, 'PPTX must close with a supported conclusion')
    assert.match(joined, /Sources/, 'PPTX must retain its source appendix')
    assert.match(joined, /<a:tbl>/, 'PPTX evidence tables must remain native and editable')
    assert.match(joined, /Türkçe|Research fixture|longitudinal/, 'PPTX must retain readable Unicode XML text')
    if (document.methodology.length > 4) {
      assert.match(joined, /Method 5:/, 'PPTX must paginate methodology beyond the fourth item')
      assert.match(joined, /Method 6:/, 'PPTX must retain the final methodology item')
    }
    if (document.verificationCriteria.length > 4) {
      assert.match(joined, /Verification criterion 5:/, 'PPTX must paginate verification criteria beyond the fourth item')
      assert.match(joined, /Verification criterion 6:/, 'PPTX must retain the final verification criterion')
    }
    for (const visual of document.visuals) {
      if ((visual.points?.length ?? 0) > 6) {
        assert.match(joined, new RegExp(`Data points 7-${visual.points!.length} of ${visual.points!.length}`))
      }
      if ((visual.rows?.length ?? 0) > 6) {
        assert.match(joined, new RegExp(`Evidence rows 7-${visual.rows!.length} of ${visual.rows!.length}`))
      }
    }
    return
  }
  assert.ok(zip.file('xl/workbook.xml'), 'XLSX must contain a workbook manifest')
  assert.ok(zip.file('xl/worksheets/sheet1.xml'), 'XLSX must contain its overview worksheet')
  const workbookXml = await zip.file('xl/workbook.xml')!.async('text')
  assert.match(workbookXml, /name="Visual Evidence"/, 'XLSX must expose the Visual Evidence sheet')
  for (const sheetNumber of [1, 2, 3, 4, 5]) {
    const xml = await zip.file(`xl/worksheets/sheet${sheetNumber}.xml`)?.async('text')
    assert.ok(xml, `XLSX must contain worksheet ${sheetNumber}`)
    assert.match(xml, /<pageSetup\b[^>]*fitToWidth="1"/, `worksheet ${sheetNumber} must fit to one printed page wide`)
  }
  const findingsXml = await zip.file('xl/worksheets/sheet2.xml')!.async('text')
  const sourcesXml = await zip.file('xl/worksheets/sheet3.xml')!.async('text')
  const visualXml = await zip.file('xl/worksheets/sheet5.xml')!.async('text')
  assert.match(findingsXml, /<pageSetup\b[^>]*orientation="landscape"/, 'Findings must print in landscape orientation')
  assert.match(sourcesXml, /<pageSetup\b[^>]*orientation="landscape"/, 'Sources must print in landscape orientation')
  assert.match(visualXml, /<pageSetup\b[^>]*orientation="landscape"/, 'Visual Evidence must print in landscape orientation')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Uint8Array.from(readFileSync(path)).buffer)
  for (const worksheet of workbook.worksheets) {
    assert.equal(
      worksheet.headerFooter.oddFooter,
      '&LAkorith Research&RPage &P of &N',
      `${worksheet.name} must use a non-overlapping print footer`
    )
  }
  const findings = workbook.getWorksheet('Findings')!
  const findingsText = findings.getColumn(2).values
    .slice(2)
    .map((value) => String(value ?? '').replace(/\s+/g, ' ').trim())
    .join(' ')
  for (const section of document.sections) {
    const narrative = section.body.replace(/\s+/g, ' ').trim()
    assert.ok(findingsText.includes(narrative), `XLSX must retain the complete narrative for ${section.title}`)
  }
  const sourceLinks = new Set<string>()
  workbook.getWorksheet('Sources')!.getColumn(4).eachCell((cell, rowNumber) => {
    if (rowNumber === 1 || typeof cell.value !== 'object' || cell.value == null) return
    if ('hyperlink' in cell.value && typeof cell.value.hyperlink === 'string') sourceLinks.add(cell.value.hyperlink)
  })
  for (const source of document.sources) {
    assert.ok(sourceLinks.has(source.url), `XLSX must retain a clickable source link for ${source.title}`)
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

void main()
