import { ipcMain } from 'electron'
import { readdir } from 'fs/promises'
import { join, relative, resolve, sep } from 'path'
import { listProjects } from './db'

const SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache', 'vendor'])
const MAX_VISITED = 4_000
const MAX_RESULTS = 200
const FILE_INDEX_TTL_MS = 5_000
const MAX_CACHED_PROJECTS = 12

interface ProjectFileIndex {
  files: string[]
  expiresAt: number
  lastUsedAt: number
}

const fileIndexes = new Map<string, ProjectFileIndex>()
const pendingIndexes = new Map<string, Promise<string[]>>()

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

async function getFileIndex(root: string): Promise<string[]> {
  const normalizedRoot = resolve(root)
  const now = Date.now()
  const cached = fileIndexes.get(normalizedRoot)
  if (cached && cached.expiresAt > now) {
    cached.lastUsedAt = now
    return cached.files
  }

  const pending = pendingIndexes.get(normalizedRoot)
  if (pending) return pending

  const next = buildFileIndex(normalizedRoot)
    .then((files) => {
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
      pendingIndexes.delete(normalizedRoot)
    })
  pendingIndexes.set(normalizedRoot, next)
  return next
}

async function collectFiles(root: string, query: string): Promise<string[]> {
  const needle = query.trim().toLocaleLowerCase()
  const files = await getFileIndex(root)
  if (!needle) return files.slice(0, MAX_RESULTS)
  return files
    .filter((path) => path.toLocaleLowerCase().includes(needle))
    .slice(0, MAX_RESULTS)
}

export function registerProjectFilesIpc(): void {
  ipcMain.handle('projects:files', async (_event, args: unknown): Promise<string[]> => {
    const input = args && typeof args === 'object' ? args as { projectId?: unknown; query?: unknown } : {}
    if (typeof input.projectId !== 'string' || !/^[\w-]{1,64}$/.test(input.projectId)) return []
    if (input.query !== undefined && typeof input.query !== 'string') return []
    const root = projectPath(input.projectId)
    if (!root) return []
    return collectFiles(root, (input.query ?? '').slice(0, 160))
  })
}
