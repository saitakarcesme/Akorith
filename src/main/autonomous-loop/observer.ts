import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import type { LoopDetectedCommand, RepositorySnapshot } from './types'

const execFileAsync = promisify(execFile)
const MAX_FILES = 10_000
const MAX_SCAN_FILES = 400
const MAX_MARKERS = 300
const MAX_READ_BYTES = 256_000
const DENIED_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', 'coverage', '.cache', '.next', 'target'])
const DEBT_MARKER = /\b(?:TODO|FIXME|HACK|XXX)\b[:\s-]*(.*)/i

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.c': 'C', '.h': 'C/C++', '.cc': 'C++', '.cpp': 'C++', '.cxx': 'C++', '.hpp': 'C++',
  '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.js': 'JavaScript', '.jsx': 'JavaScript',
  '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.py': 'Python', '.rs': 'Rust', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift',
  '.cs': 'C#', '.vue': 'Vue', '.svelte': 'Svelte', '.html': 'HTML', '.css': 'CSS',
  '.scss': 'SCSS', '.sql': 'SQL', '.sh': 'Shell', '.ps1': 'PowerShell', '.md': 'Markdown'
})

interface PackageJsonShape {
  scripts?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
}

function slash(value: string): string {
  return value.split(sep).join('/')
}

function safeRelative(root: string, path: string): string | null {
  const value = relative(root, path)
  if (!value || value === '.' || value.startsWith(`..${sep}`) || value === '..') return null
  return slash(value)
}

async function git(root: string, args: readonly string[], timeout = 8_000): Promise<string | null> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      maxBuffer: 4 * 1024 * 1024
    })
    return result.stdout
  } catch {
    return null
  }
}

async function fallbackFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (directory: string): Promise<void> => {
    if (found.length >= MAX_FILES) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (found.length >= MAX_FILES || DENIED_DIRS.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const rel = safeRelative(root, path)
        if (rel) found.push(rel)
      }
    }
  }
  await walk(root)
  return found.sort((a, b) => a.localeCompare(b))
}

async function listRepositoryFiles(root: string): Promise<string[]> {
  const output = await git(root, ['ls-files', '-co', '--exclude-standard', '-z'])
  if (output === null) return fallbackFiles(root)
  return [...new Set(output.split('\0').map((item) => slash(item.trim())).filter(Boolean))]
    .slice(0, MAX_FILES)
    .sort((a, b) => a.localeCompare(b))
}

async function readBounded(path: string, maxBytes = MAX_READ_BYTES): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > maxBytes) return null
    const content = await readFile(path, 'utf8')
    return content.includes('\0') ? null : content
  } catch {
    return null
  }
}

function packageCommands(scripts: Record<string, string>): LoopDetectedCommand[] {
  const commands: LoopDetectedCommand[] = []
  const mappings: { kind: LoopDetectedCommand['kind']; names: string[] }[] = [
    { kind: 'test', names: ['test'] },
    { kind: 'lint', names: ['lint'] },
    { kind: 'typecheck', names: ['typecheck', 'type-check', 'check:types'] },
    { kind: 'build', names: ['build'] }
  ]
  for (const mapping of mappings) {
    const name = mapping.names.find((candidate) => scripts[candidate])
    if (name) commands.push({ kind: mapping.kind, command: `npm run ${name}`, source: `package.json#scripts.${name}` })
  }
  return commands
}

function uniqueCommands(commands: LoopDetectedCommand[]): LoopDetectedCommand[] {
  const seen = new Set<string>()
  return commands.filter((command) => {
    const key = `${command.kind}:${command.command}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function detectFrameworks(dependencies: readonly string[], files: readonly string[]): string[] {
  const all = new Set(dependencies.map((item) => item.toLowerCase()))
  const frameworks: string[] = []
  const dependencyMatches: [string, string[]][] = [
    ['React', ['react']], ['Next.js', ['next']], ['Vue', ['vue']], ['Svelte', ['svelte']],
    ['Electron', ['electron']], ['Express', ['express']], ['Fastify', ['fastify']],
    ['NestJS', ['@nestjs/core']], ['Django', ['django']], ['Flask', ['flask']], ['FastAPI', ['fastapi']]
  ]
  for (const [label, names] of dependencyMatches) if (names.some((name) => all.has(name))) frameworks.push(label)
  if (files.includes('Cargo.toml')) frameworks.push('Cargo')
  if (files.includes('go.mod')) frameworks.push('Go modules')
  if (files.includes('pom.xml')) frameworks.push('Maven')
  if (files.some((file) => /(^|\/)build\.gradle(?:\.kts)?$/.test(file))) frameworks.push('Gradle')
  return [...new Set(frameworks)]
}

async function packageMetadata(root: string): Promise<{
  scripts: Record<string, string>
  dependencies: string[]
}> {
  const raw = await readBounded(join(root, 'package.json'))
  if (!raw) return { scripts: {}, dependencies: [] }
  try {
    const parsed = JSON.parse(raw) as PackageJsonShape
    const scripts = Object.fromEntries(
      Object.entries(parsed.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
    return { scripts, dependencies: [...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})] }
  } catch {
    return { scripts: {}, dependencies: [] }
  }
}

async function debtMarkers(root: string, files: readonly string[]): Promise<RepositorySnapshot['todoItems']> {
  const items: RepositorySnapshot['todoItems'] = []
  const candidates = files.filter((file) => LANGUAGE_BY_EXTENSION[extname(file).toLowerCase()]).slice(0, MAX_SCAN_FILES)
  for (const file of candidates) {
    if (items.length >= MAX_MARKERS) break
    const content = await readBounded(join(root, file))
    if (!content) continue
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const match = line.match(DEBT_MARKER)
      if (!match) continue
      items.push({ file, line: index + 1, text: (match[1] || line).trim().slice(0, 300) })
      if (items.length >= MAX_MARKERS) break
    }
  }
  return items
}

function detectedCommands(files: readonly string[], scripts: Record<string, string>): LoopDetectedCommand[] {
  const commands = packageCommands(scripts)
  if (files.includes('pyproject.toml') || files.includes('pytest.ini')) {
    commands.push({ kind: 'test', command: 'python -m pytest', source: 'Python project files' })
  }
  if (files.includes('Cargo.toml')) {
    commands.push({ kind: 'test', command: 'cargo test', source: 'Cargo.toml' })
    commands.push({ kind: 'build', command: 'cargo build', source: 'Cargo.toml' })
  }
  if (files.includes('go.mod')) {
    commands.push({ kind: 'test', command: 'go test ./...', source: 'go.mod' })
    commands.push({ kind: 'build', command: 'go build ./...', source: 'go.mod' })
  }
  if (files.includes('pom.xml')) {
    commands.push({ kind: 'test', command: 'mvn test', source: 'pom.xml' })
    commands.push({ kind: 'build', command: 'mvn package -DskipTests', source: 'pom.xml' })
  }
  if (files.some((file) => /(^|\/)gradlew(?:\.bat)?$/.test(file))) {
    const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
    commands.push({ kind: 'test', command: `${wrapper} test`, source: 'Gradle wrapper' })
    commands.push({ kind: 'build', command: `${wrapper} build -x test`, source: 'Gradle wrapper' })
  }
  return uniqueCommands(commands)
}

export interface ObserveRepositoryOptions {
  repositoryId: string
  now?: number
}

export async function observeRepository(rootInput: string, options: ObserveRepositoryOptions): Promise<RepositorySnapshot> {
  const absolute = resolve(rootInput)
  const root = await realpath(absolute)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory()) throw new Error('Loop repository root is not a directory.')

  const files = await listRepositoryFiles(root)
  const packageData = await packageMetadata(root)
  const languageCounts = new Map<string, number>()
  for (const file of files) {
    const language = LANGUAGE_BY_EXTENSION[extname(file).toLowerCase()]
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1)
  }

  const statusOutput = await git(root, ['status', '--porcelain=v1'])
  const branch = (await git(root, ['branch', '--show-current']))?.trim() || 'main'
  const headSha = (await git(root, ['rev-parse', '--verify', 'HEAD']))?.trim() || null
  const recentCommits = (await git(root, ['log', '--oneline', '-n', '20']))
    ?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? []
  const readmeName = files.find((file) => /^readme(?:\.[^/]+)?$/i.test(basename(file)))
  const readmeExcerpt = readmeName ? (await readBounded(join(root, readmeName), 64_000))?.slice(0, 24_000) ?? null : null
  const packageManagers = [
    files.includes('package-lock.json') ? 'npm' : null,
    files.includes('pnpm-lock.yaml') ? 'pnpm' : null,
    files.includes('yarn.lock') ? 'yarn' : null,
    files.includes('bun.lockb') || files.includes('bun.lock') ? 'bun' : null,
    files.includes('poetry.lock') ? 'poetry' : null,
    files.includes('uv.lock') ? 'uv' : null,
    files.includes('Cargo.lock') ? 'cargo' : null,
    files.includes('go.mod') ? 'go' : null,
    files.includes('pom.xml') ? 'maven' : null
  ].filter((item): item is string => Boolean(item))

  return {
    repositoryId: options.repositoryId,
    capturedAt: options.now ?? Date.now(),
    headSha,
    branch,
    dirty: Boolean(statusOutput?.trim()),
    fileCount: files.length,
    files,
    languages: [...languageCounts.entries()]
      .map(([name, count]) => ({ name, files: count }))
      .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
    frameworks: detectFrameworks(packageData.dependencies, files),
    packageManagers,
    packageScripts: packageData.scripts,
    detectedCommands: detectedCommands(files, packageData.scripts),
    readmeExcerpt,
    recentCommits,
    todoItems: await debtMarkers(root, files),
    buildStatus: 'unknown',
    testStatus: detectedCommands(files, packageData.scripts).some((command) => command.kind === 'test')
      ? 'unknown'
      : 'not_configured',
    dependencySignals: packageManagers.length === 0 ? ['No recognized dependency lock or package manager metadata.'] : [],
    routes: files.filter((file) => /(^|\/)(routes?|pages?|app)\//i.test(file)).slice(0, 500),
    components: files.filter((file) => /(^|\/)components?\//i.test(file)).slice(0, 500)
  }
}
