import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  readSync
} from 'fs'
import { join, relative, resolve, sep } from 'path'

// Phase 48: read-only project inspection. Produces a bounded workspace-context
// string for the planner — a shallow file tree + a few key files. Never reads
// secrets, node_modules, .git, or huge files.

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'release',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.vite',
  '.cache',
  '.pytest_cache',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  'target',
  'bin',
  'obj'
])
const MAX_ENTRIES = 200
const MAX_DEPTH = 4
const KEY_FILES = ['package.json', 'README.md', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']
const MAX_KEY_FILE_BYTES = 4_000
const MAX_SOURCE_FILES = 8
const MAX_SOURCE_FILE_BYTES = 3_000
const MAX_SOURCE_TOTAL_BYTES = 16_000
const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?|py|html?|css|scss|sass|less|vue|svelte|rs|go|java|kt|kts|cs|c|cc|cpp|h|hpp|swift|rb|php|sql|sh|ps1)$/i
const SOURCE_ENTRY_RE = /(^|\/)(?:index|main|app|server|client)\.[^/]+$/i
const SECRET_FILE_RE =
  /(^|\/)\.env(?:$|[._-])|(^|\/)(?:credentials?|secrets?|secret|service[-_.]?account(?:[-_.][^/]*)?)(?:$|\/|[._-])|(?:^|\/)id_(?:rsa|ed25519)(?:\.pub)?$|\.(?:pem|key|p12|pfx)$/i

export interface ProjectContext {
  exists: boolean
  fileTree: string[]
  keyFiles: { path: string; excerpt: string }[]
  sourceFiles: { path: string; excerpt: string }[]
}

function comparablePath(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function pathIsWithin(root: string, candidate: string): boolean {
  const safeRoot = comparablePath(root)
  const safeCandidate = comparablePath(candidate)
  return safeCandidate === safeRoot || safeCandidate.startsWith(`${safeRoot}${sep}`)
}

function safeRegularProjectFile(root: string, path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) return false
    const real = realpathSync.native(path)
    return pathIsWithin(root, real)
  } catch {
    return false
  }
}

function readBoundedText(root: string, path: string, maxBytes: number): string | null {
  let file: number | null = null
  try {
    if (!safeRegularProjectFile(root, path)) return null
    file = openSync(path, 'r')
    const opened = fstatSync(file)
    if (!opened.isFile() || opened.nlink > 1) return null
    const buffer = Buffer.allocUnsafe(maxBytes)
    const bytesRead = readSync(file, buffer, 0, maxBytes, 0)
    const content = buffer.subarray(0, bytesRead)
    if (content.includes(0)) return null
    let text = content.toString('utf8')
    while (Buffer.byteLength(text, 'utf8') > maxBytes) text = text.slice(0, -1)
    return text
  } catch {
    return null
  } finally {
    if (file !== null) {
      try {
        closeSync(file)
      } catch {
        /* skip unreadable files */
      }
    }
  }
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
    if (SKIP_DIRS.has(name.toLowerCase())) continue
    const full = join(dir, name)
    let isDir = false
    try {
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) continue
      isDir = stat.isDirectory()
    } catch {
      continue
    }
    const rel = relative(root, full).replace(/\\/g, '/')
    if (SECRET_FILE_RE.test(rel)) continue
    out.push(isDir ? `${rel}/` : rel)
    if (isDir) walk(root, full, depth + 1, out)
  }
}

export function inspectProject(root: string): ProjectContext {
  if (!existsSync(root)) return { exists: false, fileTree: [], keyFiles: [], sourceFiles: [] }
  let projectRoot: string
  try {
    projectRoot = realpathSync.native(root)
    if (!lstatSync(projectRoot).isDirectory()) {
      return { exists: false, fileTree: [], keyFiles: [], sourceFiles: [] }
    }
  } catch {
    return { exists: false, fileTree: [], keyFiles: [], sourceFiles: [] }
  }
  const fileTree: string[] = []
  walk(projectRoot, projectRoot, 0, fileTree)
  const keyFiles: { path: string; excerpt: string }[] = []
  for (const key of KEY_FILES) {
    const p = join(projectRoot, key)
    if (!existsSync(p)) continue
    const excerpt = readBoundedText(projectRoot, p, MAX_KEY_FILE_BYTES)
    if (excerpt !== null) keyFiles.push({ path: key, excerpt })
  }
  const keyFileSet = new Set(KEY_FILES.map((file) => file.toLowerCase()))
  const sourceFiles: { path: string; excerpt: string }[] = []
  let remainingSourceBytes = MAX_SOURCE_TOTAL_BYTES
  const candidates = fileTree
    .filter((file) => SOURCE_FILE_RE.test(file) && !keyFileSet.has(file.toLowerCase()))
    .sort((left, right) => {
      const leftPriority = SOURCE_ENTRY_RE.test(left) ? 0 : left.startsWith('src/') ? 1 : 2
      const rightPriority = SOURCE_ENTRY_RE.test(right) ? 0 : right.startsWith('src/') ? 1 : 2
      return leftPriority - rightPriority || left.localeCompare(right)
    })
  for (const file of candidates) {
    if (sourceFiles.length >= MAX_SOURCE_FILES || remainingSourceBytes <= 0) break
    const excerpt = readBoundedText(
      projectRoot,
      join(projectRoot, file),
      Math.min(MAX_SOURCE_FILE_BYTES, remainingSourceBytes)
    )
    if (!excerpt?.trim()) continue
    sourceFiles.push({ path: file, excerpt })
    remainingSourceBytes -= Buffer.byteLength(excerpt, 'utf8')
  }
  return { exists: true, fileTree, keyFiles, sourceFiles }
}

/** Render a compact context string for the planner prompt. */
export function renderProjectContext(ctx: ProjectContext): string {
  if (!ctx.exists) return 'The project directory does not exist yet (it will be scaffolded).'
  const tree = ctx.fileTree.length ? ctx.fileTree.join('\n') : '(empty directory)'
  const keys = ctx.keyFiles.map((k) => `--- ${k.path} ---\n${k.excerpt}`).join('\n\n')
  const sources = ctx.sourceFiles
    .map((file) => `--- ${file.path} ---\n${file.excerpt}`)
    .join('\n\n')
  return [
    `File tree (bounded):\n${tree}`,
    keys ? `Key files (bounded):\n${keys}` : '',
    sources ? `Existing source excerpts (bounded):\n${sources}` : ''
  ].filter(Boolean).join('\n\n')
}
