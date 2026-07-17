import { renameSync } from 'fs'
import ExcelJS from 'exceljs'
import type { ResearchDocument } from '../document'
import { researchArtifactPath } from '../workspace'

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

export async function exportResearchXlsx(workspaceDir: string, research: ResearchDocument): Promise<string> {
  const path = researchArtifactPath(workspaceDir, research.title, 'xlsx')
  const partial = `${path}.partial`
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Akorith Research'
  workbook.created = new Date(research.generatedAt)
  workbook.subject = research.subtitle
  workbook.title = research.title
  addOverviewSheet(workbook, research)
  addFindingsSheet(workbook, research)
  addSourcesSheet(workbook, research)
  addMethodologySheet(workbook, research)
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
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  })
  sheet.columns = [{ width: 4 }, { width: 22 }, { width: 58 }, { width: 24 }, { width: 4 }]
  sheet.mergeCells('B2:D2')
  const kicker = sheet.getCell('B2')
  kicker.value = 'AKORITH RESEARCH'
  kicker.font = { name: 'Aptos', size: 11, bold: true, color: { argb: COLORS.mintDark } }
  kicker.alignment = { vertical: 'middle' }
  sheet.getRow(2).height = 24
  sheet.mergeCells('B4:D6')
  const title = sheet.getCell('B4')
  title.value = sanitizeSpreadsheetCell(research.title)
  title.font = { name: 'Aptos Display', size: 26, bold: true, color: { argb: COLORS.ink } }
  title.alignment = { vertical: 'middle', wrapText: true }
  sheet.mergeCells('B8:D10')
  const subtitle = sheet.getCell('B8')
  subtitle.value = sanitizeSpreadsheetCell(research.subtitle)
  subtitle.font = { name: 'Aptos', size: 13, color: { argb: COLORS.muted } }
  subtitle.alignment = { vertical: 'top', wrapText: true }
  const metadata = [
    ['Depth', research.depthLabel],
    ['Provider', research.providerLabel],
    ['Model', research.modelLabel],
    ['Generated', new Date(research.generatedAt).toISOString()],
    ['Sources', research.sources.length],
    ['Claims', research.sections.reduce((total, section) => total + section.claims.length, 0)]
  ]
  metadata.forEach(([label, value], index) => {
    const row = 13 + index
    sheet.getCell(row, 2).value = label
    sheet.getCell(row, 2).font = { bold: true, color: { argb: COLORS.muted } }
    sheet.mergeCells(row, 3, row, 4)
    sheet.getCell(row, 3).value = typeof value === 'string' ? sanitizeSpreadsheetCell(value) : value
    sheet.getCell(row, 3).font = { color: { argb: COLORS.ink } }
  })
  sheet.mergeCells('B21:D21')
  sheet.getCell('B21').value = 'EXECUTIVE SUMMARY'
  sheet.getCell('B21').font = { bold: true, color: { argb: COLORS.mintDark }, size: 11 }
  sheet.mergeCells('B22:D28')
  sheet.getCell('B22').value = sanitizeSpreadsheetCell(research.executiveSummary)
  sheet.getCell('B22').alignment = { vertical: 'top', wrapText: true }
  sheet.getCell('B22').font = { size: 12, color: { argb: COLORS.ink } }
  sheet.getCell('B2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEFE7' } }
}

function addFindingsSheet(workbook: ExcelJS.Workbook, research: ResearchDocument): void {
  const sheet = workbook.addWorksheet('Findings', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }]
  })
  sheet.columns = [
    { header: 'Section', key: 'section', width: 24 },
    { header: 'Claim', key: 'claim', width: 56 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Confidence', key: 'confidence', width: 14 },
    { header: 'Source IDs', key: 'sources', width: 24 }
  ]
  for (const section of research.sections) {
    if (section.claims.length === 0) {
      sheet.addRow({ section: sanitizeSpreadsheetCell(section.title), claim: sanitizeSpreadsheetCell(section.body), status: 'narrative' })
      continue
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
  sheet.getColumn('confidence').numFmt = '0%'
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const status = String(row.getCell(3).value ?? '')
    row.getCell(3).font = { color: { argb: status === 'verified' ? COLORS.mintDark : status === 'conflicted' ? COLORS.purple : COLORS.red } }
  })
}

function addSourcesSheet(workbook: ExcelJS.Workbook, research: ResearchDocument): void {
  const sheet = workbook.addWorksheet('Sources', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }]
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
    row.getCell(4).font = { color: { argb: COLORS.mintDark }, underline: true }
  })
  formatTableSheet(sheet)
  sheet.autoFilter = { from: 'A1', to: 'I1' }
  sheet.getColumn('accessed').numFmt = 'yyyy-mm-dd'
  sheet.getColumn('credibility').numFmt = '0%'
}

function addMethodologySheet(workbook: ExcelJS.Workbook, research: ResearchDocument): void {
  const sheet = workbook.addWorksheet('Methodology', { views: [{ showGridLines: false }] })
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
}

function formatTableSheet(sheet: ExcelJS.Worksheet): void {
  sheet.getRow(1).height = 28
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.ink } }
    cell.font = { name: 'Aptos', size: 11, bold: true, color: { argb: COLORS.white } }
    cell.alignment = { vertical: 'middle' }
  })
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    row.alignment = { vertical: 'top', wrapText: true }
    row.height = 34
    row.eachCell((cell) => {
      cell.font = { name: 'Aptos', size: 10, color: { argb: COLORS.ink } }
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: rowNumber % 2 === 0 ? COLORS.paper : 'FFFFFFFF' }
      }
      cell.border = { bottom: { style: 'hair', color: { argb: COLORS.panel } } }
    })
  })
}

function sectionHeading(sheet: ExcelJS.Worksheet, row: number, text: string): void {
  sheet.mergeCells(row, 2, row, 3)
  const cell = sheet.getCell(row, 2)
  cell.value = text
  cell.font = { name: 'Aptos Display', size: 20, bold: true, color: { argb: COLORS.ink } }
  cell.border = { bottom: { style: 'medium', color: { argb: COLORS.mint } } }
  sheet.getRow(row).height = 34
}

function addMethodRow(sheet: ExcelJS.Worksheet, row: number, index: number, text: string): void {
  sheet.getCell(row, 2).value = index
  sheet.getCell(row, 2).font = { bold: true, color: { argb: COLORS.mintDark } }
  sheet.getCell(row, 3).value = sanitizeSpreadsheetCell(text)
  sheet.getCell(row, 3).alignment = { wrapText: true, vertical: 'top' }
  sheet.getRow(row).height = 32
}
