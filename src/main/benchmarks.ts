import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { getDb } from './db'

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
  mediaType: BenchmarkMediaType
  mediaUrl: string | null
}

export type BenchmarkUpsertInput = Omit<BenchmarkEntry, 'id' | 'createdAt' | 'updatedAt' | 'signature'> & {
  id?: string
  signature?: string
}

type Row = Record<string, unknown>

const MAX_TEXT = 12_000

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
    mediaType: cleanMediaType(row.media_type),
    mediaUrl: (row.media_url as string | null) ?? null
  }
}

function signatureFor(input: Pick<BenchmarkUpsertInput, 'challengeId' | 'model'>): string {
  return `${input.challengeId.trim().toLowerCase()}::${input.model.trim().toLowerCase()}`
}

export function upsertBenchmarkEntry(input: BenchmarkUpsertInput): BenchmarkEntry {
  const now = Date.now()
  const challengeId = input.challengeId.trim().slice(0, 120)
  const model = input.model.trim().slice(0, 160)
  if (!challengeId || !model) throw new Error('benchmark entry requires challengeId and model')
  const signature = (input.signature?.trim() || signatureFor({ challengeId, model })).slice(0, 320)
  const existing = getDb().prepare('SELECT * FROM benchmark_entries WHERE signature = ?').get(signature) as Row | undefined
  const id = existing ? String(existing.id) : input.id ?? randomUUID()
  const createdAt = existing ? Number(existing.created_at) || now : now
  getDb()
    .prepare(
      `INSERT INTO benchmark_entries
       (id, signature, created_at, updated_at, challenge_id, challenge_label, category, metric,
        model, provider_id, score, rank, status, duration_ms, tokens, run_id, source,
        summary, prompt, artifact_preview, media_type, media_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

function webExportCandidates(): string[] {
  const env = process.env.AKORITH_WEB_DIR
  return [
    env ? join(env, 'public', 'data', 'benchmarks.json') : '',
    join(homedir(), 'Desktop', 'Projects', 'AkorithWeb', 'public', 'data', 'benchmarks.json'),
    join(app.getPath('userData'), 'benchmark-library.json')
  ].filter(Boolean)
}

export function exportBenchmarkLibrary(): { ok: true; path: string; count: number } | { ok: false; error: string } {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: 'Akorith desktop benchmark library',
    benchmarks: listBenchmarkEntries(1000)
  }
  const json = `${JSON.stringify(payload, null, 2)}\n`
  const errors: string[] = []
  for (const target of webExportCandidates()) {
    try {
      const dir = dirname(target)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(target, json, 'utf8')
      return { ok: true, path: target, count: payload.benchmarks.length }
    } catch (err) {
      errors.push(`${target}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { ok: false, error: errors.join('; ') || 'no export target available' }
}

export function registerBenchmarkIpc(): void {
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
}
