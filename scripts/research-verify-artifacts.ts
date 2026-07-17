import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import JSZip from 'jszip'
import {
  EXPECTED_RESEARCH_FIXTURE_COUNT,
  RESEARCH_CORE_FIXTURE_MATRIX,
  TEST_RESEARCH_DEPTHS,
  TEST_RESEARCH_OUTPUTS,
  TEST_RESEARCH_PROVIDERS,
  createDeterministicResearchDocument
} from '../src/main/research/__tests__/fixture-matrix.ts'
import { createResearchCoverSvg } from '../src/main/research/cover.ts'
import { exportResearchDocx } from '../src/main/research/exporters/docx.ts'
import { exportResearchMarkdown } from '../src/main/research/exporters/markdown.ts'
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
import type { ResearchOutputFormat } from '../src/main/research/types.ts'

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
  const root = mkdtempSync(join(tmpdir(), 'akorith-research-artifacts-'))
  let generated = 0
  const originalFetch = globalThis.fetch

  try {
    verifyPdfFontResolution(root)
    verifyVisualEvidenceModel()
    globalThis.fetch = async () => {
      throw new Error('Research exporters must not perform network requests.')
    }
    for (const fixture of RESEARCH_CORE_FIXTURE_MATRIX) {
      const workspace = join(root, fixture.id)
      mkdirSync(join(workspace, 'artifacts'), { recursive: true })
      const document = createDeterministicResearchDocument(fixture)
      verifyVisualProvenance(document)
      const cover = createResearchCoverSvg(document)
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
    await verifyPdfUnicodeRoundTrip(root)
    await verifyPptxUnicodeRoundTrip(root)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }

  assert.equal(generated, EXPECTED_RESEARCH_FIXTURE_COUNT)
  console.log(`research artifact verifier passed (${generated} offline reports across five formats)`)
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
  assert.match(joined, /lang="tr-TR"/, 'Research PPTX text runs must retain a Unicode-aware language tag')
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
    assert.match(slideXml[0], /name="Presentation title"[\s\S]*?sz="5000"/, 'PPTX deck titles must stay at 50pt or larger')
    assert.match(joined, /name="Slide title"[\s\S]*?sz="3500"/, 'PPTX slide titles must stay at 35pt or larger')
    assert.match(joined, /<a:tbl>[\s\S]*?<a:rPr\b[^>]*sz="1600"/, 'PPTX native table body text must stay at 16pt or larger')
    assert.match(joined, /Executive takeaway/, 'PPTX must lead with an executive takeaway')
    assert.match(joined, /Methodology &amp; limits/, 'PPTX must explain methodology and limitations')
    assert.match(joined, /What the evidence supports/, 'PPTX must close with a supported conclusion')
    assert.match(joined, /Sources/, 'PPTX must retain its source appendix')
    assert.match(joined, /<a:tbl>/, 'PPTX evidence tables must remain native and editable')
    assert.match(joined, /Türkçe|Research fixture/, 'PPTX must retain readable Unicode XML text')
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
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

void main()
