import { ipcMain } from 'electron'
import { readFile, readdir, realpath, stat } from 'fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { listProjects } from './db'

const SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache', 'vendor'])
const MAX_VISITED = 4_000
const MAX_RESULTS = 200
const FILE_INDEX_TTL_MS = 5_000
const MAX_CACHED_PROJECTS = 12
const MAX_FILE_BYTES = 1024 * 1024
const MAX_FILE_CHARS = 240_000
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.css', '.csv', '.env', '.go', '.h', '.hpp', '.html',
  '.ini', '.java', '.js', '.jsx', '.json', '.md', '.mjs', '.py', '.rb', '.rs',
  '.scss', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.xml',
  '.yaml', '.yml'
])

interface ProjectFileIndex {
  files: string[]
  expiresAt: number
  lastUsedAt: number
}

const fileIndexes = new Map<string, ProjectFileIndex>()
const pendingIndexes = new Map<string, { revision: number; promise: Promise<string[]> }>()
const fileIndexRevisions = new Map<string, number>()

function projectPath(projectId: string): string | null {
  return listProjects().find((project) => project.id === projectId)?.path ?? null
}

async function buildFileIndex(root: string): Promise<string[]> {
  const normalizedRoot = resolve(root)
  const files: string[] = []
  const queue: { path: string; depth: number }[] = [{ path: normalizedRoot, depth: 0 }]
  let visited = 0
  while (queue.length && visited < MAX_VISITED) {
    const current = queue.shift()!
    let entries
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (visited++ >= MAX_VISITED) break
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
      const absolute = join(current.path, entry.name)
      const resolved = resolve(absolute)
      if (!resolved.startsWith(`${normalizedRoot}${sep}`)) continue
      if (entry.isDirectory()) {
        if (current.depth < 12 && !SKIP.has(entry.name)) queue.push({ path: absolute, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      const path = relative(normalizedRoot, absolute).split(sep).join('/')
      files.push(path)
    }
  }
  return files
}

function pruneFileIndexes(): void {
  if (fileIndexes.size <= MAX_CACHED_PROJECTS) return
  const oldest = [...fileIndexes.entries()]
    .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)
    .slice(0, fileIndexes.size - MAX_CACHED_PROJECTS)
  for (const [root] of oldest) fileIndexes.delete(root)
}

function invalidateFileIndex(root: string): number {
  const revision = (fileIndexRevisions.get(root) ?? 0) + 1
  fileIndexRevisions.set(root, revision)
  fileIndexes.delete(root)
  pendingIndexes.delete(root)
  return revision
}

async function getFileIndex(root: string, refresh = false): Promise<string[]> {
  const normalizedRoot = resolve(root)
  const revision = refresh
    ? invalidateFileIndex(normalizedRoot)
    : fileIndexRevisions.get(normalizedRoot) ?? 0
  const now = Date.now()
  const cached = fileIndexes.get(normalizedRoot)
  if (cached && cached.expiresAt > now) {
    cached.lastUsedAt = now
    return cached.files
  }

  const pending = pendingIndexes.get(normalizedRoot)
  if (pending?.revision === revision) return pending.promise

  const next = buildFileIndex(normalizedRoot)
    .then((files) => {
      if ((fileIndexRevisions.get(normalizedRoot) ?? 0) !== revision) return files
      const completedAt = Date.now()
      fileIndexes.set(normalizedRoot, {
        files,
        expiresAt: completedAt + FILE_INDEX_TTL_MS,
        lastUsedAt: completedAt
      })
      pruneFileIndexes()
      return files
    })
    .finally(() => {
      if (pendingIndexes.get(normalizedRoot)?.promise === next) {
        pendingIndexes.delete(normalizedRoot)
      }
    })
  pendingIndexes.set(normalizedRoot, { revision, promise: next })
  return next
}

async function collectFiles(root: string, query: string, refresh = false): Promise<string[]> {
  const needle = query.trim().toLocaleLowerCase()
  const files = await getFileIndex(root, refresh)
  if (!needle) return files.slice(0, MAX_RESULTS)
  return files
    .filter((path) => path.toLocaleLowerCase().includes(needle))
    .slice(0, MAX_RESULTS)
}

function safeRelativePath(root: string, filePath: string): string | null {
  if (!filePath || filePath.length > 1_000 || isAbsolute(filePath) || /[\0\r\n]/.test(filePath)) return null
  const base = resolve(root)
  const target = resolve(base, filePath)
  return target.startsWith(`${base}${sep}`) ? target : null
}

async function readProjectFile(
  root: string,
  filePath: string
): Promise<
  | { ok: true; path: string; content: string; bytes: number; truncated: boolean }
  | { ok: false; error: string }
> {
  const target = safeRelativePath(root, filePath)
  if (!target) return { ok: false, error: 'Invalid project file.' }
  try {
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)])
    if (!canonicalTarget.startsWith(`${canonicalRoot}${sep}`)) {
      return { ok: false, error: 'The selected file resolves outside this project.' }
    }
    const info = await stat(canonicalTarget)
    if (!info.isFile()) return { ok: false, error: 'The selected path is not a file.' }
    if (info.size > MAX_FILE_BYTES) return { ok: false, error: 'This file is too large for the in-app reviewer.' }
    const extension = extname(canonicalTarget).toLocaleLowerCase()
    if (extension && !TEXT_EXTENSIONS.has(extension)) {
      return { ok: false, error: 'Binary files cannot be opened in the code reviewer.' }
    }
    const content = await readFile(canonicalTarget, 'utf8')
    if (content.includes('\0')) return { ok: false, error: 'Binary files cannot be opened in the code reviewer.' }
    return {
      ok: true,
      path: filePath.split(sep).join('/'),
      content: content.slice(0, MAX_FILE_CHARS),
      bytes: info.size,
      truncated: content.length > MAX_FILE_CHARS
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerProjectFilesIpc(): void {
  ipcMain.handle('projects:files', async (_event, args: unknown): Promise<string[]> => {
    const input = args && typeof args === 'object'
      ? args as { projectId?: unknown; query?: unknown; refresh?: unknown }
      : {}
    if (typeof input.projectId !== 'string' || !/^[\w-]{1,64}$/.test(input.projectId)) return []
    if (input.query !== undefined && typeof input.query !== 'string') return []
    if (input.refresh !== undefined && typeof input.refresh !== 'boolean') return []
    const root = projectPath(input.projectId)
    if (!root) return []
    return collectFiles(root, (input.query ?? '').slice(0, 160), input.refresh === true)
  })
  ipcMain.handle('projects:readFile', async (_event, args: unknown) => {
    const input = args && typeof args === 'object'
      ? args as { projectId?: unknown; filePath?: unknown }
      : {}
    if (
      typeof input.projectId !== 'string' ||
      !/^[\w-]{1,64}$/.test(input.projectId) ||
      typeof input.filePath !== 'string'
    ) {
      return { ok: false, error: 'Invalid project file request.' }
    }
    const root = projectPath(input.projectId)
    if (!root) return { ok: false, error: 'Project not found.' }
    return readProjectFile(root, input.filePath)
  })
}
