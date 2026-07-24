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
import { normalizeArtifactText, RESEARCH_ARTIFACT_DESIGN, splitArtifactProse } from './design'

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
  bufferedPageRange(): { start: number; count: number }
  switchToPage(index: number): PdfDoc
  struct(type: string, options?: Record<string, unknown>, children?: unknown[]): PdfStructure
  addStructure(structure: PdfStructure): void
  markContent(tag: string, options?: Record<string, unknown>): PdfDoc
  endMarkedContent(): PdfDoc
  structureRoot?: PdfStructure
}

interface PdfStructure {
  add(item: unknown): void
}

type PdfFonts = typeof RESEARCH_PDF_FONTS

interface PdfFittedTextBlock {
  text: string
  fontSize: number
  height: number
  lineGap: number
  truncated: boolean
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
    const generatedAt = new Date(document.generatedAt)
    const doc = createPdfDocument({
      size: 'A4',
      margins: {
        top: RESEARCH_ARTIFACT_DESIGN.geometry.pageMarginPoints,
        right: RESEARCH_ARTIFACT_DESIGN.geometry.pageMarginPoints,
        bottom: 72,
        left: RESEARCH_ARTIFACT_DESIGN.geometry.pageMarginPoints
      },
      bufferPages: true,
      tagged: true,
      displayTitle: true,
      lang: inferPdfLanguage(`${document.title} ${document.subtitle} ${document.executiveSummary}`),
      info: {
        Title: document.title,
        Author: 'Akorith Research',
        Subject: document.subtitle,
        Keywords: 'research, evidence, sources, Akorith',
        Creator: 'Akorith',
        Producer: 'Akorith Research',
        CreationDate: generatedAt,
        ModDate: generatedAt
      }
    })
    const stream = createWriteStream(partial)
    stream.on('finish', resolve)
    stream.on('error', reject)
    doc.on('error', reject)
    doc.pipe(stream)
    const fonts = registerResearchPdfFonts(doc)
    doc.structureRoot = doc.struct('Document')
    renderCover(doc, document, fonts)
    doc.addPage()
    renderReport(doc, document, fonts)
    renderPageFooters(doc, fonts)
    if (doc.structureRoot) doc.addStructure(doc.structureRoot)
    doc.end()
  })
  renameSync(partial, path)
  return path
}

function renderCover(doc: PdfDoc, document: ResearchDocument, fonts: PdfFonts): void {
  const { width, height } = doc.page
  const titleTop = 178
  const titleLayout = fitPdfTextBlock(doc, document.title, fonts.bold, {
    width: width - 108,
    maxHeight: 236,
    maxFontSize: 38,
    minFontSize: 21,
    maxLines: 8,
    lineHeight: 1.18
  })
  const subtitleTop = titleTop + titleLayout.height + 28
  const metadataRuleY = height - 140
  const subtitleLayout = fitPdfTextBlock(doc, document.subtitle, fonts.regular, {
    width: width - 112,
    maxHeight: Math.max(64, metadataRuleY - subtitleTop - 28),
    maxFontSize: 14,
    minFontSize: 9,
    maxLines: 10,
    lineHeight: 1.38
  })
  const identityLayout = fitPdfTextBlock(doc, `${document.depthLabel.toUpperCase()} · ${document.modelLabel}`, fonts.regular, {
    width: width - 108,
    // The 16pt height is the effective one-line guard. `heightOfString`
    // includes font leading, so a literal maxLines=1 would reject every
    // otherwise valid one-line string before the height check can accept it.
    maxHeight: 16,
    maxFontSize: 11,
    minFontSize: 8,
    maxLines: 2,
    lineHeight: 1.1
  })
  doc.rect(0, 0, width, height).fill('#111315')
  doc.circle(width - 40, 120, 230).fill('#1D4B3B')
  doc.circle(35, height - 20, 270).fill('#2D2748')
  doc.roundedRect(28, 28, width - 56, height - 56, 14).strokeColor('#343738').lineWidth(0.8).stroke()
  doc.rect(54, 66, 34, 4).fill('#78D6AA')
  doc.font(fonts.regular).fontSize(9).fillColor('#C9CCCA').text('AKORITH RESEARCH', 98, 62, tagged(doc, 'P', { characterSpacing: 1.8 }))
  doc.font(fonts.bold).fontSize(titleLayout.fontSize).fillColor('#F6F6F3').text(titleLayout.text, 54, titleTop, tagged(doc, 'H1', {
    width: width - 108,
    height: titleLayout.height + 3,
    lineGap: titleLayout.lineGap
  }))
  doc.font(fonts.regular).fontSize(subtitleLayout.fontSize).fillColor('#B7BAB7').text(subtitleLayout.text, 56, subtitleTop, tagged(doc, 'P', {
    width: width - 112,
    height: subtitleLayout.height + 3,
    lineGap: subtitleLayout.lineGap
  }))
  if (titleLayout.truncated || subtitleLayout.truncated) {
    doc.font(fonts.regular).fontSize(7.8).fillColor('#AEB2AE').text(
      'Cover preview shortened; the full title and research brief continue in the report.',
      56,
      metadataRuleY - 22,
      tagged(doc, 'P', { width: width - 112 })
    )
  }
  doc.moveTo(54, metadataRuleY).lineTo(width - 54, metadataRuleY).strokeColor('#3B3E3D').lineWidth(0.7).stroke()
  doc.font(fonts.regular).fontSize(identityLayout.fontSize).fillColor('#E4E7E4').text(
    identityLayout.text,
    54,
    height - 110,
    tagged(doc, 'P', {
      width: width - 108,
      height: identityLayout.height + 2,
      lineGap: identityLayout.lineGap
    })
  )
  doc.font(fonts.regular).fontSize(8).fillColor('#929692').text(
    `${new Date(document.generatedAt).toISOString().slice(0, 10)} · ${document.sources.length} SOURCES`,
    54,
    height - 82,
    tagged(doc, 'P')
  )
}

function fitPdfTextBlock(
  doc: PdfDoc,
  value: string,
  font: string,
  options: {
    width: number
    maxHeight: number
    maxFontSize: number
    minFontSize: number
    maxLines: number
    lineHeight: number
  }
): PdfFittedTextBlock {
  const clean = normalizeArtifactText(value)
  for (let fontSize = options.maxFontSize; fontSize >= options.minFontSize; fontSize -= 1) {
    const lineGap = fontSize * (options.lineHeight - 1)
    doc.font(font).fontSize(fontSize)
    const height = doc.heightOfString(clean, { width: options.width, lineGap })
    if (height <= options.maxHeight && height <= options.maxLines * fontSize * options.lineHeight) {
      return { text: clean, fontSize, height, lineGap, truncated: false }
    }
  }

  const fontSize = options.minFontSize
  const lineGap = fontSize * (options.lineHeight - 1)
  doc.font(font).fontSize(fontSize)
  const characters = Array.from(clean)
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = `${characters.slice(0, middle).join('').trimEnd()}\u2026`
    const height = doc.heightOfString(candidate, { width: options.width, lineGap })
    if (height <= options.maxHeight && height <= options.maxLines * fontSize * options.lineHeight) low = middle
    else high = middle - 1
  }
  const text = low < characters.length
    ? `${characters.slice(0, Math.max(1, low)).join('').trimEnd()}\u2026`
    : clean
  const height = Math.min(options.maxHeight, doc.heightOfString(text, { width: options.width, lineGap }))
  return { text, fontSize, height, lineGap, truncated: low < characters.length }
}

function renderReport(doc: PdfDoc, document: ResearchDocument, fonts: PdfFonts): void {
  heading(doc, document.title, 25, fonts)
  for (const briefParagraph of splitArtifactProse(document.subtitle)) {
    paragraph(doc, briefParagraph, fonts)
  }
  meta(doc, `${document.depthLabel} research · ${document.providerLabel} · ${document.modelLabel}`, fonts)
  rule(doc)
  heading(doc, 'Executive summary', 17, fonts)
  for (const summaryParagraph of splitArtifactProse(document.executiveSummary)) {
    paragraph(doc, summaryParagraph, fonts)
  }

  for (const section of document.sections) {
    ensureSpace(doc, 110)
    heading(doc, section.title, 17, fonts)
    renderMarkdownLikeBody(doc, section.body, fonts)
    if (section.claims.length > 0) {
      ensureSpace(doc, 80)
      doc.font(fonts.bold).fontSize(10).fillColor('#547266').text('EVIDENCE LEDGER', tagged(doc, 'H3'))
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
      doc.font(fonts.bold).fontSize(11).fillColor('#202321').text('Verification criteria', tagged(doc, 'H3'))
      for (const item of document.verificationCriteria) bullet(doc, item, fonts)
    }
  }

  ensureSpace(doc, 120)
  heading(doc, 'Sources', 17, fonts)
  document.sources.forEach((source, index) => {
    ensureSpace(doc, 42)
    const left = doc.page.margins.left
    doc.font(fonts.regular).fontSize(8.5).fillColor('#313532').text(sourceCitationLabel(source, index), left, doc.y, tagged(doc, 'P', {
      width: contentWidth(doc),
      lineGap: 2
    }))
    doc.moveDown(0.45)
    doc.x = left
  })
}

function renderPageFooters(doc: PdfDoc, fonts: PdfFonts): void {
  const pages = doc.bufferedPageRange()
  for (let pageIndex = 1; pageIndex < pages.count; pageIndex += 1) {
    doc.switchToPage(pages.start + pageIndex)
    const originalBottomMargin = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    const y = doc.page.height - 38
    doc.markContent('Artifact', { type: 'Pagination' })
    doc.moveTo(doc.page.margins.left, y - 8)
      .lineTo(doc.page.width - doc.page.margins.right, y - 8)
      .strokeColor('#DADDD9').lineWidth(0.5).stroke()
    doc.font(fonts.regular).fontSize(7.5).fillColor('#6F746F').text('AKORITH RESEARCH', doc.page.margins.left, y, {
      width: 180,
      lineBreak: false
    })
    doc.text(String(pageIndex), doc.page.width - doc.page.margins.right - 36, y, {
      width: 36,
      align: 'right',
      lineBreak: false
    })
    doc.endMarkedContent()
    doc.page.margins.bottom = originalBottomMargin
  }
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
  doc.font(fonts.bold).fontSize(12).fillColor('#26302B').text(`Figure ${index + 1}. ${visual.title}`, left, doc.y, tagged(doc, 'H3', {
    width: contentWidth(doc),
    lineGap: 2
  }))
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
  doc.font(fonts.regular).fontSize(8.4).fillColor('#5E665F').text(visual.caption, left, doc.y, tagged(doc, 'P', {
    width: contentWidth(doc),
    lineGap: 2
  }))
  doc.moveDown(0.25)
  const sourceRefs = refs.length > 0 ? ` · sources ${refs.map((ref) => `[${ref}]`).join(', ')}` : ''
  doc.font(fonts.regular).fontSize(7.5).fillColor('#7C837E').text(
    `Provenance: ${visual.provenance.method}${sourceRefs} · generated ${new Date(visual.provenance.generatedAt).toISOString()}`,
    left,
    doc.y,
    tagged(doc, 'P', { width: contentWidth(doc), lineGap: 2 })
  )
  doc.moveDown(1.2)
  doc.x = left
}

function researchVisualRequiredHeight(visual: ResearchVisualEvidence): number {
  if (visual.kind === 'evidence-table') return 112 + (visual.rows?.length ?? 0) * 28
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
    doc.font(fonts.regular).fontSize(8.2).fillColor('#313733').text(compactPdfText(point.label, 62), left, y + 3, tagged(doc, 'P', {
      width: labelWidth,
      height: 19,
      ellipsis: true
    }))
    doc.roundedRect(barX, y + 4, barWidth, 12, 4).fill('#E2E7E3')
    doc.roundedRect(barX, y + 4, filledWidth, 12, 4).fill('#67B892')
    doc.font(fonts.bold).fontSize(8.2).fillColor('#28302C').text(formatPdfVisualValue(point.value, point.unit), barX + barWidth + 8, y + 2, tagged(doc, 'P', {
      width: valueWidth,
      align: 'right'
    }))
  })
  doc.y = startY + Math.max(rowHeight, points.length * rowHeight) + 4
  doc.x = left
}

function renderVisualTable(doc: PdfDoc, visual: ResearchVisualEvidence, fonts: PdfFonts): void {
  const columns = visual.columns ?? []
  const rows = visual.rows ?? []
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
    doc.font(fonts.bold).fontSize(7.1).fillColor('#F5F7F5').text(compactPdfText(column, 22), x + 6, y + 8, tagged(doc, 'P', {
      width: cellWidth - 12,
      height: 12,
      ellipsis: true
    }))
    x += cellWidth
  })
  y += headerHeight

  rows.forEach((row, rowIndex) => {
    doc.rect(left, y, totalWidth, rowHeight).fill(rowIndex % 2 === 0 ? '#EEF2EF' : '#F8F9F8')
    x = left
    row.cells.forEach((cell, columnIndex) => {
      const cellWidth = widths[columnIndex] ?? totalWidth / Math.max(1, row.cells.length)
      const limit = columnIndex === 0 ? 58 : columnIndex === 1 ? 28 : 18
      doc.font(fonts.regular).fontSize(7.2).fillColor('#303632').text(compactPdfText(cell, limit), x + 6, y + 8, tagged(doc, 'P', {
        width: cellWidth - 12,
        height: 13,
        ellipsis: true
      }))
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
  doc.font(fonts.bold).fontSize(7).fillColor('#477060').text('RETRIEVED TEXT SNAPSHOT · NOT A LIVE WEBPAGE', left + 18, y + 14, tagged(doc, 'P', {
    width: width - 36,
    characterSpacing: 0.45
  }))
  doc.font(fonts.bold).fontSize(12).fillColor('#1B211E').text(snapshot.title, left + 18, y + 36, tagged(doc, 'H3', {
    width: width - 36,
    height: 42,
    ellipsis: true,
    lineGap: 2
  }))
  doc.font(fonts.regular).fontSize(8).fillColor('#5F6862').text(
    `${snapshot.publisher} · accessed ${new Date(snapshot.accessedAt).toISOString().slice(0, 10)}`,
    left + 18,
    y + 82,
    tagged(doc, 'P', { width: width - 36, height: 14, ellipsis: true })
  )
  doc.moveTo(left + 18, y + 103).lineTo(left + width - 18, y + 103).strokeColor('#CCD3CE').lineWidth(0.6).stroke()
  doc.font(fonts.regular).fontSize(8.8).fillColor('#313834').text(compactPdfText(snapshot.excerpt, 780), left + 18, y + 114, tagged(doc, 'P', {
    width: width - 36,
    height: 58,
    ellipsis: true,
    lineGap: 3
  }))
  doc.font(fonts.regular).fontSize(7).fillColor('#347058').text(compactPdfText(snapshot.url, 125), left + 18, y + 181, tagged(doc, 'P', {
    width: width - 36,
    height: 12,
    ellipsis: true
  }))
  doc.y = y + height + 8
  doc.x = left
}

function formatPdfVisualValue(value: number, unit: string): string {
  const numeric = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return unit === '%' ? `${numeric}%` : `${numeric} ${unit}`
}

function compactPdfText(value: string, max: number): string {
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
  const characters = Array.from(clean)
  return characters.length <= max
    ? clean
    : `${characters.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`
}

function inferPdfLanguage(value: string): string {
  if (/[ğĞıİşŞçÇöÖüÜ]/u.test(value) || /\b(?:ve|için|araştırma|kaynak|sonuç)\b/iu.test(value)) return 'tr-TR'
  if (/\p{Script=Arabic}/u.test(value)) return 'ar'
  if (/\p{Script=Cyrillic}/u.test(value)) return 'ru-RU'
  if (/\p{Script=Han}/u.test(value)) return 'zh-CN'
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(value)) return 'ja-JP'
  return 'en-US'
}

function renderMarkdownLikeBody(doc: PdfDoc, body: string, fonts: PdfFonts): void {
  for (const block of body.replace(/\r/g, '').split(/\n\s*\n/)) {
    const clean = stripMarkdown(block)
    if (!clean) continue
    if (/^[-*]\s+/m.test(block)) {
      for (const line of block.split('\n')) bullet(doc, stripMarkdown(line.replace(/^\s*[-*]\s+/, '')), fonts)
    } else {
      for (const prose of splitArtifactProse(clean)) paragraph(doc, prose, fonts)
    }
  }
}

function heading(doc: PdfDoc, text: string, size: number, fonts: PdfFonts): void {
  const left = doc.page.margins.left
  doc.x = left
  doc.font(fonts.bold).fontSize(size)
  const height = doc.heightOfString(text, { width: contentWidth(doc), lineGap: 2 })
  ensureSpace(doc, Math.min(height, usablePageHeight(doc)) + size * 0.8)
  doc.x = left
  doc.font(fonts.bold).fontSize(size).fillColor('#151816').text(text, left, doc.y, tagged(doc, size >= 20 ? 'H1' : 'H2', {
    width: contentWidth(doc),
    lineGap: 2
  }))
  doc.moveDown(0.35)
  doc.x = left
}

function meta(doc: PdfDoc, text: string, fonts: PdfFonts): void {
  const left = doc.page.margins.left
  doc.font(fonts.regular).fontSize(8).fillColor('#6F746F').text(text.toUpperCase(), left, doc.y, tagged(doc, 'P', {
    width: contentWidth(doc),
    characterSpacing: 0.7
  }))
  doc.moveDown(0.6)
  doc.x = left
}

function paragraph(doc: PdfDoc, text: string, fonts: PdfFonts): void {
  const left = doc.page.margins.left
  const clean = stripMarkdown(text)
  doc.x = left
  doc.font(fonts.regular).fontSize(10.5)
  const height = doc.heightOfString(clean, { width: contentWidth(doc), lineGap: 4 })
  ensureSpace(doc, Math.min(height, usablePageHeight(doc)) + 16)
  doc.x = left
  doc.font(fonts.regular).fontSize(10.5).fillColor('#2B2F2C').text(clean, left, doc.y, tagged(doc, 'P', {
    width: contentWidth(doc),
    lineGap: 4,
    align: 'left'
  }))
  doc.moveDown(0.75)
  doc.x = left
}

function bullet(doc: PdfDoc, text: string, fonts: PdfFonts): void {
  if (!text) return
  ensureSpace(doc, 34)
  const x = doc.page.margins.left
  const y = doc.y + 4
  doc.circle(x + 3, y + 3, 2).fill('#67B892')
  doc.font(fonts.regular).fontSize(9.5).fillColor('#303431').text(text, x + 14, doc.y, tagged(doc, 'P', {
    width: contentWidth(doc) - 14,
    lineGap: 3
  }))
  doc.moveDown(0.45)
  doc.x = x
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

function usablePageHeight(doc: PdfDoc): number {
  return doc.page.height - doc.page.margins.top - doc.page.margins.bottom
}

function tagged(
  doc: PdfDoc,
  structType: 'H1' | 'H2' | 'H3' | 'P' | 'L' | 'LI' | 'Table',
  options: Record<string, unknown> = {}
): Record<string, unknown> {
  return doc.structureRoot
    ? { ...options, structParent: doc.structureRoot, structType }
    : options
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
