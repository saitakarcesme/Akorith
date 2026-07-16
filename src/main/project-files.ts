import { ipcMain } from 'electron'
import { readdir } from 'fs/promises'
import { join, relative, resolve, sep } from 'path'
import { listProjects } from './db'

const SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache', 'vendor'])
const MAX_VISITED = 4_000
const MAX_RESULTS = 200

function projectPath(projectId: string): string | null {
  return listProjects().find((project) => project.id === projectId)?.path ?? null
}

async function collectFiles(root: string, query: string): Promise<string[]> {
  const normalizedRoot = resolve(root)
  const needle = query.trim().toLocaleLowerCase()
  const results: string[] = []
  const queue: { path: string; depth: number }[] = [{ path: normalizedRoot, depth: 0 }]
  let visited = 0
  while (queue.length && visited < MAX_VISITED && results.length < MAX_RESULTS) {
    const current = queue.shift()!
    let entries
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (visited++ >= MAX_VISITED || results.length >= MAX_RESULTS) break
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
      if (!needle || path.toLocaleLowerCase().includes(needle)) results.push(path)
    }
  }
  return results
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
