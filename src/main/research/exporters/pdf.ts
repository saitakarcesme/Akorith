import { createRequire } from 'module'
import { createWriteStream, renameSync } from 'fs'
import type { ResearchDocument } from '../document'
import { sourceCitationLabel } from '../document'
import {
  researchVisualCitationNumbers,
  type ResearchVisualEvidence
} from '../visual-evidence'
import { researchArtifactPath } from '../workspace'
import { RESEARCH_PDF_FONTS, registerResearchPdfFonts } from './pdf-fonts'

const require = createRequire(__filename)

interface PdfDoc {
  page: { width: number; height: number; margins: { top: number; bottom: number; left: number; right: number } }
  x: number
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
  registerFont(name: string, src: string): PdfDoc
}

type PdfFonts = typeof RESEARCH_PDF_FONTS

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
    const fonts = registerResearchPdfFonts(doc)
    renderCover(doc, document, fonts)
    doc.addPage()
    renderReport(doc, document, fonts)
    doc.end()
  })
  renameSync(partial, path)
  return path
}

function renderCover(doc: PdfDoc, document: ResearchDocument, fonts: PdfFonts): void {
  const { width, height } = doc.page
  doc.rect(0, 0, width, height).fill('#111315')
  doc.circle(width - 40, 120, 230).fill('#1D4B3B')
  doc.circle(35, height - 20, 270).fill('#2D2748')
  doc.roundedRect(28, 28, width - 56, height - 56, 14).strokeColor('#343738').lineWidth(0.8).stroke()
  doc.rect(54, 66, 34, 4).fill('#78D6AA')
  doc.font(fonts.regular).fontSize(9).fillColor('#C9CCCA').text('AKORITH RESEARCH', 98, 62, { characterSpacing: 1.8 })
  doc.font(fonts.bold).fontSize(38).fillColor('#F6F6F3').text(document.title, 54, 210, {
    width: width - 108,
    lineGap: 8
  })
  doc.font(fonts.regular).fontSize(14).fillColor('#B7BAB7').text(document.subtitle, 56, 410, {
    width: width - 112,
    height: 150,
    ellipsis: true,
    lineGap: 5
  })
  doc.moveTo(54, height - 140).lineTo(width - 54, height - 140).strokeColor('#3B3E3D').lineWidth(0.7).stroke()
  doc.font(fonts.regular).fontSize(11).fillColor('#E4E7E4').text(
    `${document.depthLabel.toUpperCase()} · ${document.modelLabel}`,
    54,
    height - 110,
    { width: width - 108 }
  )
  doc.font(fonts.regular).fontSize(8).fillColor('#929692').text(
    `${new Date(document.generatedAt).toISOString().slice(0, 10)} · ${document.sources.length} SOURCES`,
    54,
    height - 82
  )
}

function renderReport(doc: PdfDoc, document: ResearchDocument, fonts: PdfFonts): void {
  heading(doc, document.title, 25, fonts)
  meta(doc, `${document.depthLabel} research · ${document.providerLabel} · ${document.modelLabel}`, fonts)
  rule(doc)
  heading(doc, 'Executive summary', 17, fonts)
  paragraph(doc, document.executiveSummary, fonts)

  for (const section of document.sections) {
    ensureSpace(doc, 110)
    heading(doc, section.title, 17, fonts)
    renderMarkdownLikeBody(doc, section.body, fonts)
    if (section.claims.length > 0) {
      ensureSpace(doc, 80)
      doc.font(fonts.bold).fontSize(10).fillColor('#547266').text('EVIDENCE LEDGER')
      doc.moveDown(0.4)
      for (const claim of section.claims) {
        const refs = claim.evidence
          .map((item) => document.sources.findIndex((source) => source.id === item.sourceId))
          .filter((index) => index >= 0)
          .map((index) => index + 1)
          .join(', ')
        bullet(doc, `${claim.text}${refs ? ` [${refs}]` : ' [unverified]'}`, fonts)
      }
    }
  }

  if (document.visuals.length > 0) {
    const usableHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom
    ensureSpace(doc, Math.min(researchVisualRequiredHeight(document.visuals[0]) + 54, usableHeight))
    heading(doc, 'Visual evidence', 17, fonts)
    document.visuals.forEach((visual, index) => renderVisualEvidence(doc, document, visual, index, fonts))
  }

  if (document.methodology.length > 0 || document.verificationCriteria.length > 0) {
    ensureSpace(doc, 110)
    heading(doc, 'Methodology', 17, fonts)
    for (const item of document.methodology) bullet(doc, item, fonts)
    if (document.verificationCriteria.length > 0) {
      ensureSpace(doc, 96)
      doc.moveDown(0.5)
      doc.font(fonts.bold).fontSize(11).fillColor('#202321').text('Verification criteria')
      for (const item of document.verificationCriteria) bullet(doc, item, fonts)
    }
  }

  ensureSpace(doc, 120)
  heading(doc, 'Sources', 17, fonts)
  document.sources.forEach((source, index) => {
    ensureSpace(doc, 42)
    doc.font(fonts.regular).fontSize(8.5).fillColor('#313532').text(sourceCitationLabel(source, index), {
      width: contentWidth(doc),
      lineGap: 2
    })
    doc.moveDown(0.45)
  })
}

function renderVisualEvidence(
  doc: PdfDoc,
  document: ResearchDocument,
  visual: ResearchVisualEvidence,
  index: number,
  fonts: PdfFonts
): void {
  const left = doc.page.margins.left
  const refs = researchVisualCitationNumbers(visual.provenance.sourceIds, document.sources)
  const requiredHeight = researchVisualRequiredHeight(visual)
  ensureSpace(doc, Math.min(requiredHeight, doc.page.height - doc.page.margins.top - doc.page.margins.bottom))
  doc.x = left
  doc.font(fonts.bold).fontSize(12).fillColor('#26302B').text(`Figure ${index + 1}. ${visual.title}`, left, doc.y, {
    width: contentWidth(doc),
    lineGap: 2
  })
  doc.moveDown(0.5)

  if ((visual.kind === 'quantitative-chart' || visual.kind === 'source-quality-chart') && visual.points) {
    renderVisualChart(doc, visual, fonts)
  } else if (visual.kind === 'evidence-table' && visual.columns && visual.rows) {
    renderVisualTable(doc, visual, fonts)
  } else if (visual.kind === 'web-snapshot' && visual.snapshot) {
    renderVisualSnapshot(doc, visual, fonts)
  }

  ensureSpace(doc, 62)
  doc.x = left
  doc.font(fonts.regular).fontSize(8.4).fillColor('#5E665F').text(visual.caption, left, doc.y, {
    width: contentWidth(doc),
    lineGap: 2
  })
  doc.moveDown(0.25)
  const sourceRefs = refs.length > 0 ? ` · sources ${refs.map((ref) => `[${ref}]`).join(', ')}` : ''
  doc.font(fonts.regular).fontSize(7.5).fillColor('#7C837E').text(
    `Provenance: ${visual.provenance.method}${sourceRefs} · generated ${new Date(visual.provenance.generatedAt).toISOString()}`,
    left,
    doc.y,
    { width: contentWidth(doc), lineGap: 2 }
  )
  doc.moveDown(1.2)
  doc.x = left
}

function researchVisualRequiredHeight(visual: ResearchVisualEvidence): number {
  if (visual.kind === 'evidence-table') return 340
  if (visual.kind === 'web-snapshot') return 280
  return 130 + (visual.points?.length ?? 0) * 30
}

function renderVisualChart(doc: PdfDoc, visual: ResearchVisualEvidence, fonts: PdfFonts): void {
  const points = visual.points ?? []
  const left = doc.page.margins.left
  const width = contentWidth(doc)
  const labelWidth = Math.min(205, width * 0.4)
  const valueWidth = 70
  const barX = left + labelWidth + 10
  const barWidth = width - labelWidth - valueWidth - 22
  const rowHeight = 30
  const max = Math.max(1, ...points.map((point) => Math.abs(point.value)))
  const startY = doc.y

  points.forEach((point, pointIndex) => {
    const y = startY + pointIndex * rowHeight
    const filledWidth = Math.max(2, (Math.abs(point.value) / max) * barWidth)
    doc.font(fonts.regular).fontSize(8.2).fillColor('#313733').text(compactPdfText(point.label, 62), left, y + 3, {
      width: labelWidth,
      height: 19,
      ellipsis: true
    })
    doc.roundedRect(barX, y + 4, barWidth, 12, 4).fill('#E2E7E3')
    doc.roundedRect(barX, y + 4, filledWidth, 12, 4).fill('#67B892')
    doc.font(fonts.bold).fontSize(8.2).fillColor('#28302C').text(formatPdfVisualValue(point.value, point.unit), barX + barWidth + 8, y + 2, {
      width: valueWidth,
      align: 'right'
    })
  })
  doc.y = startY + Math.max(rowHeight, points.length * rowHeight) + 4
  doc.x = left
}

function renderVisualTable(doc: PdfDoc, visual: ResearchVisualEvidence, fonts: PdfFonts): void {
  const columns = visual.columns ?? []
  const rows = (visual.rows ?? []).slice(0, 8)
  const left = doc.page.margins.left
  const totalWidth = contentWidth(doc)
  const widths = [0.36, 0.19, 0.15, 0.14, 0.16].map((ratio) => totalWidth * ratio)
  const headerHeight = 25
  const rowHeight = 28
  let y = doc.y

  doc.rect(left, y, totalWidth, headerHeight).fill('#1F2622')
  let x = left
  columns.forEach((column, columnIndex) => {
    const cellWidth = widths[columnIndex] ?? totalWidth / Math.max(1, columns.length)
    doc.font(fonts.bold).fontSize(7.1).fillColor('#F5F7F5').text(compactPdfText(column, 22), x + 6, y + 8, {
      width: cellWidth - 12,
      height: 12,
      ellipsis: true
    })
    x += cellWidth
  })
  y += headerHeight

  rows.forEach((row, rowIndex) => {
    doc.rect(left, y, totalWidth, rowHeight).fill(rowIndex % 2 === 0 ? '#EEF2EF' : '#F8F9F8')
    x = left
    row.cells.forEach((cell, columnIndex) => {
      const cellWidth = widths[columnIndex] ?? totalWidth / Math.max(1, row.cells.length)
      const limit = columnIndex === 0 ? 58 : columnIndex === 1 ? 28 : 18
      doc.font(fonts.regular).fontSize(7.2).fillColor('#303632').text(compactPdfText(cell, limit), x + 6, y + 8, {
        width: cellWidth - 12,
        height: 13,
        ellipsis: true
      })
      x += cellWidth
    })
    y += rowHeight
  })
  doc.y = y + 7
  doc.x = left
}

function renderVisualSnapshot(doc: PdfDoc, visual: ResearchVisualEvidence, fonts: PdfFonts): void {
  const snapshot = visual.snapshot!
  const left = doc.page.margins.left
  const width = contentWidth(doc)
  const height = 205
  const y = doc.y
  doc.roundedRect(left, y, width, height, 8).fill('#F0F3F1')
  doc.rect(left, y, 5, height).fill('#67B892')
  doc.font(fonts.bold).fontSize(7).fillColor('#477060').text('RETRIEVED TEXT SNAPSHOT · NOT A LIVE WEBPAGE', left + 18, y + 14, {
    width: width - 36,
    characterSpacing: 0.45
  })
  doc.font(fonts.bold).fontSize(12).fillColor('#1B211E').text(snapshot.title, left + 18, y + 36, {
    width: width - 36,
    height: 42,
    ellipsis: true,
    lineGap: 2
  })
  doc.font(fonts.regular).fontSize(8).fillColor('#5F6862').text(
    `${snapshot.publisher} · accessed ${new Date(snapshot.accessedAt).toISOString().slice(0, 10)}`,
    left + 18,
    y + 82,
    { width: width - 36, height: 14, ellipsis: true }
  )
  doc.moveTo(left + 18, y + 103).lineTo(left + width - 18, y + 103).strokeColor('#CCD3CE').lineWidth(0.6).stroke()
  doc.font(fonts.regular).fontSize(8.8).fillColor('#313834').text(compactPdfText(snapshot.excerpt, 780), left + 18, y + 114, {
    width: width - 36,
    height: 58,
    ellipsis: true,
    lineGap: 3
  })
  doc.font(fonts.regular).fontSize(7).fillColor('#347058').text(compactPdfText(snapshot.url, 125), left + 18, y + 181, {
    width: width - 36,
    height: 12,
    ellipsis: true
  })
  doc.y = y + height + 8
  doc.x = left
}

function formatPdfVisualValue(value: number, unit: string): string {
  const numeric = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return unit === '%' ? `${numeric}%` : `${numeric} ${unit}`
}

function compactPdfText(value: string, max: number): string {
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

function renderMarkdownLikeBody(doc: PdfDoc, body: string, fonts: PdfFonts): void {
  for (const block of body.replace(/\r/g, '').split(/\n\s*\n/)) {
    const clean = stripMarkdown(block)
    if (!clean) continue
    if (/^[-*]\s+/m.test(block)) {
      for (const line of block.split('\n')) bullet(doc, stripMarkdown(line.replace(/^\s*[-*]\s+/, '')), fonts)
    } else {
      paragraph(doc, clean, fonts)
    }
  }
}

function heading(doc: PdfDoc, text: string, size: number, fonts: PdfFonts): void {
  ensureSpace(doc, size * 2.8)
  doc.font(fonts.bold).fontSize(size).fillColor('#151816').text(text, {
    width: contentWidth(doc),
    lineGap: 2
  })
  doc.moveDown(0.35)
}

function meta(doc: PdfDoc, text: string, fonts: PdfFonts): void {
  doc.font(fonts.regular).fontSize(8).fillColor('#6F746F').text(text.toUpperCase(), { characterSpacing: 0.7 })
  doc.moveDown(0.6)
}

function paragraph(doc: PdfDoc, text: string, fonts: PdfFonts): void {
  ensureSpace(doc, Math.min(120, doc.heightOfString(text, { width: contentWidth(doc) })) + 16)
  doc.font(fonts.regular).fontSize(10.5).fillColor('#2B2F2C').text(stripMarkdown(text), {
    width: contentWidth(doc),
    lineGap: 4,
    align: 'left'
  })
  doc.moveDown(0.75)
}

function bullet(doc: PdfDoc, text: string, fonts: PdfFonts): void {
  if (!text) return
  ensureSpace(doc, 34)
  const x = doc.page.margins.left
  const y = doc.y + 4
  doc.circle(x + 3, y + 3, 2).fill('#67B892')
  doc.font(fonts.regular).fontSize(9.5).fillColor('#303431').text(text, x + 14, doc.y, {
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
