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
  artifactPath: string | null
  mediaType: BenchmarkMediaType
  mediaUrl: string | null
}

export type BenchmarkUpsertInput = Omit<BenchmarkEntry, 'id' | 'createdAt' | 'updatedAt' | 'signature' | 'artifactPath'> & {
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
    artifactPath: (row.artifact_path as string | null) ?? null,
    mediaType: cleanMediaType(row.media_type),
    mediaUrl: (row.media_url as string | null) ?? null
  }
}

function signatureFor(input: Pick<BenchmarkUpsertInput, 'challengeId' | 'model'>): string {
  return `${input.challengeId.trim().toLowerCase()}::${input.model.trim().toLowerCase()}`
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
  const signature = (input.signature?.trim() || signatureFor({ challengeId, model })).slice(0, 320)
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
