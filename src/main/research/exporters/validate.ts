import { createHash } from 'crypto'
import { createRequire } from 'module'
import { readFileSync, statSync } from 'fs'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import type { ResearchOutputFormat } from '../types'
import {
  estimatedTextWidth,
  estimateSpreadsheetRowHeight,
  estimateWrappedLineCount,
  RESEARCH_ARTIFACT_DESIGN
} from './design'

const require = createRequire(__filename)
interface PdfTextItem {
  str: string
  transform: number[]
  width?: number
  height?: number
}
interface PdfPageData {
  getViewport(scale: number): { width: number; height: number }
  getTextContent(options: Record<string, unknown>): Promise<{ items: PdfTextItem[] }>
}
interface PdfPageLayout {
  width: number
  height: number
  items: Array<{ text: string; x: number; y: number; width: number; height: number }>
}
const pdfParse = require('pdf-parse') as (
  buffer: Buffer,
  options?: { pagerender?: (page: PdfPageData) => Promise<string> }
) => Promise<{ text: string; numpages: number }>

export interface ArtifactValidationResult {
  ok: boolean
  checksum: string
  byteSize: number
  mimeType: string
  pageCount?: number
  error?: string
}

const MIME_TYPES: Record<ResearchOutputFormat, string> = {
  pdf: 'application/pdf',
  md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

export async function validateResearchArtifact(
  format: ResearchOutputFormat,
  path: string
): Promise<ArtifactValidationResult> {
  const bytes = readFileSync(path)
  const base = {
    checksum: createHash('sha256').update(bytes).digest('hex'),
    byteSize: statSync(path).size,
    mimeType: MIME_TYPES[format]
  }
  try {
    if (format === 'md') validateMarkdown(bytes.toString('utf8'))
    if (format === 'pdf') {
      const pageTexts: string[] = []
      const pageLayouts: PdfPageLayout[] = []
      const parsed = await pdfParse(bytes, {
        pagerender: async (page) => {
          const viewport = page.getViewport(1)
          const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false })
          const text = content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim()
          pageTexts.push(text)
          pageLayouts.push({
            width: viewport.width,
            height: viewport.height,
            items: content.items
              .filter((item) => item.str.trim())
              .map((item) => ({
                text: item.str,
                x: Number(item.transform[4]),
                y: Number(item.transform[5]),
                width: Number(item.width ?? 0),
                height: Math.abs(Number(item.height ?? item.transform[0] ?? 0))
              }))
          })
          return text
        }
      })
      if (parsed.numpages < 2) throw new Error('PDF is missing its cover or report pages.')
      if (parsed.text.trim().length < 80) throw new Error('PDF contains too little readable report text.')
      for (const [pageIndex, text] of pageTexts.entries()) {
        const substantive = text.replace(/AKORITH RESEARCH/gi, '').replace(/\b\d{1,3}\b/g, '').trim()
        if (!substantive) throw new Error(`PDF contains an empty report page at page ${pageIndex + 1}.`)
      }
      validatePdfPageLayouts(pageLayouts)
      const structure = bytes.toString('latin1')
      if (!/\/StructTreeRoot\b/.test(structure) || !/\/MarkInfo\b/.test(structure)) {
        throw new Error('PDF is missing its tagged logical structure tree.')
      }
      if (!/\/Lang\s*\([a-z]{2}(?:-[A-Z]{2})?\)/.test(structure)) throw new Error('PDF has no document language metadata.')
      return { ok: true, ...base, pageCount: parsed.numpages }
    }
    if (format === 'docx') await validateDocx(bytes)
    if (format === 'xlsx') await validateXlsx(bytes)
    if (format === 'pptx') await validatePptx(bytes)
    return { ok: true, ...base }
  } catch (error) {
    return {
      ok: false,
      ...base,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Validate PDF.js' rendered text geometry, not only extracted text. PDFKit can
 * produce a syntactically valid PDF while starting a block from a stale x
 * cursor or placing a cover subtitle over a wrapped title. Both defects remain
 * readable to a text parser, so they need page-coordinate checks.
 */
function validatePdfPageLayouts(pages: PdfPageLayout[]): void {
  const margin = RESEARCH_ARTIFACT_DESIGN.geometry.pageMarginPoints
  const edgeTolerance = 1.5
  const reportBottomSafeLine = 66

  const cover = pages[0]
  const titleLines = cover?.items.filter((item) => item.height >= 18 && item.y > 130 && item.y < 720) ?? []
  const subtitleLines = cover?.items.filter((item) => item.height >= 7 && item.height < 18 && item.y > 130 && item.y < 720) ?? []
  for (const title of titleLines) {
    for (const subtitle of subtitleLines) {
      const horizontalOverlap = Math.min(title.x + title.width, subtitle.x + subtitle.width) - Math.max(title.x, subtitle.x)
      const verticalOverlap = Math.min(title.y + title.height, subtitle.y + subtitle.height) - Math.max(title.y, subtitle.y)
      if (horizontalOverlap > 1 && verticalOverlap > 1) {
        throw new Error('PDF cover title overlaps the research brief.')
      }
    }
  }

  pages.forEach((page, pageIndex) => {
    if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) {
      throw new Error(`PDF page ${pageIndex + 1} has invalid page geometry.`)
    }
    for (const item of page.items) {
      const right = item.x + item.width
      const top = item.y + item.height
      if (![item.x, item.y, item.width, item.height, right, top].every(Number.isFinite)) {
        throw new Error(`PDF page ${pageIndex + 1} contains invalid text geometry.`)
      }
      if (item.x < margin - edgeTolerance || right > page.width - margin + edgeTolerance) {
        throw new Error(`PDF text exceeds the horizontal safe area at page ${pageIndex + 1}.`)
      }
      if (item.y < -edgeTolerance || top > page.height + edgeTolerance) {
        throw new Error(`PDF text exceeds the page canvas at page ${pageIndex + 1}.`)
      }
      const isFooter = pageIndex > 0 && item.y < 50
      if (pageIndex > 0 && !isFooter && item.y < reportBottomSafeLine) {
        throw new Error(`PDF body content enters the footer safe area at page ${pageIndex + 1}.`)
      }
    }
  })
}

function validateMarkdown(markdown: string): void {
  if (!/^#\s+\S/m.test(markdown)) throw new Error('Markdown report has no title.')
  if (!/^##\s+Executive summary\s*$/im.test(markdown)) throw new Error('Markdown report has no executive summary.')
  if (!/^##\s+Sources\s*$/im.test(markdown)) throw new Error('Markdown report has no Sources section.')
  if (!/^##\s+Contents\s*$/im.test(markdown)) throw new Error('Markdown report has no table of contents.')
  const refs = [...markdown.matchAll(/\[\d+\]\(#source-(\d+)\)/g)].map((match) => match[1])
  for (const ref of refs) {
    if (!markdown.includes(`<a id="source-${ref}"></a>`)) throw new Error(`Markdown contains an orphan source reference: ${ref}.`)
  }
  const anchorList = [...markdown.matchAll(/<a id="([a-z0-9-]+)"><\/a>/g)].map((match) => match[1])
  const anchors = new Set(anchorList)
  if (anchors.size !== anchorList.length) throw new Error('Markdown contains duplicate section anchors.')
  for (const target of [...markdown.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map((match) => match[1])) {
    if (!anchors.has(target)) throw new Error(`Markdown table of contents contains an orphan target: ${target}.`)
  }
}

async function validateDocx(bytes: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(bytes)
  for (const required of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml']) {
    if (!zip.file(required)) throw new Error(`DOCX package is missing ${required}.`)
  }
  const documentXml = await zip.file('word/document.xml')!.async('string')
  if (!/<w:t[ >]/.test(documentXml)) throw new Error('DOCX contains no readable document text.')
  if (!/AKORITH RESEARCH/.test(documentXml)) throw new Error('DOCX is missing its Akorith cover.')
  if (!/<w:titlePg\b/.test(documentXml)) throw new Error('DOCX cover is not isolated as a first-page layout.')
  if (!/<w:pStyle w:val="Heading1"/.test(documentXml)) throw new Error('DOCX has no semantic Heading 1 structure.')
  if (/<w:trHeight\b[^>]*w:hRule="exact"/.test(documentXml)) throw new Error('DOCX contains an exact table-row height that can clip text.')
  const stylesXml = await zip.file('word/styles.xml')!.async('string')
  if (!/w:styleId="ResearchCoverTitle"/.test(stylesXml)) throw new Error('DOCX is missing its cover-title style.')
  const coreXml = await zip.file('docProps/core.xml')?.async('string')
  if (!coreXml || !/<dc:title>[^<]+<\/dc:title>/.test(coreXml) || !/<dc:subject>[^<]+<\/dc:subject>/.test(coreXml)) {
    throw new Error('DOCX is missing accessible title or subject metadata.')
  }
}

async function validateXlsx(bytes: Buffer): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  // ExcelJS models its input as an ArrayBuffer. Copy the filesystem buffer so
  // a SharedArrayBuffer-backed view can never cross the package boundary.
  const arrayBuffer = Uint8Array.from(bytes).buffer
  await workbook.xlsx.load(arrayBuffer)
  for (const required of ['Overview', 'Findings', 'Sources', 'Methodology']) {
    if (!workbook.getWorksheet(required)) throw new Error(`Workbook is missing its ${required} sheet.`)
  }
  const overview = workbook.getWorksheet('Overview')!
  if (!overview.getCell('B4').value) throw new Error('Workbook Overview has no report title.')
  const titleHeight = [4, 5, 6].reduce((total, row) => total + (overview.getRow(row).height ?? 15), 0)
  const titleWidth = [2, 3, 4].reduce((total, column) => total + (overview.getColumn(column).width ?? 12), 0)
  const requiredTitleHeight = estimateSpreadsheetRowHeight(overview.getCell('B4').text, titleWidth, 26, 72, 240)
  if (titleHeight + 1 < requiredTitleHeight) throw new Error('Workbook Overview title block can clip wrapped text.')
  const sources = workbook.getWorksheet('Sources')!
  sources.eachRow((row, index) => {
    if (index === 1) return
    row.eachCell((cell) => {
      if (typeof cell.value === 'string' && /^[=+\-@]/.test(cell.value)) {
        throw new Error('Workbook contains an unsafe formula-like external value.')
      }
    })
  })
  for (const sheet of workbook.worksheets) {
    if (sheet.views[0]?.showGridLines !== false) throw new Error(`Workbook sheet ${sheet.name} must hide default gridlines.`)
    sheet.eachRow((row, rowNumber) => {
      let required = 0
      row.eachCell((cell, columnNumber) => {
        if (!cell.alignment?.wrapText || cell.isMerged) return
        required = Math.max(required, estimateSpreadsheetRowHeight(
          cell.text,
          sheet.getColumn(columnNumber).width ?? 12,
          cell.font?.size ?? 10,
          0,
          400
        ))
      })
      if (required > 0 && (row.height ?? 15) + 1 < required) {
        throw new Error(`Workbook sheet ${sheet.name} row ${rowNumber} can clip wrapped text.`)
      }
    })
  }
}

async function validatePptx(bytes: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(bytes)
  for (const required of [
    '[Content_Types].xml',
    'ppt/presentation.xml',
    'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideLayouts/slideLayout1.xml',
    'ppt/theme/theme1.xml'
  ]) {
    if (!zip.file(required)) throw new Error(`PPTX package is missing ${required}.`)
  }
  const presentationXml = await zip.file('ppt/presentation.xml')!.async('string')
  const slideCount = [...presentationXml.matchAll(/<p:sldId\b/g)].length
  if (slideCount < 4) throw new Error('PowerPoint deck must contain at least four narrative slides.')
  const slideFiles = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((left, right) => slideNumber(left) - slideNumber(right))
  if (slideFiles.length !== slideCount) throw new Error('PowerPoint slide manifest does not match its slide files.')
  const slides = await Promise.all(slideFiles.map((path) => zip.file(path)!.async('string')))
  const titles = new Set<string>()
  slides.forEach((slide, index) => {
    const title = validatePptxSlideLayout(slide, index + 1)
    const key = title.toLocaleLowerCase('en-US')
    if (titles.has(key)) throw new Error(`PowerPoint slide ${index + 1} repeats the title "${title}".`)
    titles.add(key)
  })
  const readable = slides.join('\n')
  if (!/AKORITH[\s\S]{0,32}RESEARCH/.test(readable)) throw new Error('PowerPoint deck is missing its Akorith identity.')
  if (![...readable.matchAll(/<a:t\b[^>]*>[^<]{2,}<\/a:t>/g)].length) throw new Error('PowerPoint deck contains no readable text.')
}

const PPTX_SLIDE_WIDTH = 12_192_000
const PPTX_SLIDE_HEIGHT = 6_858_000
const EMU_PER_POINT = 12_700

function validatePptxSlideLayout(slideXml: string, slideNumberValue: number): string {
  if (/<a:spAutoFit\s*\/>/.test(slideXml)) {
    throw new Error(`PowerPoint slide ${slideNumberValue} relies on viewer-specific shape auto-fit.`)
  }
  const textRects: Array<{ name: string; x: number; y: number; width: number; height: number }> = []
  let slideTitle = ''
  for (const match of slideXml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
    const shape = match[1]
    const name = decodeXmlAttribute(/<p:cNvPr\b[^>]*\bname="([^"]*)"/.exec(shape)?.[1] ?? 'Unnamed shape')
    const description = /<p:cNvPr\b[^>]*\bdescr="([^"]+)"/.exec(shape)?.[1]
    const geometry = /<a:xfrm>\s*<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(shape)
    if (!geometry) continue
    const [, rawX, rawY, rawWidth, rawHeight] = geometry
    const x = Number(rawX)
    const y = Number(rawY)
    const width = Number(rawWidth)
    const height = Number(rawHeight)
    assertPptxBounds(slideNumberValue, name, x, y, width, height)
    if (!/<p:txBody>/.test(shape)) continue
    if (!description) throw new Error(`PowerPoint slide ${slideNumberValue} text box "${name}" has no description.`)
    if (!/<a:noAutofit\s*\/>/.test(shape)) {
      throw new Error(`PowerPoint slide ${slideNumberValue} text box "${name}" has no deterministic fit policy.`)
    }
    const wrapMode = /<a:bodyPr\b[^>]*\bwrap="([^"]+)"/.exec(shape)?.[1] ?? 'square'
    const criticalSingleLineLayout = new Set([
      'Presentation title',
      'Presentation subtitle',
      'Slide title',
      'Slide subtitle'
    ]).has(name)
    if (criticalSingleLineLayout && wrapMode !== 'none') {
      throw new Error(`PowerPoint slide ${slideNumberValue} text box "${name}" can be re-wrapped by the viewer.`)
    }
    const widthPoints = width / EMU_PER_POINT
    let requiredHeightPoints = 0
    for (const paragraph of shape.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
      const paragraphXml = paragraph[1]
      const text = [...paragraphXml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
        .map((item) => decodeXmlText(item[1]))
        .join('')
      if (!text) continue
      const size = Number(/<a:rPr\b[^>]*\bsz="(\d+)"/.exec(paragraphXml)?.[1] ?? 1800) / 100
      const leftMargin = Number(/<a:pPr\b[^>]*\bmarL="(\d+)"/.exec(paragraphXml)?.[1] ?? 0) / EMU_PER_POINT
      const availableWidth = Math.max(18, widthPoints - leftMargin)
      if (wrapMode === 'none' && estimatedTextWidth(text, size) > availableWidth * 0.9) {
        throw new Error(`PowerPoint slide ${slideNumberValue} no-wrap text box "${name}" can exceed its horizontal safe area.`)
      }
      const lines = wrapMode === 'none' ? 1 : estimateWrappedLineCount(text, availableWidth, size)
      const after = Number(/<a:spcAft><a:spcPts val="(\d+)"\/>/.exec(paragraphXml)?.[1] ?? 0) / 100
      requiredHeightPoints += lines * size * 1.12 + after
    }
    const availableHeightPoints = height / EMU_PER_POINT
    if (requiredHeightPoints > availableHeightPoints + 5) {
      throw new Error(
        `PowerPoint slide ${slideNumberValue} text box "${name}" needs ${requiredHeightPoints.toFixed(1)}pt but has ${availableHeightPoints.toFixed(1)}pt.`
      )
    }
    if (requiredHeightPoints > 0) {
      textRects.push({ name, x, y, width, height: Math.min(height, requiredHeightPoints * EMU_PER_POINT) })
    }
    if (name === 'Presentation title' || name === 'Slide title') {
      const expectedPlaceholder = name === 'Presentation title' ? 'ctrTitle' : 'title'
      if (!new RegExp(`<p:ph\\s+type="${expectedPlaceholder}"\\s*\\/>`).test(shape)) {
        throw new Error(
          `PowerPoint slide ${slideNumberValue} title "${name}" is not a real ${expectedPlaceholder} placeholder.`
        )
      }
      slideTitle = [...shape.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
        .map((item) => decodeXmlText(item[1]))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    }
  }
  for (const match of slideXml.matchAll(/<p:graphicFrame>([\s\S]*?)<\/p:graphicFrame>/g)) {
    const frame = match[1]
    const name = decodeXmlAttribute(/<p:cNvPr\b[^>]*\bname="([^"]*)"/.exec(frame)?.[1] ?? 'Unnamed table')
    const geometry = /<p:xfrm>\s*<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(frame)
    if (geometry) {
      assertPptxBounds(slideNumberValue, name, Number(geometry[1]), Number(geometry[2]), Number(geometry[3]), Number(geometry[4]))
    }
    if (/<a:spAutoFit\s*\/>/.test(frame)) throw new Error(`PowerPoint slide ${slideNumberValue} table "${name}" relies on auto-fit.`)
    if (/<a:tbl>/.test(frame) && !/<a:noAutofit\s*\/>/.test(frame)) {
      throw new Error(`PowerPoint slide ${slideNumberValue} table "${name}" has no deterministic fit policy.`)
    }
  }
  for (let leftIndex = 0; leftIndex < textRects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < textRects.length; rightIndex += 1) {
      const left = textRects[leftIndex]
      const right = textRects[rightIndex]
      const overlapWidth = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
      const overlapHeight = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
      if (overlapWidth > 18_000 && overlapHeight > 18_000) {
        throw new Error(`PowerPoint slide ${slideNumberValue} overlaps text boxes "${left.name}" and "${right.name}".`)
      }
    }
  }
  if (!slideTitle) throw new Error(`PowerPoint slide ${slideNumberValue} has no accessible slide title.`)
  return slideTitle
}

function assertPptxBounds(
  slideNumberValue: number,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > PPTX_SLIDE_WIDTH || y + height > PPTX_SLIDE_HEIGHT) {
    throw new Error(`PowerPoint slide ${slideNumberValue} shape "${name}" exceeds the slide canvas.`)
  }
}

function slideNumber(path: string): number {
  return Number(/slide(\d+)\.xml$/.exec(path)?.[1] ?? 0)
}

function decodeXmlAttribute(value: string): string {
  return decodeXmlText(value)
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
