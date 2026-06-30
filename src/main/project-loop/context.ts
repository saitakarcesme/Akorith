import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

// Phase 48: read-only project inspection. Produces a bounded workspace-context
// string for the planner — a shallow file tree + a few key files. Never reads
// secrets, node_modules, .git, or huge files.

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage', '.cache', 'vendor', 'target'])
const MAX_ENTRIES = 200
const MAX_DEPTH = 4
const KEY_FILES = ['package.json', 'README.md', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']
const MAX_KEY_FILE_BYTES = 4_000

export interface ProjectContext {
  exists: boolean
  fileTree: string[]
  keyFiles: { path: string; excerpt: string }[]
}

function walk(root: string, dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries.sort()) {
    if (out.length >= MAX_ENTRIES) return
    if (name.startsWith('.') && name !== '.github') continue
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    const rel = relative(root, full)
    out.push(isDir ? `${rel}/` : rel)
    if (isDir) walk(root, full, depth + 1, out)
  }
}

export function inspectProject(root: string): ProjectContext {
  if (!existsSync(root)) return { exists: false, fileTree: [], keyFiles: [] }
  const fileTree: string[] = []
  walk(root, root, 0, fileTree)
  const keyFiles: { path: string; excerpt: string }[] = []
  for (const key of KEY_FILES) {
    const p = join(root, key)
    if (!existsSync(p)) continue
    try {
      const text = readFileSync(p, 'utf8').slice(0, MAX_KEY_FILE_BYTES)
      keyFiles.push({ path: key, excerpt: text })
    } catch {
      /* skip unreadable */
    }
  }
  return { exists: true, fileTree, keyFiles }
}

/** Render a compact context string for the planner prompt. */
export function renderProjectContext(ctx: ProjectContext): string {
  if (!ctx.exists) return 'The project directory does not exist yet (it will be scaffolded).'
  const tree = ctx.fileTree.length ? ctx.fileTree.join('\n') : '(empty directory)'
  const keys = ctx.keyFiles.map((k) => `--- ${k.path} ---\n${k.excerpt}`).join('\n\n')
  return `File tree (bounded):\n${tree}\n\n${keys}`.trim()
}
