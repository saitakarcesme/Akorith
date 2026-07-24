import { renameSync } from 'fs'
import ExcelJS from 'exceljs'
import type { ResearchDocument } from '../document'
import { researchVisualCitationNumbers } from '../visual-evidence'
import { researchArtifactPath } from '../workspace'
import {
  compactArtifactText,
  estimateSpreadsheetRowHeight,
  RESEARCH_ARTIFACT_DESIGN,
  splitArtifactProse
} from './design'

const COLORS = {
  ink: 'FF171A18',
  paper: 'FFF7F8F6',
  panel: 'FFE9ECE9',
  mint: 'FF78D6AA',
  mintDark: 'FF2F6D55',
  purple: 'FF7565B7',
  white: 'FFFFFFFF',
  muted: 'FF6D746F',
  red: 'FF9A534D'
}

const OFFICE_FONT = RESEARCH_ARTIFACT_DESIGN.fonts.office
const MAX_MERGED_ROW_HEIGHT = 180
const EXCEL_MAX_ROWS = 1_048_576

const PRINT_MARGINS = {
  left: 0.28,
  right: 0.28,
  top: 0.4,
  bottom: 0.4,
  header: 0.15,
  footer: 0.15
}

export async function exportResearchXlsx(
  workspaceDir: string,
  research: ResearchDocument,
  outputPath?: string
): Promise<string> {
  const path = outputPath ?? researchArtifactPath(workspaceDir, research.title, 'xlsx')
  const partial = `${path}.partial`
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Akorith Research'
  workbook.lastModifiedBy = 'Akorith Research'
  workbook.company = 'Akorith'
  workbook.category = 'Research report'
  workbook.keywords = 'research, evidence, sources, Akorith'
  workbook.description = research.subtitle
  workbook.created = new Date(research.generatedAt)
  workbook.modified = new Date(research.generatedAt)
  workbook.subject = research.subtitle
  workbook.title = research.title
  addOverviewSheet(workbook, research)
  addFindingsSheet(workbook, research)
  addSourcesSheet(workbook, research)
  addMethodologySheet(workbook, research)
  addVisualEvidenceSheet(workbook, research)
  await workbook.xlsx.writeFile(partial)
  renameSync(partial, path)
  return path
}

export function sanitizeSpreadsheetCell(value: string): string {
  const clean = value.replace(/\u0000/g, '').trim()
  return /^[=+\-@]/.test(clean) ? `'${clean}` : clean
}

function addOverviewSheet(workbook: ExcelJS.Workbook, research: ResearchDocument): void {
  const sheet = workbook.addWorksheet('Overview', {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: PRINT_MARGINS
    }
  })
  sheet.columns = [{ width: 4 }, { width: 22 }, { width: 58 }, { width: 24 }, { width: 4 }]
  sheet.mergeCells('B2:D2')
  const kicker = sheet.getCell('B2')
  kicker.value = 'AKORITH RESEARCH'
  kicker.font = { name: OFFICE_FONT, size: 11, bold: true, color: { argb: COLORS.mintDark } }
  kicker.alignment = { vertical: 'middle' }
  sheet.getRow(2).height = 24

  const titleStart = 4
  const titleEnd = mergeTextBlock(sheet, {
    startRow: titleStart,
    minimumRows: 3,
    value: research.title,
    widthCharacters: 104,
    fontSize: 26,
    minimumTotalHeight: 72
  })
  const title = sheet.getCell(titleStart, 2)
  title.value = sanitizeSpreadsheetCell(research.title)
  title.font = { name: OFFICE_FONT, size: 26, bold: true, color: { argb: COLORS.ink } }
  title.alignment = { vertical: 'middle', wrapText: true }

  const subtitleStart = titleEnd + 2
  const subtitleEnd = mergeTextBlock(sheet, {
    startRow: subtitleStart,
    minimumRows: 3,
    value: research.subtitle,
    widthCharacters: 104,
    fontSize: 13,
    minimumTotalHeight: 54
  })
  const subtitle = sheet.getCell(subtitleStart, 2)
  subtitle.value = sanitizeSpreadsheetCell(research.subtitle)
  subtitle.font = { name: OFFICE_FONT, size: 13, color: { argb: COLORS.muted } }
  subtitle.alignment = { vertical: 'top', wrapText: true }

  const metadata = [
    ['Depth', research.depthLabel],
    ['Provider', research.providerLabel],
    ['Model', research.modelLabel],
    ['Generated', new Date(research.generatedAt).toISOString()],
    ['Sources', research.sources.length],
    ['Claims', research.sections.reduce((total, section) => total + section.claims.length, 0)]
  ]
  const metadataStart = subtitleEnd + 3
  metadata.forEach(([label, value], index) => {
    const row = metadataStart + index
    sheet.getCell(row, 2).value = label
    sheet.getCell(row, 2).font = { bold: true, color: { argb: COLORS.muted } }
    sheet.mergeCells(row, 3, row, 4)
    sheet.getCell(row, 3).value = typeof value === 'string' ? sanitizeSpreadsheetCell(value) : value
    sheet.getCell(row, 3).font = { color: { argb: COLORS.ink } }
    sheet.getCell(row, 3).alignment = { vertical: 'middle', wrapText: true }
    sheet.getRow(row).height = Math.max(22, estimateSpreadsheetRowHeight(String(value), 82, 10, 22, 52))
  })

  const summaryHeadingRow = metadataStart + metadata.length + 2
  sheet.mergeCells(summaryHeadingRow, 2, summaryHeadingRow, 4)
  sheet.getCell(summaryHeadingRow, 2).value = 'EXECUTIVE SUMMARY'
  sheet.getCell(summaryHeadingRow, 2).font = { bold: true, color: { argb: COLORS.mintDark }, size: 11 }
  sheet.getRow(summaryHeadingRow).height = 24
  const summaryStart = summaryHeadingRow + 1
  const summaryEnd = mergeTextBlock(sheet, {
    startRow: summaryStart,
    minimumRows: 7,
    value: research.executiveSummary,
    widthCharacters: 104,
    fontSize: 12,
    minimumTotalHeight: 98
  })
  sheet.getCell(summaryStart, 2).value = sanitizeSpreadsheetCell(research.executiveSummary)
  sheet.getCell(summaryStart, 2).alignment = { vertical: 'top', wrapText: true }
  sheet.getCell(summaryStart, 2).font = { size: 12, color: { argb: COLORS.ink } }
  sheet.getCell('B2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEFE7' } }
  sheet.pageSetup.printArea = `A1:E${summaryEnd}`
  addPrintFooter(sheet)
}

function addFindingsSheet(workbook: ExcelJS.Workbook, research: ResearchDocument): void {
  const sheet = workbook.addWorksheet('Findings', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: PRINT_MARGINS,
      printTitlesRow: '1:1'
    }
  })
  sheet.columns = [
    { header: 'Section', key: 'section', width: 24 },
    { header: 'Claim', key: 'claim', width: 56 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Confidence', key: 'confidence', width: 14 },
    { header: 'Source IDs', key: 'sources', width: 24 }
  ]
  for (const section of research.sections) {
    const narrativeChunks = splitArtifactProse(section.body, 20_000)
    for (const [chunkIndex, chunk] of (narrativeChunks.length > 0 ? narrativeChunks : ['']).entries()) {
      sheet.addRow({
        section: sanitizeSpreadsheetCell(section.title),
        claim: sanitizeSpreadsheetCell(chunk),
        status: chunkIndex === 0 ? 'narrative' : 'narrative continued'
      })
    }
    for (const claim of section.claims) {
      const sources = claim.evidence.map((item) => {
        const index = research.sources.findIndex((source) => source.id === item.sourceId)
        return index >= 0 ? index + 1 : null
      }).filter((value): value is number => value !== null)
      sheet.addRow({
        section: sanitizeSpreadsheetCell(section.title),
        claim: sanitizeSpreadsheetCell(claim.text),
        status: claim.status,
        confidence: claim.confidenceScore,
        sources: sources.join(', ')
      })
    }
  }
  formatTableSheet(sheet)
  sheet.autoFilter = { from: 'A1', to: 'E1' }
  sheet.pageSetup.printArea = `A1:E${Math.max(1, sheet.rowCount)}`
  sheet.getColumn('confidence').numFmt = '0%'
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const status = String(row.getCell(3).value ?? '')
    const narrative = status.startsWith('narrative')
    row.getCell(3).font = {
      name: OFFICE_FONT,
      size: 10,
      bold: narrative,
      color: {
        argb: status === 'verified'
          ? COLORS.mintDark
          : status === 'conflicted'
            ? COLORS.purple
            : narrative
              ? COLORS.muted
              : COLORS.red
      }
    }
    row.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' }
    row.getCell(4).alignment = { horizontal: 'right', vertical: 'middle' }
    row.getCell(5).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  })
  addPrintFooter(sheet)
}

function addSourcesSheet(workbook: ExcelJS.Workbook, research: ResearchDocument): void {
  const sheet = workbook.addWorksheet('Sources', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: PRINT_MARGINS,
      printTitlesRow: '1:1'
    }
  })
  sheet.columns = [
    { header: '#', key: 'index', width: 7 },
    { header: 'Title', key: 'title', width: 46 },
    { header: 'Publisher', key: 'publisher', width: 24 },
    { header: 'URL', key: 'url', width: 52 },
    { header: 'Published', key: 'published', width: 16 },
    { header: 'Accessed', key: 'accessed', width: 16 },
    { header: 'Credibility', key: 'credibility', width: 14 },
    { header: 'Verified', key: 'verified', width: 12 },
    { header: 'Relevance', key: 'relevance', width: 42 }
  ]
  research.sources.forEach((source, index) => {
    const row = sheet.addRow({
      index: index + 1,
      title: sanitizeSpreadsheetCell(source.title),
      publisher: sanitizeSpreadsheetCell(source.publisher ?? ''),
      url: sanitizeSpreadsheetCell(source.url),
      published: sanitizeSpreadsheetCell(source.publishedAt ?? ''),
      accessed: new Date(source.accessedAt),
      credibility: source.credibilityScore ?? null,
      verified: source.verified ? 'Yes' : 'No',
      relevance: sanitizeSpreadsheetCell(source.relevance ?? '')
    })
    row.getCell(4).value = { text: source.url, hyperlink: source.url, tooltip: source.title }
  })
  formatTableSheet(sheet)
  sheet.autoFilter = { from: 'A1', to: 'I1' }
  sheet.pageSetup.printArea = `A1:I${Math.max(1, sheet.rowCount)}`
  sheet.getColumn('accessed').numFmt = 'yyyy-mm-dd'
  sheet.getColumn('credibility').numFmt = '0%'
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    row.getCell(4).font = { name: OFFICE_FONT, size: 10, color: { argb: COLORS.mintDark }, underline: true }
    for (const column of [1, 5, 6, 8]) row.getCell(column).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    row.getCell(7).alignment = { horizontal: 'right', vertical: 'middle' }
  })
  addPrintFooter(sheet)
}

function addMethodologySheet(workbook: ExcelJS.Workbook, research: ResearchDocument): void {
  const sheet = workbook.addWorksheet('Methodology', {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: PRINT_MARGINS
    }
  })
  sheet.columns = [{ width: 4 }, { width: 28 }, { width: 82 }, { width: 4 }]
  sectionHeading(sheet, 2, 'Research method')
  const methods = research.methodology.length > 0 ? research.methodology : ['No explicit methodology was recorded.']
  methods.forEach((item, index) => addMethodRow(sheet, 4 + index, index + 1, item))
  const verificationStart = 6 + methods.length
  sectionHeading(sheet, verificationStart, 'Verification criteria')
  const criteria = research.verificationCriteria.length > 0
    ? research.verificationCriteria
    : ['Claims without evidence remain visibly unverified.']
  criteria.forEach((item, index) => addMethodRow(sheet, verificationStart + 2 + index, index + 1, item))
  sheet.pageSetup.printArea = `A1:D${Math.max(1, sheet.rowCount)}`
  addPrintFooter(sheet)
}

function addVisualEvidenceSheet(workbook: ExcelJS.Workbook, research: ResearchDocument): void {
  const sheet = workbook.addWorksheet('Visual Evidence', {
    views: [{ state: 'frozen', ySplit: 3, showGridLines: false }],
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: PRINT_MARGINS,
      printTitlesRow: '1:3'
    }
  })
  sheet.columns = [
    { width: 3 }, { width: 31 },
    ...Array.from({ length: 10 }, () => ({ width: 5 })),
    { width: 14 }, { width: 18 }, { width: 3 }
  ]
  sheet.mergeCells('B1:N1')
  sheet.getCell('B1').value = 'VISUAL EVIDENCE'
  sheet.getCell('B1').font = { name: OFFICE_FONT, size: 24, bold: true, color: { argb: COLORS.ink } }
  sheet.getCell('B1').border = { bottom: { style: 'medium', color: { argb: COLORS.mint } } }
  sheet.getRow(1).height = 38
  sheet.mergeCells('B2:N2')
  sheet.getCell('B2').value = 'Every chart, table, and source snapshot below is derived from persisted cited evidence.'
  sheet.getCell('B2').font = { name: OFFICE_FONT, size: 10, color: { argb: COLORS.muted } }
  sheet.getRow(2).height = 24

  let row = 4
  for (const [figureIndex, visual] of research.visuals.entries()) {
    sheet.mergeCells(row, 2, row, 14)
    const title = sheet.getCell(row, 2)
    title.value = `Figure ${figureIndex + 1}. ${sanitizeSpreadsheetCell(visual.title)}`
    title.font = { name: OFFICE_FONT, size: 15, bold: true, color: { argb: COLORS.ink } }
    title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F3EE' } }
    title.alignment = { vertical: 'middle', wrapText: true }
    sheet.getRow(row).height = estimateSpreadsheetRowHeight(title.text, 113, 15, 28, 58)
    row += 1

    if ((visual.kind === 'quantitative-chart' || visual.kind === 'source-quality-chart') && visual.points) {
      const max = Math.max(1, ...visual.points.map((point) => Math.abs(point.value)))
      for (const point of visual.points) {
        sheet.getCell(row, 2).value = sanitizeSpreadsheetCell(point.label)
        sheet.getCell(row, 2).alignment = { wrapText: true, vertical: 'middle' }
        sheet.getCell(row, 2).font = { name: OFFICE_FONT, size: 9, bold: true, color: { argb: COLORS.ink } }
        const filled = Math.max(1, Math.round((Math.abs(point.value) / max) * 10))
        for (let segment = 0; segment < 10; segment += 1) {
          const cell = sheet.getCell(row, 3 + segment)
          cell.value = segment < filled ? 1 : 0
          cell.numFmt = ';;;'
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: segment < filled ? COLORS.mint : COLORS.panel }
          }
          cell.border = { right: { style: 'hair', color: { argb: COLORS.white } } }
        }
        sheet.getCell(row, 13).value = point.value
        sheet.getCell(row, 13).numFmt = point.unit === '%' ? `0"%"` : '0.0'
        sheet.getCell(row, 13).alignment = { horizontal: 'right', vertical: 'middle' }
        sheet.getCell(row, 13).font = { bold: true, color: { argb: COLORS.ink } }
        const refs = researchVisualCitationNumbers(point.sourceIds, research.sources)
        sheet.getCell(row, 14).value = refs.map((ref) => `[${ref}]`).join(', ')
        sheet.getCell(row, 14).font = { color: { argb: COLORS.muted }, size: 9 }
        sheet.getRow(row).height = estimateSpreadsheetRowHeight(point.label, 31, 9, 30, 132)
        row += 1
      }
    } else if (visual.kind === 'evidence-table' && visual.columns && visual.rows) {
      const ranges = [[2, 5], [6, 8], [9, 10], [11, 12], [13, 14]] as const
      visual.columns.forEach((column, index) => {
        const [start, end] = ranges[index]
        sheet.mergeCells(row, start, row, end)
        const cell = sheet.getCell(row, start)
        cell.value = column
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.ink } }
        cell.font = { bold: true, color: { argb: COLORS.white }, size: 9 }
        cell.alignment = { vertical: 'middle' }
      })
      sheet.getRow(row).height = 25
      row += 1
      visual.rows.forEach((tableRow, tableRowIndex) => {
        let requiredHeight = 30
        const effectiveWidths = [46, 15, 10, 10, 32]
        tableRow.cells.forEach((value, index) => {
          const [start, end] = ranges[index]
          sheet.mergeCells(row, start, row, end)
          const cell = sheet.getCell(row, start)
          cell.value = sanitizeSpreadsheetCell(value)
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tableRowIndex % 2 === 0 ? COLORS.paper : COLORS.white } }
          cell.font = { color: { argb: COLORS.ink }, size: 9 }
          cell.alignment = { vertical: 'middle', wrapText: true }
          cell.border = { bottom: { style: 'hair', color: { argb: COLORS.panel } } }
          requiredHeight = Math.max(requiredHeight, estimateSpreadsheetRowHeight(value, effectiveWidths[index] ?? 18, 9, 30, 200))
        })
        sheet.getRow(row).height = requiredHeight
        row += 1
      })
    } else if (visual.kind === 'web-snapshot' && visual.snapshot) {
      const snapshot = visual.snapshot
      sheet.mergeCells(row, 2, row, 14)
      sheet.getCell(row, 2).value = sanitizeSpreadsheetCell(`${snapshot.publisher} · ${snapshot.title}`)
      sheet.getCell(row, 2).font = { bold: true, size: 12, color: { argb: COLORS.ink } }
      sheet.getCell(row, 2).alignment = { wrapText: true, vertical: 'middle' }
      sheet.getRow(row).height = estimateSpreadsheetRowHeight(`${snapshot.publisher} · ${snapshot.title}`, 113, 12, 32, 120)
      row += 1
      sheet.mergeCells(row, 2, row, 14)
      const displayedExcerpt = compactSpreadsheetText(snapshot.excerpt, 560)
      sheet.getCell(row, 2).value = sanitizeSpreadsheetCell(displayedExcerpt)
      sheet.getCell(row, 2).font = { size: 10, color: { argb: 'FF343B37' } }
      sheet.getCell(row, 2).alignment = { wrapText: true, vertical: 'top' }
      sheet.getCell(row, 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paper } }
      sheet.getRow(row).height = estimateSpreadsheetRowHeight(displayedExcerpt, 113, 10, 54, 220)
      row += 1
      sheet.mergeCells(row, 2, row, 14)
      sheet.getCell(row, 2).value = { text: snapshot.url, hyperlink: snapshot.url, tooltip: snapshot.title }
      sheet.getCell(row, 2).font = { color: { argb: COLORS.mintDark }, underline: true, size: 9 }
      sheet.getRow(row).height = 22
      row += 1
    }

    sheet.mergeCells(row, 2, row, 14)
    const references = researchVisualCitationNumbers(visual.provenance.sourceIds, research.sources)
    sheet.getCell(row, 2).value = sanitizeSpreadsheetCell(
      `${visual.caption} Provenance: ${visual.provenance.method}${references.length > 0 ? ` · sources ${references.map((ref) => `[${ref}]`).join(', ')}` : ''}`
    )
    sheet.getCell(row, 2).font = { italic: true, size: 9, color: { argb: COLORS.muted } }
    sheet.getCell(row, 2).alignment = { wrapText: true, vertical: 'top' }
    sheet.getRow(row).height = estimateSpreadsheetRowHeight(sheet.getCell(row, 2).text, 113, 9, 38, 160)
    row += 2
  }

  sheet.pageSetup.printArea = `A1:O${Math.max(3, row)}`
  addPrintFooter(sheet)
}

function formatTableSheet(sheet: ExcelJS.Worksheet): void {
  sheet.getRow(1).height = 28
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.ink } }
    cell.font = { name: OFFICE_FONT, size: 11, bold: true, color: { argb: COLORS.white } }
    cell.alignment = { vertical: 'middle' }
  })
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    row.alignment = { vertical: 'top', wrapText: true }
    let requiredHeight = 26
    row.eachCell((cell, columnNumber) => {
      cell.font = { name: OFFICE_FONT, size: 10, color: { argb: COLORS.ink } }
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: rowNumber % 2 === 0 ? COLORS.paper : 'FFFFFFFF' }
      }
      cell.border = { bottom: { style: 'hair', color: { argb: COLORS.panel } } }
      requiredHeight = Math.max(requiredHeight, estimateSpreadsheetRowHeight(
        cell.text,
        sheet.getColumn(columnNumber).width ?? 12,
        10,
        26,
        400
      ))
    })
    row.height = requiredHeight
  })
}

function sectionHeading(sheet: ExcelJS.Worksheet, row: number, text: string): void {
  sheet.mergeCells(row, 2, row, 3)
  const cell = sheet.getCell(row, 2)
  cell.value = text
  cell.font = { name: OFFICE_FONT, size: 20, bold: true, color: { argb: COLORS.ink } }
  cell.border = { bottom: { style: 'medium', color: { argb: COLORS.mint } } }
  sheet.getRow(row).height = 34
}

function addMethodRow(sheet: ExcelJS.Worksheet, row: number, index: number, text: string): void {
  sheet.getCell(row, 2).value = index
  sheet.getCell(row, 2).font = { name: OFFICE_FONT, size: 10, bold: true, color: { argb: COLORS.mintDark } }
  sheet.getCell(row, 3).value = sanitizeSpreadsheetCell(text)
  sheet.getCell(row, 3).font = { name: OFFICE_FONT, size: 10, color: { argb: COLORS.ink } }
  sheet.getCell(row, 3).alignment = { wrapText: true, vertical: 'top' }
  sheet.getRow(row).height = estimateSpreadsheetRowHeight(text, 82, 10, 28, 180)
}

function compactSpreadsheetText(value: string, max: number): string {
  return compactArtifactText(value, max)
}

function mergeTextBlock(
  sheet: ExcelJS.Worksheet,
  input: {
    startRow: number
    minimumRows: number
    value: string
    widthCharacters: number
    fontSize: number
    minimumTotalHeight: number
  }
): number {
  const requiredHeight = estimateSpreadsheetRowHeight(
    input.value,
    input.widthCharacters,
    input.fontSize,
    input.minimumTotalHeight,
    EXCEL_MAX_ROWS * MAX_MERGED_ROW_HEIGHT
  )
  const rowCount = Math.max(input.minimumRows, Math.ceil(requiredHeight / MAX_MERGED_ROW_HEIGHT))
  const endRow = input.startRow + rowCount - 1
  if (endRow > EXCEL_MAX_ROWS) throw new Error('Research text exceeds the Excel worksheet row limit.')
  sheet.mergeCells(input.startRow, 2, endRow, 4)
  const perRow = Math.max(15, Math.ceil(requiredHeight / rowCount))
  for (let row = input.startRow; row <= endRow; row += 1) sheet.getRow(row).height = perRow
  return endRow
}

function addPrintFooter(sheet: ExcelJS.Worksheet): void {
  const footer = '&LAkorith Research&RPage &P of &N'
  sheet.headerFooter.oddFooter = footer
  sheet.headerFooter.evenFooter = footer
}
