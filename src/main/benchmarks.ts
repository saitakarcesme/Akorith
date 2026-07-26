import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { ensureDbReady, getDb } from './db'

export type BenchmarkCategory = 'general' | 'ui' | 'game' | 'repo'
export type BenchmarkMediaType = 'none' | 'image' | 'video' | 'interactive' | 'artifact'

export interface BenchmarkEntry {
  id: string
  signature: string
  createdAt: number
  updatedAt: number
  challengeId: string
  challengeLabel: string
  category: BenchmarkCategory
  metric: string
  model: string
  providerId: string | null
  score: number | null
  rank: number | null
  status: string | null
  durationMs: number | null
  tokens: number | null
  runId: string | null
  source: string | null
  summary: string | null
  prompt: string | null
  artifactPreview: string | null
  artifactPath: string | null
  mediaType: BenchmarkMediaType
  mediaUrl: string | null
}

export type BenchmarkUpsertInput = Omit<BenchmarkEntry, 'id' | 'createdAt' | 'updatedAt' | 'signature' | 'artifactPath'> & {
  id?: string
  signature?: string
}

export type BenchmarkRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type BenchmarkRunItemStatus = BenchmarkRunStatus | 'skipped'

export interface BenchmarkRunItem {
  id: string
  benchmarkRunId: string
  position: number
  createdAt: number
  updatedAt: number
  startedAt: number | null
  completedAt: number | null
  providerId: string
  model: string
  status: BenchmarkRunItemStatus
  phase: string | null
  testRunId: string | null
  benchmarkEntryId: string | null
  score: number | null
  rank: number | null
  durationMs: number | null
  tokens: number | null
  error: string | null
}

export interface BenchmarkRun {
  id: string
  createdAt: number
  updatedAt: number
  startedAt: number | null
  completedAt: number | null
  status: BenchmarkRunStatus
  challengeId: string
  challengeLabel: string
  category: BenchmarkCategory
  metric: string
  source: string | null
  config: Record<string, unknown>
  parallelExecution: boolean
  error: string | null
  totalItems: number
  completedItems: number
  items: BenchmarkRunItem[]
}

export interface BenchmarkCreateRunInput {
  id?: string
  challengeId: string
  challengeLabel: string
  category: BenchmarkCategory
  metric: string
  source?: string | null
  config?: Record<string, unknown>
  parallelExecution?: boolean
  items: Array<{
    id?: string
    providerId: string
    model: string
  }>
}

export interface BenchmarkUpdateRunItemInput {
  runId: string
  itemId: string
  status?: BenchmarkRunItemStatus
  phase?: string | null
  testRunId?: string | null
  benchmarkEntryId?: string | null
  score?: number | null
  rank?: number | null
  durationMs?: number | null
  tokens?: number | null
  error?: string | null
}

export interface BenchmarkFinishRunInput {
  runId: string
  status: Extract<BenchmarkRunStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>
  error?: string | null
}

type Row = Record<string, unknown>

const MAX_TEXT = 12_000
const MAX_RUN_CONFIG_BYTES = 32_000
const MAX_RUN_ITEMS = 50
const VALID_ID = /^[\w-]{1,64}$/
const VALID_PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const RUN_STATUSES = new Set<BenchmarkRunStatus>(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'])
const RUN_ITEM_STATUSES = new Set<BenchmarkRunItemStatus>([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'skipped'
])
const TERMINAL_RUN_ITEM_STATUSES = new Set<BenchmarkRunItemStatus>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'skipped'
])
let staleRunsReconciled = false

function cleanText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text.slice(0, max) : null
}

function cleanCategory(value: unknown): BenchmarkCategory {
  return value === 'ui' || value === 'game' || value === 'repo' ? value : 'general'
}

function cleanMediaType(value: unknown): BenchmarkMediaType {
  return value === 'image' || value === 'video' || value === 'interactive' || value === 'artifact' ? value : 'none'
}

function rowToEntry(row: Row): BenchmarkEntry {
  return {
    id: String(row.id),
    signature: String(row.signature),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    challengeId: String(row.challenge_id),
    challengeLabel: String(row.challenge_label),
    category: cleanCategory(row.category),
    metric: String(row.metric),
    model: String(row.model),
    providerId: (row.provider_id as string | null) ?? null,
    score: row.score == null ? null : Number(row.score),
    rank: row.rank == null ? null : Number(row.rank),
    status: (row.status as string | null) ?? null,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    tokens: row.tokens == null ? null : Number(row.tokens),
    runId: (row.run_id as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    prompt: (row.prompt as string | null) ?? null,
    artifactPreview: (row.artifact_preview as string | null) ?? null,
    artifactPath: (row.artifact_path as string | null) ?? null,
    mediaType: cleanMediaType(row.media_type),
    mediaUrl: (row.media_url as string | null) ?? null
  }
}

function signatureFor(input: Pick<BenchmarkUpsertInput, 'challengeId' | 'providerId' | 'model'>): string {
  const providerId = input.providerId?.trim().toLowerCase() || 'unknown'
  return `${input.challengeId.trim().toLowerCase()}::${providerId}::${input.model.trim().toLowerCase()}`
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return cleaned || fallback
}

function stampFor(ts: number): string {
  return new Date(ts).toISOString().replace(/\.\d+Z$/, '').replace('T', '_').replace(/:/g, '-')
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function writeBenchmarkArtifactBundle(input: BenchmarkUpsertInput, id: string, now: number): string | null {
  try {
    const category = cleanCategory(input.category)
    const mediaType = cleanMediaType(input.mediaType)
    const videoId = safeSegment(input.runId ?? id, id.slice(0, 8))
    const folder = `${safeSegment(input.challengeLabel || input.challengeId, 'benchmark')}_${stampFor(now)}_${category}_${videoId}`
    const dir = join(homedir(), 'Desktop', 'Projects', 'AkorithBench', folder)
    mkdirSync(dir, { recursive: true })

    const metadata = {
      id,
      videoId,
      savedAt: new Date(now).toISOString(),
      challengeId: input.challengeId,
      challengeLabel: input.challengeLabel,
      category,
      metric: input.metric,
      model: input.model,
      providerId: input.providerId,
      score: input.score,
      rank: input.rank,
      status: input.status,
      durationMs: input.durationMs,
      tokens: input.tokens,
      runId: input.runId,
      mediaType,
      mediaUrl: input.mediaUrl ?? null
    }

    writeFileSync(join(dir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    writeFileSync(join(dir, 'prompt.md'), `${input.prompt ?? 'No prompt recorded.'}\n`, 'utf8')
    writeFileSync(join(dir, 'output.md'), `${input.artifactPreview ?? 'No model output recorded.'}\n`, 'utf8')
    writeFileSync(
      join(dir, 'README.md'),
      [
        `# ${input.challengeLabel}`,
        '',
        `Model: ${input.model}`,
        `Score: ${input.score ?? 'not scored'}`,
        `Type: ${category}`,
        `Video ID: ${videoId}`,
        '',
        'Files in this folder are generated by Akorith Benchmark so each model result has a durable local artifact.'
      ].join('\n'),
      'utf8'
    )

    if (mediaType === 'video' || mediaType === 'image' || category === 'game' || category === 'ui') {
      writeFileSync(
        join(dir, 'capture-manifest.json'),
        `${JSON.stringify(
          {
            videoId,
            required: mediaType === 'video',
            recommendedDurationSec: mediaType === 'video' ? 20 : null,
            viewport: category === 'game' ? '1280x720' : '1440x900',
            captures: category === 'game'
              ? ['first frame', 'player input', 'score change', 'win or fail state']
              : ['desktop state', 'mobile state', 'focus state', 'error or success state']
          },
          null,
          2
        )}\n`,
        'utf8'
      )
      writeFileSync(
        join(dir, 'capture-plan.md'),
        [
          `# Capture plan ${videoId}`,
          '',
          mediaType === 'video'
            ? 'Record a short browser clip for this benchmark result. The clip should show the generated product or gameplay, not just a text answer.'
            : 'Capture screenshot evidence for this benchmark result.',
          '',
          '- Open the generated product or preview.',
          '- Capture the first meaningful loaded state.',
          '- Capture one interaction or state change.',
          '- Keep the prompt, output, metadata, and media together in this folder.'
        ].join('\n'),
        'utf8'
      )
      writeFileSync(
        join(dir, `${videoId}.svg`),
        `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#151515"/>
  <rect x="56" y="56" width="1168" height="608" rx="28" fill="#202020" stroke="#555"/>
  <text x="96" y="128" fill="#f2f2f2" font-family="monospace" font-size="34">${htmlEscape(input.challengeLabel)}</text>
  <text x="96" y="184" fill="#b8b8b8" font-family="monospace" font-size="24">${htmlEscape(input.model)}</text>
  <rect x="96" y="248" width="${Math.max(24, Math.min(960, (input.score ?? 0) * 9.6))}" height="54" rx="12" fill="#34c08b"/>
  <text x="96" y="374" fill="#8f6ae0" font-family="monospace" font-size="86">${input.score ?? '--'}/100</text>
  <text x="96" y="456" fill="#c9cacd" font-family="monospace" font-size="24">Video ID: ${htmlEscape(videoId)}</text>
  <text x="96" y="504" fill="#8e8e8e" font-family="monospace" font-size="20">Akorith Benchmark local artifact frame</text>
</svg>
`,
        'utf8'
      )
      if (mediaType === 'video') {
        writeFileSync(join(dir, 'video-id.txt'), `${videoId}\n`, 'utf8')
        writeFileSync(
          join(dir, 'capture-preview.html'),
          `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${htmlEscape(input.challengeLabel)} - ${htmlEscape(videoId)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111; color: #f2f2f2; font: 16px ui-monospace, monospace; }
    main { width: min(92vw, 1100px); border: 1px solid #444; border-radius: 24px; overflow: hidden; background: #191a1e; box-shadow: 0 30px 80px #0008; }
    header { display: flex; justify-content: space-between; padding: 18px 22px; border-bottom: 1px solid #333; }
    .stage { aspect-ratio: 16 / 9; position: relative; background: radial-gradient(circle at 50% 55%, #34c08b33, transparent 28%), radial-gradient(circle at 20% 20%, #8f6ae044, transparent 30%), #0d0e12; }
    .ship { position: absolute; left: 50%; bottom: 18%; width: 70px; height: 70px; border-radius: 18px; transform: translateX(-50%) rotate(45deg); background: linear-gradient(135deg, #8f6ae0, #34c08b); animation: pulse 1.4s infinite ease-in-out; }
    .orb { position: absolute; width: 30px; height: 30px; border-radius: 50%; background: #f2f2f2; animation: drift 2.4s infinite alternate ease-in-out; }
    .orb.one { left: 25%; top: 38%; }
    .orb.two { right: 24%; top: 28%; background: #8f6ae0; animation-delay: .5s; }
    footer { padding: 16px 22px; color: #9b9ca3; }
    @keyframes pulse { 50% { transform: translateX(-50%) rotate(45deg) scale(1.08); } }
    @keyframes drift { to { transform: translateY(30px); } }
  </style>
</head>
<body>
  <main>
    <header><strong>${htmlEscape(input.model)}</strong><span>Video ID ${htmlEscape(videoId)}</span></header>
    <section class="stage"><div class="orb one"></div><div class="orb two"></div><div class="ship"></div></section>
    <footer>Use this local preview as the recording target when producing the benchmark clip.</footer>
  </main>
</body>
</html>
`,
          'utf8'
        )
      }
    }

    return dir
  } catch {
    return null
  }
}

function webSafeEntry(entry: BenchmarkEntry): Omit<BenchmarkEntry, 'artifactPath'> {
  const { artifactPath: _artifactPath, ...safe } = entry
  if (safe.source && safe.source.startsWith(homedir())) safe.source = 'local repo sandbox'
  safe.artifactPreview = null
  return safe
}

export function upsertBenchmarkEntry(input: BenchmarkUpsertInput): BenchmarkEntry {
  const now = Date.now()
  const challengeId = input.challengeId.trim().slice(0, 120)
  const model = input.model.trim().slice(0, 160)
  if (!challengeId || !model) throw new Error('benchmark entry requires challengeId and model')
  const signature = (input.signature?.trim() || signatureFor({ challengeId, providerId: input.providerId, model })).slice(0, 320)
  const existing = getDb().prepare('SELECT * FROM benchmark_entries WHERE signature = ?').get(signature) as Row | undefined
  const id = existing ? String(existing.id) : input.id ?? randomUUID()
  const createdAt = existing ? Number(existing.created_at) || now : now
  const artifactPath = writeBenchmarkArtifactBundle(input, id, now)
  getDb()
    .prepare(
      `INSERT INTO benchmark_entries
       (id, signature, created_at, updated_at, challenge_id, challenge_label, category, metric,
        model, provider_id, score, rank, status, duration_ms, tokens, run_id, source,
        summary, prompt, artifact_preview, artifact_path, media_type, media_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(signature) DO UPDATE SET
         updated_at = excluded.updated_at,
         challenge_label = excluded.challenge_label,
         category = excluded.category,
         metric = excluded.metric,
         provider_id = excluded.provider_id,
         score = excluded.score,
         rank = excluded.rank,
         status = excluded.status,
         duration_ms = excluded.duration_ms,
         tokens = excluded.tokens,
         run_id = excluded.run_id,
         source = excluded.source,
         summary = excluded.summary,
         prompt = excluded.prompt,
         artifact_preview = excluded.artifact_preview,
         artifact_path = excluded.artifact_path,
         media_type = excluded.media_type,
         media_url = excluded.media_url`
    )
    .run(
      id,
      signature,
      createdAt,
      now,
      challengeId,
      input.challengeLabel.trim().slice(0, 180),
      cleanCategory(input.category),
      input.metric.trim().slice(0, 80),
      model,
      input.providerId ?? null,
      input.score ?? null,
      input.rank ?? null,
      input.status ?? null,
      input.durationMs ?? null,
      input.tokens ?? null,
      input.runId ?? null,
      input.source ?? null,
      cleanText(input.summary, 1000),
      cleanText(input.prompt),
      cleanText(input.artifactPreview),
      artifactPath,
      cleanMediaType(input.mediaType),
      input.mediaUrl ?? null
    )
  return getBenchmarkEntry(id)!
}

export function getBenchmarkEntry(id: string): BenchmarkEntry | null {
  const row = getDb().prepare('SELECT * FROM benchmark_entries WHERE id = ?').get(id) as Row | undefined
  return row ? rowToEntry(row) : null
}

export function listBenchmarkEntries(limit = 200): BenchmarkEntry[] {
  const lim = Math.min(Math.max(limit, 1), 1000)
  const rows = getDb()
    .prepare('SELECT * FROM benchmark_entries ORDER BY updated_at DESC LIMIT ?')
    .all(lim) as Row[]
  return rows.map(rowToEntry)
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const text = value.trim()
  if (!text) throw new Error(`${field} is required`)
  return text.slice(0, max)
}

function optionalText(value: unknown, max: number): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error('optional text value must be a string or null')
  const text = value.trim()
  return text ? text.slice(0, max) : null
}

function validId(value: unknown, field: string, generate = false): string {
  if ((value === undefined || value === null || value === '') && generate) return randomUUID()
  if (typeof value !== 'string' || !VALID_ID.test(value)) throw new Error(`${field} is invalid`)
  return value
}

function nullableId(value: unknown, field: string): string | null {
  if (value == null || value === '') return null
  return validId(value, field)
}

function nullableNumber(
  value: unknown,
  field: string,
  options: { integer?: boolean; min?: number; max?: number } = {}
): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number or null`)
  const next = options.integer ? Math.trunc(value) : value
  if (options.min !== undefined && next < options.min) throw new Error(`${field} must be at least ${options.min}`)
  if (options.max !== undefined && next > options.max) throw new Error(`${field} must be at most ${options.max}`)
  return next
}

function cleanRunConfig(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('benchmark run config must be an object')
  }
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    throw new Error('benchmark run config must be JSON-serializable')
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_RUN_CONFIG_BYTES) {
    throw new Error(`benchmark run config exceeds ${MAX_RUN_CONFIG_BYTES} bytes`)
  }
  return JSON.parse(json) as Record<string, unknown>
}

function parseRunConfig(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function runItemStatus(value: unknown): BenchmarkRunItemStatus {
  if (typeof value !== 'string' || !RUN_ITEM_STATUSES.has(value as BenchmarkRunItemStatus)) {
    throw new Error('invalid benchmark run item status')
  }
  return value as BenchmarkRunItemStatus
}

function runStatus(value: unknown): BenchmarkRunStatus {
  if (typeof value !== 'string' || !RUN_STATUSES.has(value as BenchmarkRunStatus)) {
    throw new Error('invalid benchmark run status')
  }
  return value as BenchmarkRunStatus
}

function rowToRunItem(row: Row): BenchmarkRunItem {
  return {
    id: String(row.id),
    benchmarkRunId: String(row.benchmark_run_id),
    position: Number(row.position) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    startedAt: row.started_at == null ? null : Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    providerId: String(row.provider_id),
    model: String(row.model),
    status: runItemStatus(row.status),
    phase: (row.phase as string | null) ?? null,
    testRunId: (row.test_run_id as string | null) ?? null,
    benchmarkEntryId: (row.benchmark_entry_id as string | null) ?? null,
    score: row.score == null ? null : Number(row.score),
    rank: row.rank == null ? null : Number(row.rank),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    tokens: row.tokens == null ? null : Number(row.tokens),
    error: (row.error as string | null) ?? null
  }
}

function rowToRun(row: Row, items: BenchmarkRunItem[]): BenchmarkRun {
  return {
    id: String(row.id),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    startedAt: row.started_at == null ? null : Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    status: runStatus(row.status),
    challengeId: String(row.challenge_id),
    challengeLabel: String(row.challenge_label),
    category: cleanCategory(row.category),
    metric: String(row.metric),
    source: (row.source as string | null) ?? null,
    config: parseRunConfig(row.config_json),
    parallelExecution: Number(row.parallel_execution) === 1,
    error: (row.error as string | null) ?? null,
    totalItems: items.length,
    completedItems: items.filter((item) => TERMINAL_RUN_ITEM_STATUSES.has(item.status)).length,
    items
  }
}

function runsFromRows(rows: Row[]): BenchmarkRun[] {
  if (rows.length === 0) return []
  const placeholders = rows.map(() => '?').join(', ')
  const itemRows = getDb()
    .prepare(
      `SELECT * FROM benchmark_run_items
        WHERE benchmark_run_id IN (${placeholders})
        ORDER BY benchmark_run_id, position`
    )
    .all(...rows.map((row) => String(row.id))) as Row[]
  const grouped = new Map<string, BenchmarkRunItem[]>()
  for (const row of itemRows) {
    const item = rowToRunItem(row)
    const current = grouped.get(item.benchmarkRunId) ?? []
    current.push(item)
    grouped.set(item.benchmarkRunId, current)
  }
  return rows.map((row) => rowToRun(row, grouped.get(String(row.id)) ?? []))
}

function getBenchmarkRun(id: string): BenchmarkRun | null {
  const safeId = validId(id, 'runId')
  const row = getDb().prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(safeId) as Row | undefined
  return row ? runsFromRows([row])[0] ?? null : null
}

function reconcileStaleBenchmarkRuns(): void {
  if (staleRunsReconciled) return
  const now = Date.now()
  const reason = 'Interrupted because Akorith restarted before the benchmark completed.'
  const transaction = getDb().transaction(() => {
    getDb()
      .prepare(
        `UPDATE benchmark_run_items
            SET status = 'interrupted',
                updated_at = ?,
                completed_at = COALESCE(completed_at, ?),
                error = COALESCE(error, ?)
          WHERE status IN ('queued', 'running')
            AND benchmark_run_id IN (
              SELECT id FROM benchmark_runs WHERE status IN ('queued', 'running')
            )`
      )
      .run(now, now, reason)
    getDb()
      .prepare(
        `UPDATE benchmark_runs
            SET status = 'interrupted',
                updated_at = ?,
                completed_at = COALESCE(completed_at, ?),
                error = COALESCE(error, ?)
          WHERE status IN ('queued', 'running')`
      )
      .run(now, now, reason)
  })
  transaction()
  staleRunsReconciled = true
}

export function createBenchmarkRun(input: BenchmarkCreateRunInput): BenchmarkRun {
  reconcileStaleBenchmarkRuns()
  if (!input || typeof input !== 'object') throw new Error('invalid benchmark:createRun payload')
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > MAX_RUN_ITEMS) {
    throw new Error(`benchmark run requires 1-${MAX_RUN_ITEMS} model items`)
  }

  const id = validId(input.id, 'run id', true)
  const challengeId = requiredText(input.challengeId, 'challengeId', 120)
  const challengeLabel = requiredText(input.challengeLabel, 'challengeLabel', 180)
  const metric = requiredText(input.metric, 'metric', 80)
  const category = cleanCategory(input.category)
  const source = optionalText(input.source, 1_000)
  const config = cleanRunConfig(input.config)
  const configJson = JSON.stringify(config)
  const parallelExecution = input.parallelExecution === true
  const now = Date.now()
  const seenIds = new Set<string>()
  const items = input.items.map((item, position) => {
    if (!item || typeof item !== 'object') throw new Error(`benchmark item ${position + 1} is invalid`)
    const itemId = validId(item.id, `benchmark item ${position + 1} id`, true)
    if (seenIds.has(itemId)) throw new Error('benchmark item ids must be unique')
    seenIds.add(itemId)
    const providerId = requiredText(item.providerId, `benchmark item ${position + 1} providerId`, 64)
    if (!VALID_PROVIDER_ID.test(providerId)) throw new Error(`benchmark item ${position + 1} providerId is invalid`)
    const model = requiredText(item.model, `benchmark item ${position + 1} model`, 160)
    return { id: itemId, position, providerId, model }
  })

  const transaction = getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO benchmark_runs (
          id, created_at, updated_at, started_at, completed_at, status,
          challenge_id, challenge_label, category, metric, source,
          config_json, parallel_execution, error
        ) VALUES (?, ?, ?, NULL, NULL, 'queued', ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        id,
        now,
        now,
        challengeId,
        challengeLabel,
        category,
        metric,
        source,
        configJson,
        parallelExecution ? 1 : 0
      )
    const insertItem = getDb().prepare(
      `INSERT INTO benchmark_run_items (
        id, benchmark_run_id, position, created_at, updated_at, started_at, completed_at,
        provider_id, model, status, phase, test_run_id, benchmark_entry_id,
        score, rank, duration_ms, tokens, error
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'queued', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`
    )
    for (const item of items) {
      insertItem.run(item.id, id, item.position, now, now, item.providerId, item.model)
    }
  })
  transaction()
  return getBenchmarkRun(id)!
}

export function updateBenchmarkRunItem(input: BenchmarkUpdateRunItemInput): BenchmarkRun {
  if (!input || typeof input !== 'object') throw new Error('invalid benchmark:updateRunItem payload')
  const runId = validId(input.runId, 'runId')
  const itemId = validId(input.itemId, 'itemId')
  const now = Date.now()
  const transaction = getDb().transaction(() => {
    const runRow = getDb().prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(runId) as Row | undefined
    if (!runRow) throw new Error('benchmark run not found')
    const currentRunStatus = runStatus(runRow.status)
    if (TERMINAL_RUN_ITEM_STATUSES.has(currentRunStatus as BenchmarkRunItemStatus)) {
      throw new Error('finished benchmark runs are immutable')
    }
    const itemRow = getDb()
      .prepare('SELECT * FROM benchmark_run_items WHERE id = ? AND benchmark_run_id = ?')
      .get(itemId, runId) as Row | undefined
    if (!itemRow) throw new Error('benchmark run item not found')
    const current = rowToRunItem(itemRow)
    const nextStatus = input.status === undefined ? current.status : runItemStatus(input.status)
    if (
      TERMINAL_RUN_ITEM_STATUSES.has(current.status) &&
      input.status !== undefined &&
      nextStatus !== current.status
    ) {
      throw new Error('finished benchmark run items cannot change status')
    }

    const nextPhase = input.phase === undefined ? current.phase : optionalText(input.phase, 200)
    const nextTestRunId =
      input.testRunId === undefined ? current.testRunId : nullableId(input.testRunId, 'testRunId')
    const nextBenchmarkEntryId =
      input.benchmarkEntryId === undefined
        ? current.benchmarkEntryId
        : nullableId(input.benchmarkEntryId, 'benchmarkEntryId')
    const nextScore =
      input.score === undefined ? current.score : nullableNumber(input.score, 'score', { min: 0, max: 100 })
    const nextRank =
      input.rank === undefined
        ? current.rank
        : nullableNumber(input.rank, 'rank', { integer: true, min: 1, max: MAX_RUN_ITEMS })
    const nextDurationMs =
      input.durationMs === undefined
        ? current.durationMs
        : nullableNumber(input.durationMs, 'durationMs', { integer: true, min: 0, max: 86_400_000 })
    const nextTokens =
      input.tokens === undefined
        ? current.tokens
        : nullableNumber(input.tokens, 'tokens', { integer: true, min: 0, max: Number.MAX_SAFE_INTEGER })
    const nextError = input.error === undefined ? current.error : optionalText(input.error, 4_000)
    const startedAt = nextStatus === 'running' || TERMINAL_RUN_ITEM_STATUSES.has(nextStatus)
      ? current.startedAt ?? now
      : current.startedAt
    const completedAt = TERMINAL_RUN_ITEM_STATUSES.has(nextStatus) ? current.completedAt ?? now : null

    getDb()
      .prepare(
        `UPDATE benchmark_run_items
            SET updated_at = ?, started_at = ?, completed_at = ?, status = ?, phase = ?,
                test_run_id = ?, benchmark_entry_id = ?, score = ?, rank = ?,
                duration_ms = ?, tokens = ?, error = ?
          WHERE id = ? AND benchmark_run_id = ?`
      )
      .run(
        now,
        startedAt,
        completedAt,
        nextStatus,
        nextPhase,
        nextTestRunId,
        nextBenchmarkEntryId,
        nextScore,
        nextRank,
        nextDurationMs,
        nextTokens,
        nextError,
        itemId,
        runId
      )
    getDb()
      .prepare(
        `UPDATE benchmark_runs
            SET updated_at = ?,
                status = CASE WHEN status = 'queued' AND ? <> 'queued' THEN 'running' ELSE status END,
                started_at = CASE
                  WHEN status = 'queued' AND ? <> 'queued' THEN COALESCE(started_at, ?)
                  ELSE started_at
                END
          WHERE id = ?`
      )
      .run(now, nextStatus, nextStatus, now, runId)
  })
  transaction()
  return getBenchmarkRun(runId)!
}

export function finishBenchmarkRun(input: BenchmarkFinishRunInput): BenchmarkRun {
  if (!input || typeof input !== 'object') throw new Error('invalid benchmark:finishRun payload')
  const runId = validId(input.runId, 'runId')
  const status = runStatus(input.status)
  if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) {
    throw new Error('benchmark run must finish as completed, failed, cancelled, or interrupted')
  }
  const error = optionalText(input.error, 4_000)
  const now = Date.now()
  const transaction = getDb().transaction(() => {
    const row = getDb().prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(runId) as Row | undefined
    if (!row) throw new Error('benchmark run not found')
    const currentStatus = runStatus(row.status)
    if (currentStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'cancelled' || currentStatus === 'interrupted') {
      if (currentStatus !== status) throw new Error('benchmark run is already finished')
      return
    }
    if (status === 'completed') {
      const pending = getDb()
        .prepare(
          `SELECT COUNT(*) AS count FROM benchmark_run_items
            WHERE benchmark_run_id = ? AND status IN ('queued', 'running')`
        )
        .get(runId) as { count: number }
      if (Number(pending.count) > 0) throw new Error('cannot complete a benchmark run while items are still queued or running')
    } else {
      const itemStatus: BenchmarkRunItemStatus = status === 'cancelled' ? 'cancelled' : 'interrupted'
      const itemError = error ?? (status === 'cancelled' ? 'Benchmark run cancelled.' : 'Benchmark run interrupted.')
      getDb()
        .prepare(
          `UPDATE benchmark_run_items
              SET status = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?),
                  error = COALESCE(error, ?)
            WHERE benchmark_run_id = ? AND status IN ('queued', 'running')`
        )
        .run(itemStatus, now, now, itemError, runId)
    }
    getDb()
      .prepare(
        `UPDATE benchmark_runs
            SET status = ?, updated_at = ?, completed_at = ?,
                started_at = COALESCE(started_at, created_at), error = ?
          WHERE id = ?`
      )
      .run(status, now, now, error, runId)
  })
  transaction()
  return getBenchmarkRun(runId)!
}

export function listBenchmarkRuns(limit = 50): BenchmarkRun[] {
  reconcileStaleBenchmarkRuns()
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 200)
  const rows = getDb()
    .prepare('SELECT * FROM benchmark_runs ORDER BY updated_at DESC LIMIT ?')
    .all(lim) as Row[]
  return runsFromRows(rows)
}

function webExportCandidates(): string[] {
  const env = process.env.AKORITH_WEB_DIR
  return [
    env ? join(env, 'public', 'data', 'benchmarks.json') : '',
    env ? join(env, 'src', 'data', 'benchmarkPayload.json') : '',
    join(homedir(), 'Desktop', 'Projects', 'AkorithWeb', 'public', 'data', 'benchmarks.json'),
    join(homedir(), 'Desktop', 'Projects', 'AkorithWeb', 'src', 'data', 'benchmarkPayload.json'),
    join(app.getPath('userData'), 'benchmark-library.json')
  ].filter(Boolean)
}

export function exportBenchmarkLibrary(): { ok: true; path: string; count: number } | { ok: false; error: string } {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: 'Akorith desktop benchmark library',
    benchmarks: listBenchmarkEntries(1000).map(webSafeEntry)
  }
  const json = `${JSON.stringify(payload, null, 2)}\n`
  const errors: string[] = []
  const written: string[] = []
  for (const target of webExportCandidates()) {
    try {
      const dir = dirname(target)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(target, json, 'utf8')
      written.push(target)
    } catch (err) {
      errors.push(`${target}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (written.length > 0) return { ok: true, path: written.join(', '), count: payload.benchmarks.length }
  return { ok: false, error: errors.join('; ') || 'no export target available' }
}

export function registerBenchmarkIpc(): void {
  // Registration happens before startup DB hydration. Reconcile on the next
  // event-loop turn so the first window is created before the native module is
  // opened, while still marking work left active by a previous process.
  setTimeout(() => {
    void ensureDbReady()
      .then(() => reconcileStaleBenchmarkRuns())
      .catch((err) => console.error('[benchmark] stale run reconciliation failed:', err))
  }, 0)

  ipcMain.handle('benchmark:list', (_event, args: { limit?: number }) =>
    listBenchmarkEntries(typeof args?.limit === 'number' ? args.limit : 200)
  )
  ipcMain.handle('benchmark:get', (_event, id: string) => getBenchmarkEntry(id))
  ipcMain.handle('benchmark:upsert', (_event, input: BenchmarkUpsertInput) => {
    const entry = upsertBenchmarkEntry(input)
    exportBenchmarkLibrary()
    return entry
  })
  ipcMain.handle('benchmark:export', () => exportBenchmarkLibrary())
  ipcMain.handle('benchmark:createRun', async (_event, input: BenchmarkCreateRunInput) => {
    await ensureDbReady()
    return createBenchmarkRun(input)
  })
  ipcMain.handle('benchmark:updateRunItem', async (_event, input: BenchmarkUpdateRunItemInput) => {
    await ensureDbReady()
    return updateBenchmarkRunItem(input)
  })
  ipcMain.handle('benchmark:finishRun', async (_event, input: BenchmarkFinishRunInput) => {
    await ensureDbReady()
    return finishBenchmarkRun(input)
  })
  ipcMain.handle('benchmark:listRuns', async (_event, args: { limit?: number }) => {
    await ensureDbReady()
    return listBenchmarkRuns(typeof args?.limit === 'number' ? args.limit : 50)
  })
}
