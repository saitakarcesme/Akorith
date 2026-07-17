import { createHash } from 'crypto'
import { createRequire } from 'module'
import { readFileSync, statSync } from 'fs'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import type { ResearchOutputFormat } from '../types'

const require = createRequire(__filename)
const pdfParse = require('pdf-parse') as (buffer: Buffer) => Promise<{ text: string; numpages: number }>

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
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
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
      const parsed = await pdfParse(bytes)
      if (parsed.numpages < 2) throw new Error('PDF is missing its cover or report pages.')
      if (parsed.text.trim().length < 80) throw new Error('PDF contains too little readable report text.')
      return { ok: true, ...base, pageCount: parsed.numpages }
    }
    if (format === 'docx') await validateDocx(bytes)
    if (format === 'xlsx') await validateXlsx(bytes)
    return { ok: true, ...base }
  } catch (error) {
    return {
      ok: false,
      ...base,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function validateMarkdown(markdown: string): void {
  if (!/^#\s+\S/m.test(markdown)) throw new Error('Markdown report has no title.')
  if (!/^##\s+Executive summary\s*$/im.test(markdown)) throw new Error('Markdown report has no executive summary.')
  if (!/^##\s+Sources\s*$/im.test(markdown)) throw new Error('Markdown report has no Sources section.')
  const refs = [...markdown.matchAll(/\[\d+\]\(#source-(\d+)\)/g)].map((match) => match[1])
  for (const ref of refs) {
    if (!markdown.includes(`<a id="source-${ref}"></a>`)) throw new Error(`Markdown contains an orphan source reference: ${ref}.`)
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
  const sources = workbook.getWorksheet('Sources')!
  sources.eachRow((row, index) => {
    if (index === 1) return
    row.eachCell((cell) => {
      if (typeof cell.value === 'string' && /^[=+\-@]/.test(cell.value)) {
        throw new Error('Workbook contains an unsafe formula-like external value.')
      }
    })
  })
}
