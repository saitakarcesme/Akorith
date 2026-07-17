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
  TextRun
} from 'docx'
import type { ResearchDocument } from '../document'
import { sourceCitationLabel } from '../document'
import { researchArtifactPath } from '../workspace'

const PAGE_WIDTH = 11_906
const PAGE_HEIGHT = 16_838
const PAGE_MARGIN = 1_134

export async function exportResearchDocx(workspaceDir: string, research: ResearchDocument): Promise<string> {
  const path = researchArtifactPath(workspaceDir, research.title, 'docx')
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

function reportBody(research: ResearchDocument): Paragraph[] {
  const children: Paragraph[] = [
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
