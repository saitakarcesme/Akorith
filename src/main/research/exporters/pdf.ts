import { createRequire } from 'module'
import { createWriteStream, renameSync } from 'fs'
import type { ResearchDocument } from '../document'
import { sourceCitationLabel } from '../document'
import { researchArtifactPath } from '../workspace'

const require = createRequire(__filename)

interface PdfDoc {
  page: { width: number; height: number; margins: { top: number; bottom: number; left: number; right: number } }
  y: number
  pipe(stream: NodeJS.WritableStream): void
  on(event: 'error', listener: (error: Error) => void): void
  end(): void
  addPage(options?: Record<string, unknown>): PdfDoc
  font(name: string): PdfDoc
  fontSize(size: number): PdfDoc
  fillColor(color: string): PdfDoc
  strokeColor(color: string): PdfDoc
  lineWidth(width: number): PdfDoc
  rect(x: number, y: number, width: number, height: number): PdfDoc
  roundedRect(x: number, y: number, width: number, height: number, radius: number): PdfDoc
  circle(x: number, y: number, radius: number): PdfDoc
  fill(color?: string): PdfDoc
  stroke(): PdfDoc
  moveTo(x: number, y: number): PdfDoc
  lineTo(x: number, y: number): PdfDoc
  text(text: string, ...args: unknown[]): PdfDoc
  moveDown(lines?: number): PdfDoc
  heightOfString(text: string, options?: Record<string, unknown>): number
}

function createPdfDocument(options: Record<string, unknown>): PdfDoc {
  const PDFDocument = require('pdfkit') as new (options?: Record<string, unknown>) => PdfDoc
  return new PDFDocument(options)
}

export async function exportResearchPdf(
  workspaceDir: string,
  document: ResearchDocument,
  outputPath?: string
): Promise<string> {
  const path = outputPath ?? researchArtifactPath(workspaceDir, document.title, 'pdf')
  const partial = `${path}.partial`
  await new Promise<void>((resolve, reject) => {
    const doc = createPdfDocument({ size: 'A4', margin: 54, info: { Title: document.title, Author: 'Akorith Research' } })
    const stream = createWriteStream(partial)
    stream.on('finish', resolve)
    stream.on('error', reject)
    doc.on('error', reject)
    doc.pipe(stream)
    renderCover(doc, document)
    doc.addPage()
    renderReport(doc, document)
    doc.end()
  })
  renameSync(partial, path)
  return path
}

function renderCover(doc: PdfDoc, document: ResearchDocument): void {
  const { width, height } = doc.page
  doc.rect(0, 0, width, height).fill('#111315')
  doc.circle(width - 40, 120, 230).fill('#1D4B3B')
  doc.circle(35, height - 20, 270).fill('#2D2748')
  doc.roundedRect(28, 28, width - 56, height - 56, 14).strokeColor('#343738').lineWidth(0.8).stroke()
  doc.rect(54, 66, 34, 4).fill('#78D6AA')
  doc.font('Courier').fontSize(9).fillColor('#C9CCCA').text('AKORITH RESEARCH', 98, 62, { characterSpacing: 1.8 })
  doc.font('Helvetica-Bold').fontSize(38).fillColor('#F6F6F3').text(document.title, 54, 210, {
    width: width - 108,
    lineGap: 8
  })
  doc.font('Helvetica').fontSize(14).fillColor('#B7BAB7').text(document.subtitle, 56, 410, {
    width: width - 112,
    height: 150,
    ellipsis: true,
    lineGap: 5
  })
  doc.moveTo(54, height - 140).lineTo(width - 54, height - 140).strokeColor('#3B3E3D').lineWidth(0.7).stroke()
  doc.font('Helvetica').fontSize(11).fillColor('#E4E7E4').text(
    `${document.depthLabel.toUpperCase()} · ${document.modelLabel}`,
    54,
    height - 110,
    { width: width - 108 }
  )
  doc.font('Courier').fontSize(8).fillColor('#929692').text(
    `${new Date(document.generatedAt).toISOString().slice(0, 10)} · ${document.sources.length} SOURCES`,
    54,
    height - 82
  )
}

function renderReport(doc: PdfDoc, document: ResearchDocument): void {
  heading(doc, document.title, 25)
  meta(doc, `${document.depthLabel} research · ${document.providerLabel} · ${document.modelLabel}`)
  rule(doc)
  heading(doc, 'Executive summary', 17)
  paragraph(doc, document.executiveSummary)

  for (const section of document.sections) {
    ensureSpace(doc, 110)
    heading(doc, section.title, 17)
    renderMarkdownLikeBody(doc, section.body)
    if (section.claims.length > 0) {
      ensureSpace(doc, 80)
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#547266').text('EVIDENCE LEDGER')
      doc.moveDown(0.4)
      for (const claim of section.claims) {
        const refs = claim.evidence
          .map((item) => document.sources.findIndex((source) => source.id === item.sourceId))
          .filter((index) => index >= 0)
          .map((index) => index + 1)
          .join(', ')
        bullet(doc, `${claim.text}${refs ? ` [${refs}]` : ' [unverified]'}`)
      }
    }
  }

  if (document.methodology.length > 0 || document.verificationCriteria.length > 0) {
    ensureSpace(doc, 110)
    heading(doc, 'Methodology', 17)
    for (const item of document.methodology) bullet(doc, item)
    if (document.verificationCriteria.length > 0) {
      ensureSpace(doc, 96)
      doc.moveDown(0.5)
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#202321').text('Verification criteria')
      for (const item of document.verificationCriteria) bullet(doc, item)
    }
  }

  ensureSpace(doc, 120)
  heading(doc, 'Sources', 17)
  document.sources.forEach((source, index) => {
    ensureSpace(doc, 42)
    doc.font('Helvetica').fontSize(8.5).fillColor('#313532').text(sourceCitationLabel(source, index), {
      width: contentWidth(doc),
      lineGap: 2
    })
    doc.moveDown(0.45)
  })
}

function renderMarkdownLikeBody(doc: PdfDoc, body: string): void {
  for (const block of body.replace(/\r/g, '').split(/\n\s*\n/)) {
    const clean = stripMarkdown(block)
    if (!clean) continue
    if (/^[-*]\s+/m.test(block)) {
      for (const line of block.split('\n')) bullet(doc, stripMarkdown(line.replace(/^\s*[-*]\s+/, '')))
    } else {
      paragraph(doc, clean)
    }
  }
}

function heading(doc: PdfDoc, text: string, size: number): void {
  ensureSpace(doc, size * 2.8)
  doc.font('Helvetica-Bold').fontSize(size).fillColor('#151816').text(text, {
    width: contentWidth(doc),
    lineGap: 2
  })
  doc.moveDown(0.35)
}

function meta(doc: PdfDoc, text: string): void {
  doc.font('Courier').fontSize(8).fillColor('#6F746F').text(text.toUpperCase(), { characterSpacing: 0.7 })
  doc.moveDown(0.6)
}

function paragraph(doc: PdfDoc, text: string): void {
  ensureSpace(doc, Math.min(120, doc.heightOfString(text, { width: contentWidth(doc) })) + 16)
  doc.font('Helvetica').fontSize(10.5).fillColor('#2B2F2C').text(stripMarkdown(text), {
    width: contentWidth(doc),
    lineGap: 4,
    align: 'left'
  })
  doc.moveDown(0.75)
}

function bullet(doc: PdfDoc, text: string): void {
  if (!text) return
  ensureSpace(doc, 34)
  const x = doc.page.margins.left
  const y = doc.y + 4
  doc.circle(x + 3, y + 3, 2).fill('#67B892')
  doc.font('Helvetica').fontSize(9.5).fillColor('#303431').text(text, x + 14, doc.y, {
    width: contentWidth(doc) - 14,
    lineGap: 3
  })
  doc.moveDown(0.45)
}

function rule(doc: PdfDoc): void {
  const y = doc.y + 2
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y)
    .strokeColor('#DADDD9').lineWidth(0.6).stroke()
  doc.y = y + 18
}

function ensureSpace(doc: PdfDoc, height: number): void {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage()
}

function contentWidth(doc: PdfDoc): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right
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
