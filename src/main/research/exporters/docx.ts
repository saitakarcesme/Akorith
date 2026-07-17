import { renameSync, writeFileSync } from 'fs'
import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableBorders,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlignTable,
  WidthType
} from 'docx'
import type { ResearchDocument } from '../document'
import { sourceCitationLabel } from '../document'
import {
  researchVisualCitationNumbers,
  type ResearchVisualEvidence
} from '../visual-evidence'
import { researchArtifactPath } from '../workspace'

const PAGE_WIDTH = 11_906
const PAGE_HEIGHT = 16_838
const PAGE_MARGIN = 1_134
const CONTENT_WIDTH = PAGE_WIDTH - (PAGE_MARGIN * 2)

export async function exportResearchDocx(
  workspaceDir: string,
  research: ResearchDocument,
  outputPath?: string
): Promise<string> {
  const path = outputPath ?? researchArtifactPath(workspaceDir, research.title, 'docx')
  const partial = `${path}.partial`
  const document = new Document({
    creator: 'Akorith Research',
    title: research.title,
    description: research.subtitle,
    styles: researchStyles(),
    sections: [{
      properties: {
        page: {
          size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
          margin: { top: PAGE_MARGIN, right: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN }
        }
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({ text: 'AKORITH RESEARCH  ·  ', color: '7B827D', size: 17 }),
              new TextRun({ children: [PageNumber.CURRENT], color: '7B827D', size: 17 })
            ]
          })]
        })
      },
      children: [
        ...coverPage(research),
        ...reportBody(research)
      ]
    }]
  })
  const buffer = await Packer.toBuffer(document)
  writeFileSync(partial, buffer)
  renameSync(partial, path)
  return path
}

function coverPage(research: ResearchDocument): Paragraph[] {
  return [
    new Paragraph({
      spacing: { before: 420, after: 1_900 },
      border: { top: { color: '78D6AA', size: 22, style: 'single', space: 12 } },
      children: [new TextRun({
        text: 'AKORITH RESEARCH',
        bold: true,
        size: 20,
        color: '4C655A',
        characterSpacing: 55
      })]
    }),
    new Paragraph({
      style: 'ResearchCoverTitle',
      children: [new TextRun({ text: research.title, bold: true })]
    }),
    new Paragraph({
      style: 'ResearchCoverSubtitle',
      children: [new TextRun(research.subtitle)]
    }),
    new Paragraph({ spacing: { before: 2_600, after: 180 }, children: [
      new TextRun({ text: `${research.depthLabel.toUpperCase()}  ·  ${research.modelLabel}`, bold: true, size: 21, color: '35423C' })
    ] }),
    new Paragraph({ children: [
      new TextRun({
        text: `${new Date(research.generatedAt).toISOString().slice(0, 10)}  ·  ${research.sources.length} sources`,
        size: 19,
        color: '7B827D'
      })
    ] }),
    new Paragraph({ children: [new PageBreak()] })
  ]
}

function reportBody(research: ResearchDocument): Array<Paragraph | Table> {
  const children: Array<Paragraph | Table> = [
    heading(research.title, HeadingLevel.TITLE),
    new Paragraph({
      spacing: { after: 380 },
      children: [new TextRun({
        text: `${research.depthLabel} research · ${research.providerLabel} · ${research.modelLabel}`,
        italics: true,
        color: '6B716D',
        size: 20
      })]
    }),
    heading('Executive summary', HeadingLevel.HEADING_1),
    bodyParagraph(research.executiveSummary)
  ]
  for (const section of research.sections) {
    children.push(heading(section.title, HeadingLevel.HEADING_1))
    children.push(...markdownParagraphs(section.body))
    if (section.claims.length > 0) {
      children.push(heading('Evidence ledger', HeadingLevel.HEADING_2))
      for (const claim of section.claims) {
        const refs = claim.evidence
          .map((evidence) => research.sources.findIndex((source) => source.id === evidence.sourceId))
          .filter((index) => index >= 0)
          .map((index) => index + 1)
          .join(', ')
        children.push(new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 100 },
          children: [
            new TextRun({ text: `${claim.status.toUpperCase()}: `, bold: true, color: statusColor(claim.status) }),
            new TextRun(`${claim.text}${refs ? ` [${refs}]` : ' [no verified citation]'}`)
          ]
        }))
      }
    }
  }
  if (research.visuals.length > 0) {
    children.push(heading('Visual evidence', HeadingLevel.HEADING_1))
    research.visuals.forEach((visual, index) => {
      children.push(...visualEvidenceBody(research, visual, index))
    })
  }
  if (research.methodology.length > 0 || research.verificationCriteria.length > 0) {
    children.push(heading('Methodology', HeadingLevel.HEADING_1))
    for (const item of research.methodology) children.push(bulletParagraph(item))
    if (research.verificationCriteria.length > 0) {
      children.push(heading('Verification criteria', HeadingLevel.HEADING_2))
      for (const item of research.verificationCriteria) children.push(bulletParagraph(item))
    }
  }
  children.push(heading('Sources', HeadingLevel.HEADING_1))
  research.sources.forEach((source, index) => {
    children.push(new Paragraph({
      spacing: { after: 140 },
      keepNext: false,
      children: [new TextRun({ text: sourceCitationLabel(source, index), size: 18, color: '39403C' })]
    }))
  })
  return children
}

function visualEvidenceBody(
  research: ResearchDocument,
  visual: ResearchVisualEvidence,
  index: number
): Array<Paragraph | Table> {
  const refs = researchVisualCitationNumbers(visual.provenance.sourceIds, research.sources)
  const children: Array<Paragraph | Table> = [
    heading(`Figure ${index + 1}. ${visual.title}`, HeadingLevel.HEADING_2)
  ]
  if ((visual.kind === 'quantitative-chart' || visual.kind === 'source-quality-chart') && visual.points) {
    children.push(chartTable(visual))
  } else if (visual.kind === 'evidence-table' && visual.columns && visual.rows) {
    children.push(evidenceTable(visual))
  } else if (visual.kind === 'web-snapshot' && visual.snapshot) {
    children.push(snapshotCard(visual))
  }
  children.push(new Paragraph({
    spacing: { before: 90, after: 70 },
    children: [new TextRun({ text: visual.caption, italics: true, size: 18, color: '68716B' })]
  }))
  children.push(new Paragraph({
    spacing: { after: 220 },
    children: [new TextRun({
      text: `Provenance: ${visual.provenance.method}${refs.length > 0 ? ` · sources ${refs.map((ref) => `[${ref}]`).join(', ')}` : ''}`,
      size: 16,
      color: '7B827D'
    })]
  }))
  return children
}

function chartTable(visual: ResearchVisualEvidence): Table {
  const labelWidth = 2_900
  const segmentWidth = 510
  const valueWidth = CONTENT_WIDTH - labelWidth - segmentWidth * 10
  const max = Math.max(1, ...(visual.points ?? []).map((point) => Math.abs(point.value)))
  const rows = (visual.points ?? []).map((point) => {
    const filled = Math.max(1, Math.round((Math.abs(point.value) / max) * 10))
    return new TableRow({
      cantSplit: true,
      children: [
        tableCell(compact(point.label, 56), labelWidth, { bold: true }),
        ...Array.from({ length: 10 }, (_, segment) => new TableCell({
          width: { size: segmentWidth, type: WidthType.DXA },
          verticalAlign: VerticalAlignTable.CENTER,
          margins: { top: 80, bottom: 80, left: 8, right: 8, marginUnitType: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: segment < filled ? '78D6AA' : 'E5E9E6' },
          borders: TableBorders.NONE,
          children: [new Paragraph({ children: [new TextRun(' ')] })]
        })),
        tableCell(formatVisualValue(point.value, point.unit), valueWidth, { bold: true, align: AlignmentType.RIGHT })
      ]
    })
  })
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [labelWidth, ...Array(10).fill(segmentWidth), valueWidth],
    layout: TableLayoutType.FIXED,
    borders: TableBorders.NONE,
    rows
  })
}

function evidenceTable(visual: ResearchVisualEvidence): Table {
  const widths = [3_500, 1_800, 1_450, 1_400, CONTENT_WIDTH - 8_150]
  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: (visual.columns ?? []).map((column, index) =>
      tableCell(column, widths[index], { bold: true, fill: '1B211E', color: 'F3F6F4' })
    )
  })
  const body = (visual.rows ?? []).map((row, rowIndex) => new TableRow({
    cantSplit: true,
    children: row.cells.map((cell, index) => tableCell(
      compact(cell, index === 0 ? 82 : 38),
      widths[index],
      { fill: rowIndex % 2 === 0 ? 'F1F4F2' : 'FAFBFA' }
    ))
  }))
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders: {
      top: { style: 'single', size: 2, color: 'CBD2CD' },
      bottom: { style: 'single', size: 2, color: 'CBD2CD' },
      insideHorizontal: { style: 'single', size: 1, color: 'E1E5E2' }
    },
    rows: [header, ...body]
  })
}

function snapshotCard(visual: ResearchVisualEvidence): Table {
  const snapshot = visual.snapshot!
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [CONTENT_WIDTH],
    layout: TableLayoutType.FIXED,
    borders: {
      top: { style: 'single', size: 4, color: '78D6AA' },
      bottom: { style: 'single', size: 2, color: 'CBD2CD' },
      left: { style: 'single', size: 2, color: 'CBD2CD' },
      right: { style: 'single', size: 2, color: 'CBD2CD' }
    },
    rows: [new TableRow({
      cantSplit: true,
      children: [new TableCell({
        width: { size: CONTENT_WIDTH, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: 'F1F4F2' },
        margins: { top: 180, bottom: 180, left: 220, right: 220, marginUnitType: WidthType.DXA },
        children: [
          new Paragraph({ spacing: { after: 70 }, children: [new TextRun({
            text: 'RETRIEVED TEXT SNAPSHOT · NOT A LIVE WEBPAGE',
            bold: true,
            size: 15,
            color: '4C715F',
            characterSpacing: 30
          })] }),
          new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: snapshot.publisher, bold: true, size: 18, color: '39705B' })] }),
          new Paragraph({ spacing: { after: 100 }, keepNext: true, children: [new TextRun({ text: snapshot.title, bold: true, size: 25, color: '171B18' })] }),
          new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: compact(snapshot.excerpt, 1_000), size: 19, color: '343B37' })] }),
          new Paragraph({ children: [new TextRun({ text: snapshot.url, size: 16, color: '2F6D55', underline: {} })] })
        ]
      })]
    })]
  })
}

function tableCell(
  text: string,
  width: number,
  options: { bold?: boolean; fill?: string; color?: string; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {}
): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlignTable.CENTER,
    margins: { top: 110, bottom: 110, left: 100, right: 100, marginUnitType: WidthType.DXA },
    ...(options.fill ? { shading: { type: ShadingType.CLEAR, fill: options.fill } } : {}),
    borders: TableBorders.NONE,
    children: [new Paragraph({
      alignment: options.align ?? AlignmentType.LEFT,
      children: [new TextRun({ text, bold: options.bold, size: 17, color: options.color ?? '29302C' })]
    })]
  })
}

function formatVisualValue(value: number, unit: string): string {
  const numeric = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return unit === '%' ? `${numeric}%` : `${numeric} ${unit}`
}

function compact(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

function researchStyles(): ConstructorParameters<typeof Document>[0]['styles'] {
  return {
    default: {
      document: { run: { font: 'Aptos', size: 22, color: '252A27' }, paragraph: { spacing: { line: 310 } } },
      heading1: { run: { font: 'Aptos Display', size: 34, bold: true, color: '171B18' }, paragraph: { spacing: { before: 360, after: 170 } } },
      heading2: { run: { font: 'Aptos Display', size: 27, bold: true, color: '345247' }, paragraph: { spacing: { before: 260, after: 130 } } },
      title: { run: { font: 'Aptos Display', size: 48, bold: true, color: '151916' }, paragraph: { spacing: { after: 240 } } }
    },
    paragraphStyles: [
      {
        id: 'ResearchCoverTitle',
        name: 'Research Cover Title',
        basedOn: 'Normal',
        next: 'ResearchCoverSubtitle',
        run: { font: 'Aptos Display', size: 58, bold: true, color: '141815' },
        paragraph: { spacing: { after: 280 }, keepNext: true }
      },
      {
        id: 'ResearchCoverSubtitle',
        name: 'Research Cover Subtitle',
        basedOn: 'Normal',
        next: 'Normal',
        run: { font: 'Aptos', size: 25, color: '666D68' },
        paragraph: { spacing: { after: 120 }, keepNext: true }
      }
    ]
  }
}

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]): Paragraph {
  return new Paragraph({ text, heading: level, keepNext: true })
}

function bodyParagraph(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 180 },
    children: [new TextRun(stripMarkdown(text))]
  })
}

function bulletParagraph(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 100 },
    children: [new TextRun(stripMarkdown(text))]
  })
}

function markdownParagraphs(markdown: string): Paragraph[] {
  return markdown.replace(/\r/g, '').split(/\n\s*\n/).flatMap((block) => {
    if (/^[-*]\s+/m.test(block)) {
      return block.split('\n').filter(Boolean).map((line) => bulletParagraph(line.replace(/^\s*[-*]\s+/, '')))
    }
    const text = stripMarkdown(block)
    return text ? [bodyParagraph(text)] : []
  })
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?|```/g, ''))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/[*_~`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function statusColor(status: string): string {
  if (status === 'verified') return '26845F'
  if (status === 'conflicted') return '8B5EA7'
  return 'A65A52'
}
