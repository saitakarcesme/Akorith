import { renameSync, writeFileSync } from 'fs'
import JSZip from 'jszip'
import type { ResearchDocument } from '../document'
import type { ResearchVisualEvidence } from '../visual-evidence'
import { researchArtifactPath } from '../workspace'

const SLIDE_WIDTH = 12_192_000
const SLIDE_HEIGHT = 6_858_000
const INCH = 914_400
const COLORS = {
  canvas: '121513',
  surface: '1B1F1D',
  surfaceAlt: '202522',
  border: '343A36',
  text: 'F5F7F5',
  muted: 'A2AAA5',
  dim: '717A74',
  mint: '6FD1A4',
  mintDark: '244B3A',
  violet: 'A985F8',
  warning: 'E3B65C'
} as const

interface TextLine {
  text: string
  size?: number
  color?: string
  bold?: boolean
  bullet?: boolean
  align?: 'l' | 'ctr' | 'r'
  before?: number
  after?: number
}

interface SlideBuild {
  title: string
  body: string[]
}

/**
 * Creates an editable, Unicode-safe Open XML presentation without relying on
 * a headless office installation. Every visible element is a native PowerPoint
 * text box, shape, table, or chart-like bar, so recipients can restyle it.
 */
export async function exportResearchPptx(
  workspaceDir: string,
  research: ResearchDocument,
  outputPath?: string
): Promise<string> {
  const path = outputPath ?? researchArtifactPath(workspaceDir, research.title, 'pptx')
  const partial = `${path}.partial`
  const slides = buildSlides(research)
  const zip = new JSZip()

  zip.file('[Content_Types].xml', contentTypesXml(slides.length))
  zip.folder('_rels')!.file('.rels', rootRelationshipsXml())
  zip.folder('docProps')!.file('core.xml', corePropertiesXml(research))
  zip.folder('docProps')!.file('app.xml', appPropertiesXml(slides))
  zip.folder('ppt')!.file('presentation.xml', presentationXml(slides.length))
  zip.folder('ppt')!.file('presProps.xml', presentationPropertiesXml())
  zip.folder('ppt')!.file('viewProps.xml', viewPropertiesXml())
  zip.folder('ppt')!.file('tableStyles.xml', tableStylesXml())
  zip.folder('ppt/_rels')!.file('presentation.xml.rels', presentationRelationshipsXml(slides.length))
  zip.folder('ppt/theme')!.file('theme1.xml', themeXml())
  zip.folder('ppt/slideMasters')!.file('slideMaster1.xml', slideMasterXml())
  zip.folder('ppt/slideMasters/_rels')!.file('slideMaster1.xml.rels', slideMasterRelationshipsXml())
  zip.folder('ppt/slideLayouts')!.file('slideLayout1.xml', slideLayoutXml())
  zip.folder('ppt/slideLayouts/_rels')!.file('slideLayout1.xml.rels', slideLayoutRelationshipsXml())

  slides.forEach((slide, index) => {
    zip.folder('ppt/slides')!.file(`slide${index + 1}.xml`, slideXml(slide.body))
    zip.folder('ppt/slides/_rels')!.file(`slide${index + 1}.xml.rels`, slideRelationshipsXml())
  })

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX'
  })
  writeFileSync(partial, buffer)
  renameSync(partial, path)
  return path
}

function buildSlides(research: ResearchDocument): SlideBuild[] {
  const slides: SlideBuild[] = []
  let page = 1
  const push = (title: string, body: string[]): void => {
    slides.push({ title, body: [...body, ...footer(page++, research)] })
  }

  push(research.title, titleSlide(research))
  push('Executive takeaway', executiveSlide(research))

  const sections = research.sections.slice(0, 6)
  for (const [index, section] of sections.entries()) {
    push(section.title, findingSlide(section.title, section.body, section.claims.map((claim) => claim.text), index + 1))
  }

  for (const visual of research.visuals.slice(0, 5)) {
    if ((visual.kind === 'quantitative-chart' || visual.kind === 'source-quality-chart') && (visual.points?.length ?? 0) > 0) {
      push(visual.title, chartSlide(visual))
    } else if (visual.kind === 'evidence-table' && (visual.rows?.length ?? 0) > 0) {
      push(visual.title, tableSlide(visual))
    } else if (visual.kind === 'web-snapshot' && visual.snapshot) {
      push(visual.title, snapshotSlide(visual))
    }
  }

  push('Methodology & limits', methodologySlide(research))
  push('What the evidence supports', conclusionSlide(research))

  const sourcePages = chunk(research.sources, 5)
  if (sourcePages.length === 0) sourcePages.push([])
  sourcePages.forEach((sources, index) => {
    push(index === 0 ? 'Sources' : `Sources · ${index + 1}`, sourcesSlide(sources, research.sources.length, index))
  })

  return slides
}

function titleSlide(research: ResearchDocument): string[] {
  const title = compact(research.title, 72)
  const subtitle = compact(research.subtitle, 230)
  return [
    rectShape(2, 'Accent rail', 0.72, 0.76, 0.11, 5.82, COLORS.mint, COLORS.mint),
    textShape(3, 'Akorith brand', 1.06, 0.78, 4.3, 0.34, [
      { text: 'AKORITH  /  RESEARCH', size: 13, color: COLORS.mint, bold: true }
    ], { tracking: 180 }),
    textShape(4, 'Presentation title', 1.06, 1.63, 10.9, 2.12, [
      { text: title, size: 50, color: COLORS.text, bold: true }
    ]),
    textShape(5, 'Presentation subtitle', 1.08, 4.03, 10.25, 1.2, [
      { text: subtitle, size: 20, color: COLORS.muted }
    ]),
    textShape(6, 'Presentation metadata', 1.08, 5.77, 10.0, 0.42, [
      {
        text: `${research.depthLabel.toUpperCase()}  ·  ${compact(research.modelLabel, 42)}  ·  ${research.sources.length} sources  ·  ${formatDate(research.generatedAt)}`,
        size: 14,
        color: COLORS.dim
      }
    ])
  ]
}

function executiveSlide(research: ResearchDocument): string[] {
  return [
    ...slideHeader('01', 'Executive takeaway', 'The shortest useful version of the research result.'),
    roundedRectShape(10, 'Takeaway surface', 0.78, 2.0, 8.7, 3.95, COLORS.surface, COLORS.border, 0.9),
    textShape(11, 'Takeaway', 1.18, 2.42, 7.85, 2.92, [
      { text: compact(research.executiveSummary, 620), size: 26, color: COLORS.text, bold: true }
    ]),
    textShape(12, 'Evidence label', 9.92, 2.08, 2.3, 0.28, [
      { text: 'EVIDENCE BASE', size: 12, color: COLORS.mint, bold: true }
    ], { tracking: 130 }),
    textShape(13, 'Evidence metrics', 9.92, 2.58, 2.6, 2.4, [
      { text: `${research.sources.length}`, size: 38, color: COLORS.text, bold: true, after: 0 },
      { text: 'sources collected', size: 16, color: COLORS.muted, after: 16 },
      { text: `${research.sections.length}`, size: 38, color: COLORS.text, bold: true, after: 0 },
      { text: 'finding sections', size: 16, color: COLORS.muted }
    ])
  ]
}

function findingSlide(title: string, body: string, claims: string[], index: number): string[] {
  const paragraphs = proseParagraphs(body, 3)
  const evidence = claims.slice(0, 3)
  const bodyLines: TextLine[] = paragraphs.map((paragraph) => ({
    text: paragraph,
    size: 19,
    color: COLORS.muted,
    after: 10
  }))
  const evidenceLines: TextLine[] = (evidence.length > 0 ? evidence : ['This section is synthesized from the cited source ledger.'])
    .map((claim) => ({ text: compact(claim, 225), size: 17, color: COLORS.text, bullet: true, after: 8 }))
  return [
    ...slideHeader(String(index + 1).padStart(2, '0'), compact(title, 72), 'Finding'),
    textShape(10, 'Finding narrative', 0.82, 2.02, 7.15, 3.9, bodyLines),
    roundedRectShape(11, 'Evidence surface', 8.35, 2.02, 4.18, 3.9, COLORS.surface, COLORS.border, 0.8),
    textShape(12, 'Evidence heading', 8.72, 2.36, 3.45, 0.38, [
      { text: 'EVIDENCE LEDGER', size: 12, color: COLORS.mint, bold: true }
    ], { tracking: 120 }),
    textShape(13, 'Evidence list', 8.67, 2.98, 3.44, 2.5, evidenceLines)
  ]
}

function chartSlide(visual: ResearchVisualEvidence): string[] {
  const points = (visual.points ?? []).slice(0, 6)
  const max = Math.max(1, ...points.map((point) => Math.abs(point.value)))
  const shapes: string[] = [
    ...slideHeader('VIS', compact(visual.title, 72), compact(visual.caption, 120)),
    textShape(10, 'Chart note', 9.72, 1.23, 2.65, 0.58, [
      { text: 'Editable native bars', size: 13, color: COLORS.dim, align: 'r' }
    ])
  ]
  points.forEach((point, index) => {
    const y = 2.02 + index * 0.66
    const width = 5.9 * Math.max(0.025, Math.abs(point.value) / max)
    shapes.push(textShape(20 + index * 4, `Chart label ${index + 1}`, 0.85, y, 4.2, 0.46, [
      { text: compact(point.label, 54), size: 16, color: COLORS.muted }
    ]))
    shapes.push(roundedRectShape(21 + index * 4, `Chart track ${index + 1}`, 5.15, y + 0.04, 6.0, 0.30, COLORS.surfaceAlt, COLORS.surfaceAlt, 0.35))
    shapes.push(roundedRectShape(22 + index * 4, `Chart value ${index + 1}`, 5.15, y + 0.04, width, 0.30, index === 0 ? COLORS.mint : COLORS.violet, index === 0 ? COLORS.mint : COLORS.violet, 0.35))
    shapes.push(textShape(23 + index * 4, `Chart number ${index + 1}`, 11.3, y - 0.02, 1.15, 0.42, [
      { text: formatPoint(point.value, point.unit), size: 16, color: COLORS.text, bold: true, align: 'r' }
    ]))
  })
  return shapes
}

function tableSlide(visual: ResearchVisualEvidence): string[] {
  const columns = (visual.columns ?? ['Source', 'Publisher', 'Confidence', 'Status']).slice(0, 5)
  const rows = (visual.rows ?? []).slice(0, 6).map((row) => row.cells.slice(0, columns.length))
  return [
    ...slideHeader('VIS', compact(visual.title, 72), compact(visual.caption, 120)),
    nativeTable(10, 'Evidence table', 0.82, 2.02, 11.72, 3.92, columns, rows)
  ]
}

function snapshotSlide(visual: ResearchVisualEvidence): string[] {
  const snapshot = visual.snapshot!
  return [
    ...slideHeader('WEB', compact(visual.title, 72), 'Retrieved evidence · local, script-free snapshot'),
    roundedRectShape(10, 'Browser surface', 0.82, 1.96, 11.72, 3.96, COLORS.surface, COLORS.border, 0.9),
    circleShape(11, 'Browser status', 1.18, 2.27, 0.13, COLORS.mint),
    textShape(12, 'Source publisher', 1.52, 2.12, 7.2, 0.34, [
      { text: compact(snapshot.publisher, 70), size: 13, color: COLORS.mint, bold: true }
    ]),
    textShape(13, 'Source title', 1.18, 2.72, 10.55, 0.7, [
      { text: compact(snapshot.title, 110), size: 27, color: COLORS.text, bold: true }
    ]),
    textShape(14, 'Source excerpt', 1.18, 3.58, 10.35, 1.45, [
      { text: `“${compact(snapshot.excerpt, 430)}”`, size: 18, color: COLORS.muted }
    ]),
    textShape(15, 'Source URL', 1.18, 5.22, 10.4, 0.34, [
      { text: compact(snapshot.url, 130), size: 13, color: COLORS.dim }
    ])
  ]
}

function methodologySlide(research: ResearchDocument): string[] {
  const methods = (research.methodology.length > 0 ? research.methodology : [
    'Gather evidence from independent and primary sources.',
    'Keep every claim linked to an explicit source record.'
  ]).slice(0, 4)
  const checks = (research.verificationCriteria.length > 0 ? research.verificationCriteria : [
    'Cross-check material claims before publication.',
    'Expose unsupported or conflicting evidence.'
  ]).slice(0, 4)
  return [
    ...slideHeader('MTH', 'Methodology & limits', 'How Akorith assembled, checked, and bounded this result.'),
    roundedRectShape(10, 'Method surface', 0.82, 2.02, 5.65, 3.9, COLORS.surface, COLORS.border, 0.8),
    textShape(11, 'Method heading', 1.16, 2.35, 4.9, 0.42, [
      { text: 'SOURCE STRATEGY', size: 12, color: COLORS.mint, bold: true }
    ], { tracking: 120 }),
    textShape(12, 'Method list', 1.13, 2.98, 4.92, 2.5, methods.map((item) => ({
      text: compact(item, 165), size: 17, color: COLORS.text, bullet: true, after: 8
    }))),
    roundedRectShape(13, 'Checks surface', 6.82, 2.02, 5.72, 3.9, COLORS.surface, COLORS.border, 0.8),
    textShape(14, 'Checks heading', 7.18, 2.35, 4.9, 0.42, [
      { text: 'VERIFICATION CRITERIA', size: 12, color: COLORS.violet, bold: true }
    ], { tracking: 120 }),
    textShape(15, 'Checks list', 7.14, 2.98, 4.93, 2.5, checks.map((item) => ({
      text: compact(item, 165), size: 17, color: COLORS.text, bullet: true, after: 8
    })))
  ]
}

function conclusionSlide(research: ResearchDocument): string[] {
  const verified = research.sections
    .flatMap((section) => section.claims)
    .filter((claim) => claim.status === 'verified')
    .slice(0, 3)
  const takeaways = verified.length > 0
    ? verified.map((claim) => claim.text)
    : research.sections.slice(0, 3).map((section) => firstSentence(section.body))
  return [
    ...slideHeader('END', 'What the evidence supports', 'Conclusion and responsible next actions.'),
    textShape(10, 'Conclusion lead', 0.84, 2.0, 11.4, 1.62, [
      { text: compact(research.executiveSummary, 250), size: 25, color: COLORS.text, bold: true }
    ]),
    ...takeaways.slice(0, 3).flatMap((takeaway, index) => {
      const y = 4.0 + index * 0.68
      return [
        circleShape(20 + index * 3, `Conclusion marker ${index + 1}`, 0.91, y + 0.08, 0.18, index === 0 ? COLORS.mint : COLORS.violet),
        textShape(21 + index * 3, `Conclusion ${index + 1}`, 1.35, y, 10.35, 0.54, [
          { text: compact(takeaway, 150), size: 17, color: COLORS.muted }
        ])
      ]
    })
  ]
}

function sourcesSlide(
  sources: ResearchDocument['sources'],
  total: number,
  pageIndex: number
): string[] {
  const lines = sources.length > 0
    ? sources.flatMap((source, index) => [
      {
        text: `${pageIndex * 5 + index + 1}. ${compact(source.title, 104)}`,
        size: 17,
        color: COLORS.text,
        bold: true,
        after: 0
      },
      {
        text: `${compact(source.publisher || safeHostname(source.url), 54)}  ·  ${compact(source.url, 116)}`,
        size: 14,
        color: COLORS.dim,
        after: 10
      }
    ])
    : [{ text: 'No external sources were retained for this research.', size: 19, color: COLORS.muted }]
  return [
    ...slideHeader('SRC', pageIndex === 0 ? 'Sources' : `Sources · ${pageIndex + 1}`, `${total} sources retained in the canonical evidence ledger.`),
    textShape(10, 'Source list', 0.86, 1.98, 11.55, 4.05, lines)
  ]
}

function slideHeader(index: string, title: string, subtitle: string): string[] {
  return [
    textShape(2, 'Section number', 0.82, 0.72, 1.0, 0.35, [
      { text: index, size: 13, color: COLORS.mint, bold: true }
    ], { tracking: 120 }),
    textShape(3, 'Slide title', 0.82, 1.08, 10.6, 0.62, [
      { text: compact(title, 48), size: 35, color: COLORS.text, bold: true }
    ]),
    textShape(4, 'Slide subtitle', 0.84, 1.68, 10.8, 0.32, [
      { text: subtitle, size: 14, color: COLORS.dim }
    ])
  ]
}

function footer(page: number, research: ResearchDocument): string[] {
  return [
    rectShape(800, 'Footer rule', 0.82, 6.58, 11.72, 0.012, COLORS.border, COLORS.border),
    textShape(801, 'Footer brand', 0.84, 6.67, 4.1, 0.25, [
      { text: 'AKORITH RESEARCH', size: 10, color: COLORS.dim, bold: true }
    ], { tracking: 110 }),
    textShape(802, 'Footer page', 11.84, 6.67, 0.64, 0.25, [
      { text: String(page).padStart(2, '0'), size: 10, color: COLORS.dim, align: 'r' }
    ])
  ]
}

function slideXml(shapes: string[]): string {
  return xml(`
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="${COLORS.canvas}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${shapes.join('\n')}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`)
}

function textShape(
  id: number,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  lines: TextLine[],
  options: { tracking?: number } = {}
): string {
  const paragraphs = lines.map((line) => paragraphXml(line, options.tracking)).join('')
  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
    <p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody>
  </p:sp>`
}

function paragraphXml(line: TextLine, tracking = 0): string {
  const size = Math.round((line.size ?? 18) * 100)
  const color = line.color ?? COLORS.text
  const paragraphProps = [
    `algn="${line.align ?? 'l'}"`,
    `marL="${line.bullet ? 262_000 : 0}"`,
    `indent="${line.bullet ? -170_000 : 0}"`
  ].join(' ')
  return `<a:p><a:pPr ${paragraphProps}>${line.bullet ? '<a:buChar char="•"/>' : '<a:buNone/>'}${line.before ? `<a:spcBef><a:spcPts val="${line.before * 100}"/></a:spcBef>` : ''}${line.after !== undefined ? `<a:spcAft><a:spcPts val="${line.after * 100}"/></a:spcAft>` : ''}</a:pPr><a:r><a:rPr lang="tr-TR" sz="${size}"${line.bold ? ' b="1"' : ''}${tracking ? ` spc="${tracking}"` : ''}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${escapeXml(line.text)}</a:t></a:r><a:endParaRPr lang="tr-TR" sz="${size}"/></a:p>`
}

function rectShape(
  id: number,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  line: string
): string {
  return shapeXml(id, name, 'rect', x, y, width, height, fill, line)
}

function roundedRectShape(
  id: number,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  line: string,
  radius: number
): string {
  void radius
  return shapeXml(id, name, 'roundRect', x, y, width, height, fill, line)
}

function circleShape(id: number, name: string, x: number, y: number, diameter: number, fill: string): string {
  return shapeXml(id, name, 'ellipse', x, y, diameter, diameter, fill, fill)
}

function shapeXml(
  id: number,
  name: string,
  geometry: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  line: string
): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm><a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln><a:effectLst/></p:spPr></p:sp>`
}

function nativeTable(
  id: number,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  headers: string[],
  rows: string[][]
): string {
  const ratios = headers.length === 5 ? [0.35, 0.22, 0.14, 0.14, 0.15] : headers.map(() => 1 / headers.length)
  const widths = ratios.map((ratio) => Math.round(emu(width) * ratio))
  const allRows = [headers, ...rows]
  const rowHeight = Math.floor(emu(height) / Math.max(1, allRows.length))
  const rowXml = allRows.map((row, rowIndex) => `<a:tr h="${rowHeight}">${headers.map((_, columnIndex) => tableCellXml(
    compact(row[columnIndex] ?? '', columnIndex === 0 ? 58 : 30),
    rowIndex === 0,
    rowIndex
  )).join('')}</a:tr>`).join('')
  return `<p:graphicFrame>
    <p:nvGraphicFramePr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
    <p:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></p:xfrm>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>
      <a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>
      <a:tblGrid>${widths.map((value) => `<a:gridCol w="${value}"/>`).join('')}</a:tblGrid>
      ${rowXml}
    </a:tbl></a:graphicData></a:graphic>
  </p:graphicFrame>`
}

function tableCellXml(value: string, header: boolean, rowIndex: number): string {
  const fill = header ? COLORS.mintDark : rowIndex % 2 === 0 ? COLORS.surfaceAlt : COLORS.surface
  const color = header ? COLORS.mint : COLORS.muted
  return `<a:tc><a:txBody><a:bodyPr wrap="square" lIns="91440" tIns="65000" rIns="91440" bIns="65000" anchor="ctr"><a:spAutoFit/></a:bodyPr><a:lstStyle/><a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr><a:r><a:rPr lang="tr-TR" sz="1600"${header ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${escapeXml(value)}</a:t></a:r><a:endParaRPr lang="tr-TR" sz="1600"/></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:lnL w="12700"><a:solidFill><a:srgbClr val="${COLORS.border}"/></a:solidFill></a:lnL><a:lnR w="12700"><a:solidFill><a:srgbClr val="${COLORS.border}"/></a:solidFill></a:lnR><a:lnT w="12700"><a:solidFill><a:srgbClr val="${COLORS.border}"/></a:solidFill></a:lnT><a:lnB w="12700"><a:solidFill><a:srgbClr val="${COLORS.border}"/></a:solidFill></a:lnB></a:tcPr></a:tc>`
}

function contentTypesXml(slideCount: number): string {
  const slides = Array.from({ length: slideCount }, (_, index) =>
    `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  ).join('')
  return xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
    <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
    <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
    <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
    <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
    <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
    <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
    <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
    <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
    ${slides}
  </Types>`)
}

function rootRelationshipsXml(): string {
  return xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
    <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
    <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
  </Relationships>`)
}

function presentationXml(slideCount: number): string {
  const ids = Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')
  return xml(`<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1" autoCompressPictures="0">
    <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
    <p:sldIdLst>${ids}</p:sldIdLst>
    <p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}" type="screen16x9"/>
    <p:notesSz cx="6858000" cy="9144000"/>
    <p:defaultTextStyle><a:defPPr><a:defRPr lang="tr-TR"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:srgbClr val="${COLORS.text}"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle>
  </p:presentation>`)
}

function presentationRelationshipsXml(slideCount: number): string {
  const slides = Array.from({ length: slideCount }, (_, index) =>
    `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`
  ).join('')
  return xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
    ${slides}
    <Relationship Id="rId${slideCount + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>
    <Relationship Id="rId${slideCount + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>
    <Relationship Id="rId${slideCount + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
  </Relationships>`)
}

function slideRelationshipsXml(): string {
  return xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`)
}

function slideMasterXml(): string {
  return xml(`<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Akorith Research"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`)
}

function slideMasterRelationshipsXml(): string {
  return xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`)
}

function slideLayoutXml(): string {
  return xml(`<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)
}

function slideLayoutRelationshipsXml(): string {
  return xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`)
}

function themeXml(): string {
  return xml(`<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Akorith Research"><a:themeElements><a:clrScheme name="Akorith"><a:dk1><a:srgbClr val="${COLORS.canvas}"/></a:dk1><a:lt1><a:srgbClr val="${COLORS.text}"/></a:lt1><a:dk2><a:srgbClr val="${COLORS.surface}"/></a:dk2><a:lt2><a:srgbClr val="DDE3DF"/></a:lt2><a:accent1><a:srgbClr val="${COLORS.mint}"/></a:accent1><a:accent2><a:srgbClr val="${COLORS.violet}"/></a:accent2><a:accent3><a:srgbClr val="${COLORS.warning}"/></a:accent3><a:accent4><a:srgbClr val="7D92F4"/></a:accent4><a:accent5><a:srgbClr val="73C5CE"/></a:accent5><a:accent6><a:srgbClr val="D884A3"/></a:accent6><a:hlink><a:srgbClr val="${COLORS.mint}"/></a:hlink><a:folHlink><a:srgbClr val="${COLORS.violet}"/></a:folHlink></a:clrScheme><a:fontScheme name="Akorith"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="Akorith"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="dk1"/></a:solidFill><a:solidFill><a:schemeClr val="dk2"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`)
}

function corePropertiesXml(research: ResearchDocument): string {
  const created = new Date(research.generatedAt).toISOString()
  return xml(`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(research.title)}</dc:title><dc:subject>${escapeXml(research.subtitle)}</dc:subject><dc:creator>Akorith Research</dc:creator><cp:lastModifiedBy>Akorith Research</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`)
}

function appPropertiesXml(slides: SlideBuild[]): string {
  return xml(`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Akorith</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${slides.length}</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><MMClips>0</MMClips><ScaleCrop>false</ScaleCrop><Company>Akorith</Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion></Properties>`)
}

function presentationPropertiesXml(): string {
  return xml(`<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:showPr useTimings="0"/></p:presentationPr>`)
}

function viewPropertiesXml(): string {
  return xml(`<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" lastView="sldView"><p:normalViewPr><p:restoredLeft sz="15620" autoAdjust="0"/><p:restoredTop sz="94660" autoAdjust="0"/></p:normalViewPr><p:slideViewPr><p:cSldViewPr><p:cViewPr varScale="1"><p:scale><a:sx n="100" d="100"/><a:sy n="100" d="100"/></p:scale><p:origin x="0" y="0"/></p:cViewPr><p:guideLst/></p:cSldViewPr></p:slideViewPr><p:gridSpacing cx="72008" cy="72008"/></p:viewPr>`)
}

function tableStylesXml(): string {
  return xml(`<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`)
}

function emu(inches: number): number {
  return Math.round(inches * INCH)
}

function xml(value: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${value.trim()}`
}

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function compact(value: string, limit: number): string {
  const normalized = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

function proseParagraphs(value: string, limit: number): string[] {
  const paragraphs = value
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((paragraph) => compact(paragraph, 360))
    .filter(Boolean)
  return paragraphs.length > 0 ? paragraphs.slice(0, limit) : ['No additional narrative was retained for this section.']
}

function firstSentence(value: string): string {
  const normalized = compact(value, 250)
  const match = /^.*?[.!?](?:\s|$)/u.exec(normalized)
  return match?.[0].trim() || normalized
}

function formatPoint(value: number, unit: string): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}${unit === '%' ? '%' : ` ${unit}`}`
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(timestamp))
}

function safeHostname(url: string): string {
  try { return new URL(url).hostname } catch { return 'Source' }
}

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = []
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size))
  return groups
}
