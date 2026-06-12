// Phase 8: ISAScore evaluation + PDF reports.
//
// Evaluations consume persisted Phase 7 test_runs. They never re-run tests and
// never write usage_events: the optional quality judge is a meta call made
// directly through a provider, recorded only on the evaluation row.

import { app, ipcMain, shell } from 'electron'
import { createRequire } from 'module'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative } from 'path'
import { getIsaScoreSettings, type IsaScoreWeights } from './config'
import {
  createEvaluation,
  getEvaluation,
  getTestRunsByIds,
  listEvaluations,
  setEvaluationPdfPath,
  type EvaluationRow,
  type TestRunRow
} from './db'
import { sendMetaPrompt } from './providers/registry'

const require = createRequire(__filename)
const PDFDocument = require('pdfkit') as new (options?: Record<string, unknown>) => PdfDoc

const VALID_ID = /^[\w-]{1,64}$/
const MAX_RUNS = 12
const CODE_EXCERPT_CHARS = 12_000
const PDF_CODE_CHARS = 6_000
const QUALITY_TIMEOUT_MS = 300_000

type DimensionName = 'tests' | 'speed' | 'tokens' | 'quality'

interface PdfDoc {
  page: { width: number; height: number; margins: { left: number; right: number; top: number; bottom: number } }
  y: number
  pipe(stream: NodeJS.WritableStream): void
  on(event: 'error', listener: (err: Error) => void): void
  end(): void
  addPage(): PdfDoc
  font(name: string): PdfDoc
  fontSize(size: number): PdfDoc
  fillColor(color: string): PdfDoc
  strokeColor(color: string): PdfDoc
  lineWidth(width: number): PdfDoc
  moveTo(x: number, y: number): PdfDoc
  lineTo(x: number, y: number): PdfDoc
  stroke(): PdfDoc
  rect(x: number, y: number, width: number, height: number): PdfDoc
  fill(color?: string): PdfDoc
  text(text: string, ...args: unknown[]): PdfDoc
  moveDown(lines?: number): PdfDoc
}

interface GeneratedFile {
  path: string
  content: string
}

export interface DimensionScore {
  score: number | null
  weight: number
  effectiveWeight: number
  value: string
  formula: string
  omitted?: boolean
}

export interface RunScore {
  testRunId: string
  model: string
  providerId: string | null
  status: string | null
  objective: {
    passed: number | null
    failed: number | null
    errored: number | null
    passRate: number | null
    durationMs: number | null
    tokens: number | null
  }
  dimensions: Record<DimensionName, DimensionScore>
  totalScore: number
  qualityRationale?: string
  rank?: number
}

export interface EvaluationScores {
  version: 1
  formulas: {
    tests: string
    speed: string
    tokens: string
    quality: string
    total: string
  }
  qualityRequested: boolean
  qualityIncluded: boolean
  qualityFailure?: string
  judgeUsage?: {
    promptTokens?: number
    completionTokens?: number
    costUsd?: number
    estimated: boolean
  }
  codeAvailability: Record<string, string[]>
  runs: RunScore[]
}

interface EvaluateArgs {
  testRunIds: string[]
  includeQuality: boolean
  judgeProviderId?: string
  judgeModel?: string
}

type EvaluateResponse = { ok: true; evaluation: EvaluationRow } | { ok: false; error: string }
type PdfResponse = { ok: true; evaluation: EvaluationRow; pdfPath: string } | { ok: false; error: string }

function round(n: number): number {
  return Math.round(n * 10) / 10
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0
  return round(Math.min(100, Math.max(0, n)))
}

function formatScore(n: number | null): string {
  return n === null ? 'omitted' : n.toFixed(1)
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 32)) + '\n... [excerpt truncated]'
}

function safeDate(ts: number): string {
  return new Date(ts).toLocaleString()
}

function modelLabel(run: TestRunRow): string {
  return run.model || run.providerId || run.id.slice(0, 8)
}

function passRate(run: TestRunRow): number | null {
  const passed = run.passed ?? 0
  const failed = run.failed ?? 0
  const errored = run.errored ?? 0
  const total = passed + failed + errored
  return total > 0 ? passed / total : null
}

function testsScore(run: TestRunRow): DimensionScore {
  const rate = passRate(run)
  const fatal = new Set(['install-failed', 'timeout', 'aborted', 'no-tests'])
  const score = fatal.has(run.status ?? '') ? 0 : rate === null ? 0 : clampScore(rate * 100)
  return {
    score,
    weight: 0,
    effectiveWeight: 0,
    value: rate === null ? `${run.status ?? 'unknown'}; no parsed test count` : `${Math.round(rate * 100)}% pass rate`,
    formula: 'passed / (passed + failed + errored), with install/timeout/abort/no-tests forced to 0'
  }
}

function omitted(weight: number, value: string, formula: string): DimensionScore {
  return { score: null, weight, effectiveWeight: 0, value, formula, omitted: true }
}

interface QualityResult {
  scores: Map<string, { score: number; rationale?: string }>
  overallRationale: string | null
  judgeModel: string
  usage?: EvaluationScores['judgeUsage']
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  return JSON.parse(candidate.trim())
}

function parseQualityJson(text: string, rows: TestRunRow[]): { scores: QualityResult['scores']; rationale: string | null } {
  const parsed = extractJson(text) as {
    qualityScore?: unknown
    rationale?: unknown
    overallRationale?: unknown
    runs?: { testRunId?: unknown; qualityScore?: unknown; score?: unknown; rationale?: unknown }[]
  }
  const scores = new Map<string, { score: number; rationale?: string }>()

  if (Array.isArray(parsed.runs)) {
    for (const item of parsed.runs) {
      const id = typeof item.testRunId === 'string' ? item.testRunId : ''
      const raw = typeof item.qualityScore === 'number' ? item.qualityScore : item.score
      if (!VALID_ID.test(id) || typeof raw !== 'number') continue
      scores.set(id, {
        score: clampScore(raw),
        rationale: typeof item.rationale === 'string' ? item.rationale.slice(0, 1_500) : undefined
      })
    }
  } else if (rows.length === 1 && typeof parsed.qualityScore === 'number') {
    scores.set(rows[0].id, {
      score: clampScore(parsed.qualityScore),
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 1_500) : undefined
    })
  }

  const rationale =
    typeof parsed.overallRationale === 'string'
      ? parsed.overallRationale.slice(0, 2_000)
      : typeof parsed.rationale === 'string'
        ? parsed.rationale.slice(0, 2_000)
        : null

  if (scores.size === 0) throw new Error('judge JSON did not include usable quality scores')
  return { scores, rationale }
}

function readStoredGeneratedFiles(run: TestRunRow): GeneratedFile[] {
  if (run.generatedFiles && run.generatedFiles.length > 0) return run.generatedFiles
  return findGeneratedFilesInSandbox(run.sandboxPath)
}

function findGeneratedFilesInSandbox(sandboxPath: string | null): GeneratedFile[] {
  if (!sandboxPath || !existsSync(sandboxPath)) return []
  const deny = new Set(['.git', 'node_modules', 'dist', 'out', '.venv', 'venv', '__pycache__'])
  const found: GeneratedFile[] = []
  const match = /(loopex.*generated|generated.*test|test_loopex|\.test\.|_test)/i

  const walk = (dir: string, depth: number): void => {
    if (depth > 5 || found.length >= 6) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (deny.has(name) || found.length >= 6) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full, depth + 1)
      } else if (st.isFile() && st.size <= 500_000 && match.test(name)) {
        try {
          found.push({ path: relative(sandboxPath, full), content: readFileSync(full, 'utf8') })
        } catch {
          /* ignore unreadable files */
        }
      }
    }
  }

  walk(sandboxPath, 0)
  return found
}

function qualityPrompt(rows: TestRunRow[], codeByRun: Map<string, GeneratedFile[]>): string {
  const runBlocks = rows
    .map((run) => {
      const files = codeByRun.get(run.id) ?? []
      const code =
        files.length > 0
          ? files
              .map((f) => `File: ${f.path}\n\`\`\`\n${cap(f.content, CODE_EXCERPT_CHARS)}\n\`\`\``)
              .join('\n\n')
          : 'Generated test code was not available in the retained sandbox metadata.'
      return `Run ${run.id}
Model: ${modelLabel(run)}
Framework: ${run.framework ?? 'unknown'}
Status: ${run.status ?? 'unknown'}
Passed/failed/errored: ${run.passed ?? 0}/${run.failed ?? 0}/${run.errored ?? 0}
Duration ms: ${run.durationMs ?? 'unknown'}
Tokens: ${run.tokens ?? 'unknown'}
Raw output excerpt:
\`\`\`
${cap(run.rawOutput ?? '', 4_000)}
\`\`\`
Generated test code:
${code}`
    })
    .join('\n\n---\n\n')

  return `You are judging generated tests for Akorith ISAScore quality.

Score ONLY the QUALITY dimension from 0 to 100 for each run. Criteria:
- coverage intent: meaningful behavior and edge cases targeted
- readability: clear, maintainable test structure
- assertion correctness: assertions would catch regressions and are not vacuous
- idiomatic framework use: uses the detected test framework naturally

Do not re-score pass rate, speed, or token efficiency. Return ONLY valid JSON in this schema:
{
  "runs": [
    { "testRunId": "string", "qualityScore": 0, "rationale": "short reason" }
  ],
  "overallRationale": "short comparison or single-run rationale"
}

Runs:
${runBlocks}`
}

async function judgeQuality(args: EvaluateArgs, rows: TestRunRow[], codeByRun: Map<string, GeneratedFile[]>): Promise<QualityResult> {
  if (!args.judgeProviderId) throw new Error('quality judge provider was not selected')
  const result = await sendMetaPrompt(
    args.judgeProviderId,
    args.judgeModel || undefined,
    qualityPrompt(rows, codeByRun),
    AbortSignal.timeout(QUALITY_TIMEOUT_MS)
  )
  const parsed = parseQualityJson(result.text, rows)
  return {
    scores: parsed.scores,
    overallRationale: parsed.rationale,
    judgeModel: `${args.judgeProviderId}:${result.model}`,
    usage: result.usage
  }
}

function computeScores(
  rows: TestRunRow[],
  weights: IsaScoreWeights,
  quality: QualityResult | null,
  qualityRequested: boolean,
  qualityFailure: string | undefined,
  codeByRun: Map<string, GeneratedFile[]>
): EvaluationScores {
  const durations = rows.map((r) => r.durationMs).filter((n): n is number => typeof n === 'number' && n > 0)
  const tokens = rows.map((r) => r.tokens).filter((n): n is number => typeof n === 'number' && n > 0)
  const fastest = durations.length ? Math.min(...durations) : null
  const leanest = tokens.length ? Math.min(...tokens) : null

  const runs = rows.map((run): RunScore => {
    const dimensions: Record<DimensionName, DimensionScore> = {
      tests: { ...testsScore(run), weight: weights.tests },
      speed:
        fastest && run.durationMs && run.durationMs > 0
          ? {
              score: clampScore((fastest / run.durationMs) * 100),
              weight: weights.speed,
              effectiveWeight: 0,
              value: `${run.durationMs}ms; fastest selected run ${fastest}ms`,
              formula: 'fastest selected duration / this duration * 100'
            }
          : omitted(weights.speed, 'duration missing', 'fastest selected duration / this duration * 100'),
      tokens:
        leanest && run.tokens && run.tokens > 0
          ? {
              score: clampScore((leanest / run.tokens) * 100),
              weight: weights.tokens,
              effectiveWeight: 0,
              value: `${run.tokens} tokens; lowest selected run ${leanest} tokens`,
              formula: 'lowest selected token count / this token count * 100'
            }
          : omitted(weights.tokens, 'token count missing', 'lowest selected token count / this token count * 100'),
      quality: quality?.scores.has(run.id)
        ? {
            score: quality.scores.get(run.id)!.score,
            weight: weights.quality,
            effectiveWeight: 0,
            value: 'LLM quality judge',
            formula: 'judge score on coverage intent, readability, assertion correctness, idiomatic framework use'
          }
        : omitted(
            weights.quality,
            qualityRequested ? qualityFailure ?? 'quality judge omitted this run' : 'quality skipped',
            'optional judge score'
          )
    }

    const active = Object.values(dimensions).filter((d) => d.score !== null && d.weight > 0)
    const weightSum = active.reduce((sum, d) => sum + d.weight, 0)
    let total = 0
    for (const d of active) {
      d.effectiveWeight = weightSum > 0 ? d.weight / weightSum : 0
      total += (d.score ?? 0) * d.effectiveWeight
    }

    return {
      testRunId: run.id,
      model: modelLabel(run),
      providerId: run.providerId,
      status: run.status,
      objective: {
        passed: run.passed,
        failed: run.failed,
        errored: run.errored,
        passRate: passRate(run),
        durationMs: run.durationMs,
        tokens: run.tokens
      },
      dimensions,
      totalScore: clampScore(total),
      qualityRationale: quality?.scores.get(run.id)?.rationale
    }
  })

  const ranked = [...runs].sort((a, b) => b.totalScore - a.totalScore)
  ranked.forEach((run, idx) => {
    run.rank = idx + 1
  })

  return {
    version: 1,
    formulas: {
      tests: 'passed / (passed + failed + errored) * 100; install-failed, timeout, aborted, and no-tests score 0',
      speed: 'fastest selected run duration / this run duration * 100; missing duration omitted',
      tokens: 'lowest selected run token count / this run token count * 100; missing tokens omitted',
      quality: 'optional user-selected judge model score from 0-100; omitted when skipped or invalid',
      total: 'weighted average over active dimensions only; omitted dimensions cause remaining weights to re-normalize'
    },
    qualityRequested,
    qualityIncluded: runs.some((r) => r.dimensions.quality.score !== null),
    qualityFailure,
    judgeUsage: quality?.usage,
    codeAvailability: Object.fromEntries(rows.map((r) => [r.id, (codeByRun.get(r.id) ?? []).map((f) => f.path)])),
    runs
  }
}

async function runEvaluation(args: EvaluateArgs): Promise<EvaluateResponse> {
  const ids = Array.isArray(args.testRunIds) ? args.testRunIds.filter((id) => VALID_ID.test(id)).slice(0, MAX_RUNS) : []
  if (ids.length === 0) return { ok: false, error: 'select at least one test run' }
  const rows = getTestRunsByIds(ids)
  if (rows.length !== ids.length) return { ok: false, error: 'one or more selected test runs were not found' }

  // Preserve caller ordering for comparison tables.
  const byId = new Map(rows.map((r) => [r.id, r]))
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is TestRunRow => Boolean(r))
  const codeByRun = new Map(ordered.map((r) => [r.id, readStoredGeneratedFiles(r)]))

  let quality: QualityResult | null = null
  let qualityFailure: string | undefined
  if (args.includeQuality) {
    try {
      quality = await judgeQuality(args, ordered, codeByRun)
    } catch (err) {
      qualityFailure = err instanceof Error ? err.message : String(err)
    }
  }

  const weights = getIsaScoreSettings().weights
  const scores = computeScores(ordered, weights, quality, args.includeQuality, qualityFailure, codeByRun)
  const top = Math.max(...scores.runs.map((r) => r.totalScore))
  const evaluation = createEvaluation({
    kind: ordered.length === 1 ? 'single' : 'comparison',
    testRunIds: ids,
    judgeModel: quality?.judgeModel ?? null,
    dimensionScores: scores,
    weights,
    totalScore: top,
    rationale: quality?.overallRationale ?? null,
    pdfPath: null
  })
  return { ok: true, evaluation }
}

function reportsDir(): string {
  return join(app.getPath('userData'), 'reports')
}

function assertReportPath(p: string): boolean {
  const rel = relative(reportsDir(), p)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

function scorePayload(evaluation: EvaluationRow): EvaluationScores {
  return evaluation.dimensionScores as EvaluationScores
}

function sourceRepoLabel(rows: TestRunRow[]): string {
  const repos = [...new Set(rows.map((r) => r.sourceRepo))]
  return repos.length === 1 ? repos[0] : `${repos.length} source repos`
}

function addRule(doc: PdfDoc): void {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  doc.moveTo(left, doc.y + 4).lineTo(right, doc.y + 4).strokeColor('#d8dee9').lineWidth(0.5).stroke()
  doc.moveDown(0.8)
}

function left(doc: PdfDoc): number {
  return doc.page.margins.left
}

function contentWidth(doc: PdfDoc): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right
}

function ensureSpace(doc: PdfDoc, height: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom
  if (doc.y + height > bottom) doc.addPage()
}

function section(doc: PdfDoc, title: string): void {
  ensureSpace(doc, 36)
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor('#111827').text(title, left(doc), doc.y, {
    width: contentWidth(doc)
  })
  addRule(doc)
}

function small(doc: PdfDoc, text: string): void {
  doc.font('Helvetica').fontSize(9).fillColor('#4b5563').text(text, left(doc), doc.y, { width: contentWidth(doc) })
}

function cell(doc: PdfDoc, text: string, x: number, y: number, width: number, bold = false): void {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#111827').text(text, x, y, {
    width,
    lineBreak: false,
    ellipsis: true
  })
}

function renderTable(doc: PdfDoc, evaluation: EvaluationRow, rows: TestRunRow[]): void {
  const scores = scorePayload(evaluation)
  const runMap = new Map(rows.map((r) => [r.id, r]))
  const left = doc.page.margins.left
  const widths = [74, 50, 54, 44, 44, 44, 44, 44, 42]
  const headers = ['model', 'pass', 'duration', 'tokens', 'tests', 'speed', 'eff.', 'quality', 'total']
  let y = doc.y
  ensureSpace(doc, 28 + scores.runs.length * 18)
  doc.rect(left, y - 3, widths.reduce((a, b) => a + b, 0), 16).fill('#eef2f7')
  let x = left
  headers.forEach((h, i) => {
    cell(doc, h, x + 3, y, widths[i] - 6, true)
    x += widths[i]
  })
  y += 18

  for (const score of [...scores.runs].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))) {
    const run = runMap.get(score.testRunId)
    x = left
    const pass = score.objective.passRate === null ? 'n/a' : `${Math.round(score.objective.passRate * 100)}%`
    const vals = [
      `${score.rank ?? '-'} ${score.model}`,
      pass,
      run?.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : '-',
      run?.tokens != null ? String(run.tokens) : '-',
      formatScore(score.dimensions.tests.score),
      formatScore(score.dimensions.speed.score),
      formatScore(score.dimensions.tokens.score),
      formatScore(score.dimensions.quality.score),
      score.totalScore.toFixed(1)
    ]
    for (let i = 0; i < vals.length; i++) {
      cell(doc, vals[i], x + 3, y, widths[i] - 6, i === vals.length - 1)
      x += widths[i]
    }
    y += 17
  }
  doc.y = y + 4
}

function renderBreakdown(doc: PdfDoc, evaluation: EvaluationRow): void {
  const scores = scorePayload(evaluation)
  for (const run of scores.runs) {
    ensureSpace(doc, 92)
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text(
      `${run.model} · total ${run.totalScore.toFixed(1)}`,
      left(doc),
      doc.y,
      { width: contentWidth(doc) }
    )
    for (const name of ['tests', 'speed', 'tokens', 'quality'] as DimensionName[]) {
      const d = run.dimensions[name]
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(d.omitted ? '#6b7280' : '#111827')
        .text(
          `${name.toUpperCase()}: ${formatScore(d.score)} · configured weight ${d.weight} · effective ${Math.round(
            d.effectiveWeight * 100
          )}% · ${d.value}`,
          left(doc),
          doc.y,
          { width: contentWidth(doc) }
        )
    }
    if (run.qualityRationale) small(doc, `Quality rationale: ${run.qualityRationale}`)
    doc.moveDown(0.5)
  }
}

function renderCode(doc: PdfDoc, rows: TestRunRow[]): void {
  section(doc, rows.length === 1 ? 'Generated Test Code' : 'Generated Test Code Excerpts')
  for (const run of rows) {
    const files = readStoredGeneratedFiles(run)
    ensureSpace(doc, 80)
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text(modelLabel(run), left(doc), doc.y, {
      width: contentWidth(doc)
    })
    if (files.length === 0) {
      small(doc, 'Generated test code was not available for this run. New Phase 8 runs store generated_files metadata.')
      doc.moveDown(0.4)
      continue
    }
    for (const f of files.slice(0, 3)) {
      ensureSpace(doc, 110)
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#374151').text(f.path, left(doc), doc.y, {
        width: contentWidth(doc)
      })
      doc.font('Courier').fontSize(7).fillColor('#111827').text(cap(f.content, PDF_CODE_CHARS), left(doc), doc.y, {
        width: contentWidth(doc),
        lineGap: 1
      })
      doc.moveDown(0.4)
    }
  }
}

async function writePdf(evaluation: EvaluationRow, rows: TestRunRow[], pdfPath: string): Promise<void> {
  mkdirSync(dirname(pdfPath), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48 })
    const stream = createWriteStream(pdfPath)
    stream.on('finish', resolve)
    stream.on('error', reject)
    doc.on('error', reject)
    doc.pipe(stream)

    const scores = scorePayload(evaluation)
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111827').text('Akorith Evaluation Report', left(doc), doc.y, {
      width: contentWidth(doc)
    })
    doc.font('Helvetica').fontSize(10).fillColor('#4b5563').text(`Generated ${safeDate(Date.now())}`, left(doc), doc.y, {
      width: contentWidth(doc)
    })
    doc.moveDown(0.4)
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text(evaluation.kind.toUpperCase(), left(doc), doc.y, {
      width: contentWidth(doc)
    })
    small(doc, `Source: ${sourceRepoLabel(rows)}`)
    small(doc, `Target: ${rows[0]?.targetDesc || 'not recorded'}`)
    small(doc, `Judge: ${evaluation.judgeModel ?? 'objective-only'}`)
    small(doc, `Stored evaluation: ${evaluation.id}`)
    if (scores.qualityFailure) small(doc, `Quality judge omitted: ${scores.qualityFailure}`)
    addRule(doc)

    section(doc, 'Objective Metrics + ISAScore')
    renderTable(doc, evaluation, rows)

    section(doc, 'Score Breakdown')
    renderBreakdown(doc, evaluation)
    small(doc, `Formula: ${scores.formulas.total}`)
    small(doc, `Tests: ${scores.formulas.tests}`)
    small(doc, `Speed: ${scores.formulas.speed}`)
    small(doc, `Token efficiency: ${scores.formulas.tokens}`)
    if (evaluation.rationale) {
      section(doc, 'LLM Quality Rationale')
      small(doc, evaluation.rationale)
    }

    renderCode(doc, rows)

    doc.moveDown(0.8)
    addRule(doc)
    small(doc, 'PDF generated by Akorith using the single evaluation report template.')
    doc.end()
  })
}

async function exportPdf(evaluationId: string): Promise<PdfResponse> {
  if (!VALID_ID.test(evaluationId)) return { ok: false, error: 'invalid evaluation id' }
  const evaluation = getEvaluation(evaluationId)
  if (!evaluation) return { ok: false, error: 'evaluation not found' }
  const rows = getTestRunsByIds(evaluation.testRunIds)
  if (rows.length === 0) return { ok: false, error: 'evaluation has no test runs' }

  const dir = reportsDir()
  mkdirSync(dir, { recursive: true })
  const stamp = new Date(evaluation.ts).toISOString().replace(/[:.]/g, '-')
  const pdfPath = join(dir, `loopex-${evaluation.kind}-${stamp}-${evaluation.id.slice(0, 8)}.pdf`)
  await writePdf(evaluation, rows, pdfPath)
  const updated = setEvaluationPdfPath(evaluation.id, pdfPath)
  if (!updated) return { ok: false, error: 'failed to update evaluation pdf path' }
  return { ok: true, evaluation: updated, pdfPath }
}

function revealPdf(evaluationId: string): { ok: true } | { ok: false; error: string } {
  if (!VALID_ID.test(evaluationId)) return { ok: false, error: 'invalid evaluation id' }
  const evaluation = getEvaluation(evaluationId)
  if (!evaluation?.pdfPath) return { ok: false, error: 'evaluation has no PDF yet' }
  if (!assertReportPath(evaluation.pdfPath) || !existsSync(evaluation.pdfPath)) {
    return { ok: false, error: 'PDF file is missing or outside the reports directory' }
  }
  shell.showItemInFolder(evaluation.pdfPath)
  return { ok: true }
}

async function openPdf(evaluationId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!VALID_ID.test(evaluationId)) return { ok: false, error: 'invalid evaluation id' }
  const evaluation = getEvaluation(evaluationId)
  if (!evaluation?.pdfPath) return { ok: false, error: 'evaluation has no PDF yet' }
  if (!assertReportPath(evaluation.pdfPath) || !existsSync(evaluation.pdfPath)) {
    return { ok: false, error: 'PDF file is missing or outside the reports directory' }
  }
  const err = await shell.openPath(evaluation.pdfPath)
  return err ? { ok: false, error: err } : { ok: true }
}

export function registerEvaluateIpc(): void {
  ipcMain.handle('evaluate:getSettings', () => getIsaScoreSettings())

  ipcMain.handle('evaluate:list', (_event, args: { limit?: number }) =>
    listEvaluations(typeof args?.limit === 'number' ? args.limit : 50)
  )

  ipcMain.handle('evaluate:run', async (_event, args: EvaluateArgs): Promise<EvaluateResponse> => {
    if (
      !args ||
      !Array.isArray(args.testRunIds) ||
      typeof args.includeQuality !== 'boolean' ||
      (args.judgeProviderId !== undefined && (typeof args.judgeProviderId !== 'string' || !/^[a-z0-9-]{1,32}$/.test(args.judgeProviderId))) ||
      (args.judgeModel !== undefined && (typeof args.judgeModel !== 'string' || args.judgeModel.length > 64))
    ) {
      return { ok: false, error: 'invalid evaluate:run payload' }
    }
    try {
      return await runEvaluation(args)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('evaluate:exportPdf', async (_event, args: { evaluationId: string }): Promise<PdfResponse> => {
    if (typeof args?.evaluationId !== 'string') return { ok: false, error: 'invalid evaluate:exportPdf payload' }
    try {
      return await exportPdf(args.evaluationId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('evaluate:revealPdf', (_event, args: { evaluationId: string }) => {
    if (typeof args?.evaluationId !== 'string') return { ok: false, error: 'invalid evaluate:revealPdf payload' }
    return revealPdf(args.evaluationId)
  })

  ipcMain.handle('evaluate:openPdf', async (_event, args: { evaluationId: string }) => {
    if (typeof args?.evaluationId !== 'string') return { ok: false, error: 'invalid evaluate:openPdf payload' }
    return openPdf(args.evaluationId)
  })
}
