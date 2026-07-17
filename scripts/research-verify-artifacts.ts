import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import JSZip from 'jszip'
import {
  EXPECTED_RESEARCH_FIXTURE_COUNT,
  RESEARCH_CORE_FIXTURE_MATRIX,
  TEST_RESEARCH_DEPTHS,
  TEST_RESEARCH_OUTPUTS,
  TEST_RESEARCH_PROVIDERS,
  createDeterministicResearchDocument
} from '../src/main/research/__tests__/fixture-matrix.ts'
import { createResearchCoverSvg } from '../src/main/research/cover.ts'
import { exportResearchDocx } from '../src/main/research/exporters/docx.ts'
import { exportResearchMarkdown } from '../src/main/research/exporters/markdown.ts'
import { exportResearchPdf } from '../src/main/research/exporters/pdf.ts'
import { validateResearchArtifact } from '../src/main/research/exporters/validate.ts'
import { exportResearchXlsx } from '../src/main/research/exporters/xlsx.ts'
import type { ResearchDocument } from '../src/main/research/document.ts'
import type { ResearchOutputFormat } from '../src/main/research/types.ts'

assert.equal(RESEARCH_CORE_FIXTURE_MATRIX.length, EXPECTED_RESEARCH_FIXTURE_COUNT)
assert.equal(
  EXPECTED_RESEARCH_FIXTURE_COUNT,
  TEST_RESEARCH_DEPTHS.length * TEST_RESEARCH_PROVIDERS.length * TEST_RESEARCH_OUTPUTS.length,
  'matrix must cover every bounded depth, provider class, and output format'
)

const tupleKeys = new Set(
  RESEARCH_CORE_FIXTURE_MATRIX.map((fixture) =>
    `${fixture.depth}:${fixture.providerClass}:${fixture.outputFormat}`
  )
)
assert.equal(tupleKeys.size, EXPECTED_RESEARCH_FIXTURE_COUNT, 'fixture dimension tuples must be unique')

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'akorith-research-artifacts-'))
  let generated = 0

  try {
    for (const fixture of RESEARCH_CORE_FIXTURE_MATRIX) {
      const workspace = join(root, fixture.id)
      mkdirSync(join(workspace, 'artifacts'), { recursive: true })
      const document = createDeterministicResearchDocument(fixture)
      const cover = createResearchCoverSvg(document)
      assert.match(cover, /width="794" height="1123"/, `${fixture.id} must retain an A4 portrait library cover`)
      assert.match(cover, /AKORITH RESEARCH/, `${fixture.id} cover must identify the Research library`)
      assert.match(cover, new RegExp(escapeRegExp(fixture.model)), `${fixture.id} cover must identify its model`)

      const path = await exportFixture(fixture.outputFormat, workspace, document)
      assert.equal(extname(path), `.${fixture.outputFormat}`, `${fixture.id} extension must match its selected format`)
      const validation = await validateResearchArtifact(fixture.outputFormat, path)
      assert.equal(validation.ok, true, `${fixture.id}: ${validation.error ?? 'artifact validation failed'}`)
      assert.ok(validation.byteSize > 100, `${fixture.id} must produce a non-empty report`)
      assert.match(validation.checksum, /^[a-f0-9]{64}$/, `${fixture.id} must have a SHA-256 integrity digest`)
      await verifyContainer(fixture.outputFormat, path, document)
      generated += 1
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  assert.equal(generated, EXPECTED_RESEARCH_FIXTURE_COUNT)
  console.log(`research artifact verifier passed (${generated} offline reports across four formats)`)
}

async function exportFixture(
  format: ResearchOutputFormat,
  workspace: string,
  document: ResearchDocument
): Promise<string> {
  if (format === 'md') return exportResearchMarkdown(workspace, document)
  if (format === 'pdf') return exportResearchPdf(workspace, document)
  if (format === 'docx') return exportResearchDocx(workspace, document)
  return exportResearchXlsx(workspace, document)
}

async function verifyContainer(
  format: ResearchOutputFormat,
  path: string,
  document: ResearchDocument
): Promise<void> {
  const bytes = readFileSync(path)
  if (format === 'pdf') {
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-', 'PDF must use the PDF file signature')
    assert.match(bytes.toString('latin1'), /\/Type\s*\/Page\b/, 'PDF must contain at least one page object')
    return
  }
  if (format === 'md') {
    const markdown = bytes.toString('utf8')
    assert.match(markdown, new RegExp(`^# ${escapeRegExp(document.title)}$`, 'm'))
    assert.match(markdown, /^## Executive summary$/m)
    assert.match(markdown, /^## Sources$/m)
    return
  }

  const zip = await JSZip.loadAsync(bytes)
  if (format === 'docx') {
    assert.ok(zip.file('[Content_Types].xml'), 'DOCX must contain the package content-types manifest')
    assert.ok(zip.file('word/document.xml'), 'DOCX must contain its Word document body')
    return
  }
  assert.ok(zip.file('xl/workbook.xml'), 'XLSX must contain a workbook manifest')
  assert.ok(zip.file('xl/worksheets/sheet1.xml'), 'XLSX must contain its overview worksheet')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

void main()
