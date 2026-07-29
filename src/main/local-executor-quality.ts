import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import type {
  LocalCommandResult,
  LocalExecutorAction,
  LocalExecutorCommand,
  LocalExecutorOperation,
  LocalExecutorRollbackEntry,
  LocalExecutorScore
} from './local-executor'
import { isCliTimeoutError, resolveCliLaunch, runCli } from './providers/util'

const MAX_FILES_PER_ATTEMPT = 12
const MAX_FILE_CONTENT_CHARS = 1_500_000
const MAX_COMMAND_OUTPUT_CHARS = 24_000
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const PYTHON_AST_SYNTAX_HELPER =
  'import ast,pathlib,sys\nfor path in sys.argv[1:]: ast.parse(pathlib.Path(path).read_text(encoding="utf-8"), filename=path)'
const MAX_FEATURE_SCAN_FILES = 160
const MAX_FEATURE_SCAN_CHARS = 2_000_000
const MIN_COMPLEX_BUILD_CONTENT_CHARS = 1_500
const PROTECTED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'coverage'
])
const SECRET_FILE_RE =
  /(^|[\\/])\.env($|[\\/_.-])|(^|[\\/])(?:credentials?|secrets?|service[-_.]?account(?:[-_.][^\\/]*)?)(?:$|[\\/]|[._-])|\.(?:pem|key|p12|pfx)$|(^|[\\/])id_(?:rsa|ed25519)(?:\.pub)?$/i

export interface ResolvedLocalExecutorFileAction {
  path: string
  absolutePath: string
  workspaceRoot: string
  operation: LocalExecutorOperation
  content?: string
}

export interface LocalExecutorRollbackResult {
  ok: boolean
  errors: string[]
}

interface ValidationCommandPolicy {
  allowed: boolean
  reason: string
  executable?: string
  args?: string[]
}

function boundedValidationOutput(text: string, max = MAX_COMMAND_OUTPUT_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[output truncated: ${text.length - max} chars omitted]`
}

function stripValidationAnsi(text: string): string {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\r/g, '')
}

function normalizeRelPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').trim()
}

function comparablePath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function pathIsWithin(root: string, candidate: string): boolean {
  const comparableRoot = comparablePath(root)
  const comparableCandidate = comparablePath(candidate)
  return (
    comparableCandidate === comparableRoot ||
    comparableCandidate.startsWith(`${comparableRoot}${sep}`)
  )
}

function assertNoWorkspaceLinkEscape(root: string, absolutePath: string): void {
  if (!pathIsWithin(root, absolutePath)) {
    throw new Error('path escapes the selected workspace')
  }
  const rel = relative(root, absolutePath)
  let current = root
  for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, segment)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') break
      throw error
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${relative(root, current)} is a symbolic link or junction`)
    }
    if (stat.isFile() && stat.nlink > 1) {
      throw new Error(`${relative(root, current)} is a hard-linked file`)
    }
    const real = realpathSync.native(current)
    if (!pathIsWithin(root, real)) {
      throw new Error(`${relative(root, current)} resolves outside the selected workspace`)
    }
  }
}

function resolveWorkspacePath(
  workspaceDir: string,
  requestedPath: string
):
  | { ok: true; path: string; absolutePath: string; workspaceRoot: string }
  | { ok: false; error: string } {
  let root: string
  try {
    root = realpathSync.native(workspaceDir)
  } catch {
    return { ok: false, error: 'Workspace folder cannot be resolved safely.' }
  }
  const clean = normalizeRelPath(requestedPath)
  if (!clean) return { ok: false, error: 'File path is empty.' }
  if (clean.includes('\0') || clean.includes('\n') || clean.includes('\r')) {
    return { ok: false, error: `${requestedPath}: path contains control characters.` }
  }
  if (
    isAbsolute(requestedPath) ||
    /^[a-zA-Z]:/.test(requestedPath) ||
    requestedPath.startsWith('\\\\') ||
    requestedPath.startsWith('//')
  ) {
    return {
      ok: false,
      error: `${requestedPath}: absolute and drive-relative paths are not allowed.`
    }
  }
  const absolutePath = resolve(root, clean)
  const rel = relative(root, absolutePath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return {
      ok: false,
      error: `${requestedPath}: path traversal outside the workspace is blocked.`
    }
  }
  const segments = rel.split(/[\\/]+/).filter(Boolean)
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, error: `${requestedPath}: path traversal is blocked.` }
  }
  if (segments.some((segment) => segment.includes(':'))) {
    return {
      ok: false,
      error: `${requestedPath}: NTFS alternate streams and colon paths are blocked.`
    }
  }
  if (
    process.platform === 'win32' &&
    segments.some((segment) => /[ .]$/.test(segment))
  ) {
    return {
      ok: false,
      error: `${requestedPath}: trailing-dot and trailing-space path aliases are blocked.`
    }
  }
  const protectedSegment = segments.find((segment) =>
    PROTECTED_SEGMENTS.has(segment.replace(/[ .]+$/g, '').toLowerCase())
  )
  if (protectedSegment) {
    return {
      ok: false,
      error: `${requestedPath}: writing inside ${protectedSegment} is blocked.`
    }
  }
  if (SECRET_FILE_RE.test(rel)) {
    return { ok: false, error: `${requestedPath}: secret-like files are blocked.` }
  }
  try {
    assertNoWorkspaceLinkEscape(root, absolutePath)
  } catch (error) {
    return {
      ok: false,
      error: `${requestedPath}: ${error instanceof Error ? error.message : String(error)}.`
    }
  }
  return { ok: true, path: rel.split(sep).join('/'), absolutePath, workspaceRoot: root }
}

export function validateLocalExecutorAction(
  workspaceDir: string,
  action: LocalExecutorAction
):
  | { ok: true; files: ResolvedLocalExecutorFileAction[]; warnings: string[] }
  | { ok: false; errors: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!existsSync(workspaceDir) || !lstatSync(workspaceDir).isDirectory()) {
    return { ok: false, errors: ['Workspace folder does not exist.'] }
  }
  if (action.type !== 'workspace_patch') errors.push('Action type must be workspace_patch.')
  if (!action.summary.trim()) errors.push('Action summary is required.')
  if (!Array.isArray(action.files) || action.files.length === 0) {
    errors.push('At least one file action is required.')
  }
  if (action.files.length > MAX_FILES_PER_ATTEMPT) {
    errors.push(
      `Too many files in one attempt (${action.files.length}/${MAX_FILES_PER_ATTEMPT}).`
    )
  }

  const seen = new Set<string>()
  const files: ResolvedLocalExecutorFileAction[] = []
  for (const file of action.files) {
    const resolved = resolveWorkspacePath(workspaceDir, file.path)
    if (!resolved.ok) {
      errors.push(resolved.error)
      continue
    }
    const identityPath =
      process.platform === 'win32' ? resolved.path.toLowerCase() : resolved.path
    if (seen.has(identityPath)) {
      errors.push(`${file.path}: duplicate file action.`)
      continue
    }
    seen.add(identityPath)
    if (file.operation === 'delete') {
      if (!existsSync(resolved.absolutePath)) {
        errors.push(`${file.path}: delete target does not exist.`)
      } else if (!lstatSync(resolved.absolutePath).isFile()) {
        errors.push(`${file.path}: only single-file deletes are allowed.`)
      }
    } else if (typeof file.content !== 'string') {
      errors.push(`${file.path}: create/modify requires full file content.`)
    } else if (file.content.length > MAX_FILE_CONTENT_CHARS) {
      errors.push(`${file.path}: content is too large for one local executor attempt.`)
    }
    files.push({
      ...file,
      path: resolved.path,
      absolutePath: resolved.absolutePath,
      workspaceRoot: resolved.workspaceRoot
    })
  }

  for (const command of action.commands ?? []) {
    const policy = commandPolicy(command.cmd)
    if (!policy.allowed) warnings.push(`${command.cmd}: ${policy.reason}`)
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, files, warnings }
}

export function applyValidatedFiles(
  files: ResolvedLocalExecutorFileAction[]
): { changedFiles: string[]; rollback: LocalExecutorRollbackEntry[] } {
  const rollback: LocalExecutorRollbackEntry[] = []
  const changedFiles: string[] = []
  for (const file of files) {
    assertNoWorkspaceLinkEscape(file.workspaceRoot, file.absolutePath)
    const existed = existsSync(file.absolutePath)
    const previous =
      existed && lstatSync(file.absolutePath).isFile()
        ? readFileSync(file.absolutePath, 'utf8')
        : null
    rollback.push({
      absolutePath: file.absolutePath,
      workspaceRoot: file.workspaceRoot,
      existed,
      content: previous
    })
    if (file.operation === 'delete') {
      if (existed) {
        rmSync(file.absolutePath)
        changedFiles.push(file.path)
      }
      continue
    }
    const next = file.content ?? ''
    if (previous === next) continue
    mkdirSync(dirname(file.absolutePath), { recursive: true })
    assertNoWorkspaceLinkEscape(file.workspaceRoot, file.absolutePath)
    writeFileSync(file.absolutePath, next, 'utf8')
    changedFiles.push(file.path)
  }
  return { changedFiles, rollback }
}

export function rollbackLocalExecutorPatch(
  rollback: LocalExecutorRollbackEntry[]
): LocalExecutorRollbackResult {
  const errors: string[] = []
  for (const entry of [...rollback].reverse()) {
    try {
      if (entry.workspaceRoot) {
        assertNoWorkspaceLinkEscape(entry.workspaceRoot, entry.absolutePath)
      }
      if (entry.existed) {
        mkdirSync(dirname(entry.absolutePath), { recursive: true })
        if (entry.workspaceRoot) {
          assertNoWorkspaceLinkEscape(entry.workspaceRoot, entry.absolutePath)
        }
        writeFileSync(entry.absolutePath, entry.content ?? '', 'utf8')
      } else if (existsSync(entry.absolutePath)) {
        rmSync(entry.absolutePath)
      }
    } catch (error) {
      errors.push(
        `${entry.absolutePath}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return { ok: errors.length === 0, errors }
}

function tokenizeValidationCommand(text: string): string[] | null {
  const tokens: string[] = []
  const tokenRe = /"([^"]*)"|'([^']*)'|([^\s"']+)/g
  let cursor = 0
  for (const match of text.matchAll(tokenRe)) {
    const index = match.index ?? 0
    if (text.slice(cursor, index).trim()) return null
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
    cursor = index + match[0].length
  }
  if (text.slice(cursor).trim()) return null
  return tokens
}

function safeValidationPath(value: string, extension: RegExp): boolean {
  if (
    !value ||
    value.includes('\0') ||
    value.includes(':') ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//') ||
    !extension.test(value)
  ) {
    return false
  }
  const segments = value.replace(/\\/g, '/').split('/').filter(Boolean)
  return (
    segments.length > 0 &&
    !segments.some(
      (segment) =>
        segment === '..' ||
        PROTECTED_SEGMENTS.has(segment.replace(/[ .]+$/g, '').toLowerCase()) ||
        /[ .]$/.test(segment)
    ) &&
    !SECRET_FILE_RE.test(value)
  )
}

function commandPolicy(cmd: string): ValidationCommandPolicy {
  if (/[\0-\x08\x0a-\x1f\x7f;&|<>`$%!\^]/.test(cmd)) {
    return {
      allowed: false,
      reason:
        'shell chaining, expansion, variables, control characters, and redirects are blocked'
    }
  }
  const text = cmd.trim()
  if (!text) return { allowed: false, reason: 'empty command' }
  const tokens = tokenizeValidationCommand(text)
  if (!tokens?.length) {
    return { allowed: false, reason: 'validation command has invalid quoting' }
  }
  const executable = tokens[0].toLowerCase()
  if (
    (executable === 'node' || executable === 'node.exe') &&
    tokens.length === 3 &&
    tokens[1] === '--check' &&
    safeValidationPath(tokens[2], /\.(?:js|cjs|mjs)$/i)
  ) {
    return {
      allowed: true,
      reason: 'syntax-only JavaScript validation',
      executable: 'node',
      args: ['--check', tokens[2]]
    }
  }
  if (
    ['python', 'python3', 'py'].includes(executable) &&
    tokens.length >= 6 &&
    tokens[1] === '-I' &&
    tokens[2] === '-S' &&
    tokens[3] === '-m' &&
    tokens[4] === 'py_compile' &&
    tokens.slice(5).every((path) => safeValidationPath(path, /\.py$/i))
  ) {
    return {
      allowed: true,
      reason: 'isolated syntax-only Python validation',
      executable,
      args: ['-I', '-S', '-m', 'py_compile', ...tokens.slice(5)]
    }
  }
  return {
    allowed: false,
    reason:
      'only node --check and isolated Python -I -S py_compile syntax checks are allowed'
  }
}

export function isAllowedLocalExecutorCommand(cmd: string): boolean {
  return commandPolicy(cmd).allowed
}

function dedupeCommands(commands: LocalExecutorCommand[]): LocalExecutorCommand[] {
  const seen = new Set<string>()
  const out: LocalExecutorCommand[] = []
  for (const command of commands) {
    const cmd = command.cmd.trim().replace(/\s+/g, ' ')
    if (!cmd || seen.has(cmd)) continue
    seen.add(cmd)
    out.push({ cmd, reason: command.reason?.trim() || undefined })
  }
  return out.slice(0, 8)
}

function trustedPythonCommand(workspaceDir: string): string | null {
  for (const command of ['python', 'python3', 'py']) {
    try {
      resolveCliLaunch(command, process.env, workspaceDir)
      return command
    } catch {
      // Python validation is optional; try the next fixed executable name.
    }
  }
  return null
}

async function runOneCommand(
  workspaceDir: string,
  command: LocalExecutorCommand,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<LocalCommandResult> {
  const policy = commandPolicy(command.cmd)
  const started = Date.now()
  if (!policy.allowed || !policy.executable || !policy.args) {
    return {
      cmd: command.cmd,
      reason: command.reason ?? null,
      allowed: false,
      passed: false,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      stdout: '',
      stderr: '',
      error: policy.reason
    }
  }
  const isPython = ['python', 'python3', 'py'].includes(policy.executable)
  const actualArgs = isPython
    ? ['-I', '-S', '-c', PYTHON_AST_SYNTAX_HELPER, ...policy.args.slice(4)]
    : policy.args
  try {
    const result = await runCli(policy.executable, actualArgs, {
      cwd: workspaceDir,
      signal,
      timeoutMs,
      env: {
        CI: process.env.CI ?? '1'
      },
      unsetEnv: [
        'NODE_OPTIONS',
        'NODE_PATH',
        'PYTHONHOME',
        'PYTHONPATH',
        'PYTHONSTARTUP',
        'PYTHONINSPECT'
      ]
    })
    return {
      cmd: command.cmd,
      reason: command.reason ?? null,
      allowed: true,
      passed: result.code === 0,
      exitCode: result.code,
      timedOut: false,
      durationMs: Date.now() - started,
      stdout: boundedValidationOutput(stripValidationAnsi(result.stdout)),
      stderr: boundedValidationOutput(stripValidationAnsi(result.stderr)),
      error: result.code === 0 ? null : `exit ${result.code ?? 'unknown'}`
    }
  } catch (error) {
    return {
      cmd: command.cmd,
      reason: command.reason ?? null,
      allowed: true,
      passed: false,
      exitCode: null,
      timedOut: isCliTimeoutError(error),
      durationMs: Date.now() - started,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function runLocalValidationCommands(
  workspaceDir: string,
  commands: LocalExecutorCommand[],
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<LocalCommandResult[]> {
  const results: LocalCommandResult[] = []
  for (const command of commands) {
    if (signal?.aborted) break
    results.push(await runOneCommand(workspaceDir, command, timeoutMs, signal))
  }
  return results
}

const DOC_FILE_RE =
  /(^|[\\/])(readme|changelog|license)(\.[^.\\/]+)?$|\.(md|mdx|txt|rst)$/i
const DOC_GOAL_RE =
  /\b(doc|docs|documentation|readme|changelog|copy|guide|manual|text)\b/i
const PLACEHOLDER_CONTENT_RE =
  /\b(?:code|logic|styles?|content|implementation)\s+(?:will\s+go|goes)\s+here\b|\bnot\s+implemented\b|\b(?:todo|fixme)\b\s*[:\-]?\s*(?:implement|add|finish|complete)\b/i
const COMPLEX_BUILD_RE =
  /\b(?:build|create|develop|implement|complete|playable|full|production-ready)\b|(?:olu\u015ftur|gelistir|geli\u015ftir|uygula|tamamla|oynanabilir|\byap\b)/i
const BUILD_ARTIFACT_RE =
  /\b(?:app|application|game|website|dashboard|project)\b|(?:uygulama|oyun|web\s*site|internet\s*site|proje)/i
const GAME_GOAL_RE = /\bgame\b|oyun/i
const SHOOTER_GOAL_RE =
  /\bcall\s+of\s+duty\b|\b(?:fps|shooter)\b|(?:ni\u015fanc\u0131|nisanci|at\u0131\u015f|atis|sava\u015f\s*oyun|savas\s*oyun)/i

interface ExecutableSource {
  html: string
  css: string
  js: string
}

export interface LocalExecutorQualityArgs {
  action: LocalExecutorAction | null
  parseOk: boolean
  validationErrors: string[]
  patchApplied: boolean
  changedFiles: string[]
  commandResults: LocalCommandResult[]
  goal: string
  workspaceDir?: string
  completionMode?: 'incremental' | 'complete_request'
}

export function sourceValidationCommands(
  _workspaceDir: string,
  changedFiles: string[],
  pythonCommand?: string | null
): LocalExecutorCommand[] {
  const safeFiles = changedFiles.filter(
    (file) =>
      !/[\0\r\n:;&|<>`$%!\^]/.test(file) &&
      !file.startsWith('/') &&
      !file.startsWith('\\\\') &&
      !file.replace(/\\/g, '/').split('/').some((segment) => segment === '..')
  )
  const pythonFiles = safeFiles.filter((file) => /\.py$/i.test(file))
  const displayPath = (file: string): string =>
    /\s/.test(file) ? JSON.stringify(file) : file
  const commands: LocalExecutorCommand[] = safeFiles
    .filter((file) => /\.(?:js|cjs|mjs)$/i.test(file))
    .slice(0, 4)
    .map((file) => ({
      cmd: `node --check ${displayPath(file)}`,
      reason: 'Auto-detected JavaScript syntax validation'
    }))
  if (pythonCommand) {
    commands.push(
      ...pythonFiles
        .slice(0, 4)
        .map((file) => ({
          cmd: `${pythonCommand} -I -S -m py_compile ${displayPath(file)}`,
          reason: 'Auto-detected Python syntax validation'
        }))
    )
  }
  return commands
}

export function prepareLocalValidationCommands(
  workspaceDir: string,
  changedFiles: string[]
): LocalExecutorCommand[] {
  return dedupeCommands(
    sourceValidationCommands(
      workspaceDir,
      changedFiles.filter((file) => existsSync(resolve(workspaceDir, file))),
      trustedPythonCommand(workspaceDir)
    )
  )
}

function sourceKind(path: string): keyof ExecutableSource | null {
  const lower = path.toLowerCase()
  if (/\.html?$/.test(lower)) return 'html'
  if (/\.css$/.test(lower)) return 'css'
  if (/\.(?:cjs|mjs|js|jsx|ts|tsx)$/.test(lower)) return 'js'
  return null
}

function cleanSource(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function readBoundedUtf8(path: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes, 256_000))
    const chunks: Buffer[] = []
    let total = 0
    while (total < maxBytes) {
      const bytesRead = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, maxBytes - total),
        null
      )
      if (bytesRead === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      total += bytesRead
    }
    return Buffer.concat(chunks, total).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // A raced or unreadable project file is skipped; scoring remains safe.
      }
    }
  }
}

function executableSource(
  action: LocalExecutorAction | null,
  workspaceDir?: string
): ExecutableSource {
  const source: ExecutableSource = { html: '', css: '', js: '' }

  if (workspaceDir && existsSync(workspaceDir)) {
    const stack = [workspaceDir]
    let files = 0
    let chars = 0
    while (stack.length > 0 && files < MAX_FEATURE_SCAN_FILES && chars < MAX_FEATURE_SCAN_CHARS) {
      const dir = stack.pop()
      if (!dir) break
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (files >= MAX_FEATURE_SCAN_FILES || chars >= MAX_FEATURE_SCAN_CHARS) break
        if (entry.isDirectory()) {
          if (!PROTECTED_SEGMENTS.has(entry.name) && !entry.name.startsWith('.')) {
            stack.push(resolve(dir, entry.name))
          }
          continue
        }
        if (!entry.isFile()) continue
        const kind = sourceKind(entry.name)
        if (!kind) continue
        const content = readBoundedUtf8(
          resolve(dir, entry.name),
          MAX_FEATURE_SCAN_CHARS - chars
        )
        if (!content) continue
        source[kind] += `\n${cleanSource(content)}`
        chars += content.length
        files += 1
      }
    }
  } else {
    let chars = 0
    for (const file of action?.files ?? []) {
      if (
        chars >= MAX_FEATURE_SCAN_CHARS ||
        file.operation === 'delete' ||
        typeof file.content !== 'string'
      ) {
        continue
      }
      const kind = sourceKind(file.path)
      if (!kind) continue
      const content = file.content.slice(0, MAX_FEATURE_SCAN_CHARS - chars)
      source[kind] += `\n${cleanSource(content)}`
      chars += content.length
    }
  }

  for (const match of source.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    source.js += `\n${match[1]}`
  }
  for (const match of source.html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    source.css += `\n${match[1]}`
  }
  return source
}

function hasNonEmptyClickHandler(js: string): boolean {
  return (
    /addEventListener\(\s*['"]click['"]\s*,\s*[A-Za-z_$][\w$]*/i.test(js) ||
    /addEventListener\(\s*['"]click['"]\s*,\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{?\s*(?!\})[\s\S]{1,240}/i.test(js) ||
    /\.onclick\s*=\s*(?:[A-Za-z_$][\w$]*|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{?\s*(?!\}))/i.test(js)
  )
}

function requestedGameFeatureGapsFromSource(
  goal: string,
  source: ExecutableSource
): string[] {
  if (!GAME_GOAL_RE.test(goal)) return []
  const { html, css, js } = source
  const baseline = SHOOTER_GOAL_RE.test(goal)
  const gaps: string[] = []
  const wants = (pattern: RegExp): boolean => baseline || pattern.test(goal)
  const has = (pattern: RegExp, value = `${html}\n${css}\n${js}`): boolean =>
    pattern.test(value)
  const clickWired = hasNonEmptyClickHandler(js) || /onclick\s*=\s*['"][^'"]+\(/i.test(html)

  if (wants(/\b(?:start|begin|deploy|play)\b|(?:ba\u015flat|baslat)/i)) {
    const hasControl = has(
      /<button\b[^>]*(?:id|class)[^>]*(?:start|begin|deploy|play)|<button\b[^>]*>\s*(?:start|begin|deploy|play|ba\u015flat|baslat)/i,
      html
    )
    if (!hasControl || !clickWired) gaps.push('wired Start control')
  }
  if (wants(/\b(?:restart|retry|reset)\b|(?:yeniden|tekrar)\s*(?:ba\u015flat|baslat)/i)) {
    const hasControl = has(
      /<button\b[^>]*(?:id|class)[^>]*(?:restart|retry|reset)|<button\b[^>]*>\s*(?:restart|retry|reset|yeniden\s+ba\u015flat|yeniden\s+baslat)/i,
      html
    )
    if (!hasControl || !clickWired) gaps.push('wired Restart control')
  }
  if (wants(/\bwasd\b/i)) {
    const allKeys =
      ['w', 'a', 's', 'd'].every((key) => new RegExp(`['"]${key}['"]`, 'i').test(js)) ||
      ['KeyW', 'KeyA', 'KeyS', 'KeyD'].every((key) => new RegExp(`['"]${key}['"]`).test(js))
    const keyboardWired = has(/addEventListener\(\s*['"]key(?:down|up)['"]/i, js)
    const movement = has(
      /(?:\.(?:x|y|px|py|vx|vy)|\b(?:x|y|px|py|vx|vy)\b)\s*(?:\+=|-=|=)|\b(?:position|pos|velocity)\s*=\s*\{/i,
      js
    )
    if (!allKeys || !keyboardWired || !movement) gaps.push('WASD movement')
  }
  if (
    wants(/\b(?:mouse|aim|cursor|pointer)\b|(?:fare|ni\u015fan|nisan)/i) &&
    !has(/addEventListener\(\s*['"](?:mouse|pointer)move['"]/i, js)
  ) {
    gaps.push('mouse aim')
  }
  if (
    wants(/\btouch\b|dokunmatik/i) &&
    !has(/addEventListener\(\s*['"](?:touchstart|pointerdown)['"]/i, js)
  ) {
    gaps.push('touch input')
  }

  const ammoName = String.raw`(?:ammo|magazine|mag|rounds|clip)`
  const healthName = String.raw`(?:health|hp|hitPoints|lives)`
  const scoreName = String.raw`(?:score|points|kills)`
  const enemyName = String.raw`(?:enemy|enemies|foe|foes|hostile|hostiles|target|targets)`

  if (wants(/\b(?:fire|shoot|attack)\b|(?:ate\u015f|ates)/i)) {
    const consumesAmmo = new RegExp(`\\b${ammoName}\\b\\s*(?:-=|--|=\\s*Math\\.max)`, 'i').test(js)
    const fireInput = has(
      /addEventListener\(\s*['"](?:click|mouse(?:down|up)|pointer(?:down|up)|touchstart|keydown)['"]/i,
      js
    )
    const shotEvidence = has(
      /\b(?:function\s+(?:fire|shoot|attack)|bullet|bullets|projectile|projectiles|hitscan|raycast|muzzle|shot|shots|hitDistance)\b|\.push\(\s*\{[\s\S]{0,160}(?:vx|vy|damage)|\b(?:enemies|foes|targets)\.splice\(/i,
      js
    )
    if (!consumesAmmo || !fireInput || !shotEvidence) gaps.push('implemented firing')
  }

  if (wants(/\benem(?:y|ies)\b|(?:d\u00fc\u015fman|dusman)/i)) {
    const enemyCollection = new RegExp(`\\b${enemyName}\\b`, 'i').test(js)
    const iterates = new RegExp(
      `(?:for\\s*\\([^)]*\\b${enemyName}\\b[^)]*\\)|\\b${enemyName}\\b[\\s\\S]{0,160}(?:forEach|map|for\\s*\\())`,
      'i'
    ).test(js)
    const movesSomething = has(
      /(?:\.(?:x|y|px|py|vx|vy)|\b(?:x|y|px|py|vx|vy)\b)\s*(?:\+=|-=|=)/i,
      js
    )
    if (!enemyCollection || !iterates || !movesSomething) gaps.push('moving enemies')
  }
  if (
    wants(/\bscore\b|skor/i) &&
    !new RegExp(`\\b${scoreName}\\b\\s*(?:\\+=|-=|\\+\\+|--|=\\s*\\b${scoreName}\\b\\s*[+-])`, 'i').test(js)
  ) {
    gaps.push('score progression')
  }
  if (
    wants(/\bhealth\b|(?:sa\u011fl\u0131k|saglik|\bcan\b)/i) &&
    !new RegExp(`\\b${healthName}\\b\\s*(?:\\+=|-=|\\+\\+|--|=\\s*Math\\.(?:max|min))`, 'i').test(js)
  ) {
    gaps.push('health damage/recovery')
  }
  if (
    wants(/\bammo\b|(?:cephane|mermi)/i) &&
    !new RegExp(`\\b${ammoName}\\b\\s*(?:-=|--|=\\s*Math\\.max)`, 'i').test(js)
  ) {
    gaps.push('ammo consumption')
  }
  if (wants(/\breload\b|(?:doldur|\u015farj\u00f6r|sarjor)/i)) {
    const reloadTrigger = has(
      /\breload\b|(?:key|code)\s*={2,3}\s*['"](?:r|KeyR)['"]|case\s+['"](?:r|KeyR)['"]/i,
      js
    )
    const loadsAmmo = new RegExp(`\\b${ammoName}\\b\\s*=`, 'i').test(js)
    if (!reloadTrigger || !loadsAmmo) gaps.push('reload behavior')
  }
  if (
    wants(/\bgame[- ]?over\b|(?:oyun\s+bitti|g\u00f6rev\s+ba\u015far\u0131s\u0131z|gorev\s+basarisiz)/i)
  ) {
    const depleted = new RegExp(`\\b${healthName}\\b\\s*<=\\s*0`, 'i').test(js)
    const endsGame = has(
      /(?:running|playing|active|gameState|state)\s*=\s*(?:false|['"](?:over|ended|gameover|failed)['"])|game\s*over|gameover|mission\s+failed|showGameOver|restart/i,
      js
    )
    if (!depleted || !endsGame) gaps.push('game-over state')
  }
  if (wants(/\bresponsive\b|(?:duyarl\u0131|duyarli|mobil)/i)) {
    const responsiveCss = has(
      /@media[^{]*\{[\s\S]{0,800}[.#a-z][\w.#:[\]-]*\s*\{[^}]+\}/i,
      css
    )
    const responsiveJs = has(/addEventListener\(\s*['"]resize['"]|ResizeObserver/i, js)
    if (!responsiveCss && !responsiveJs) gaps.push('responsive resizing')
  }
  if (
    /(?:no|without)\s+(?:external|network)|(?:harici|d\u0131\u015f|dis)\s+(?:kaynak|ba\u011f\u0131ml\u0131l\u0131k|bagimlilik)|a\u011f\s+iste\u011fi\s+yok/i.test(goal) &&
    (/<(?:script|img|link)\b[^>]*(?:src|href)\s*=\s*['"]https?:/i.test(html) ||
      /\b(?:fetch|WebSocket|EventSource)\s*\(\s*['"]https?:/i.test(js))
  ) {
    gaps.push('no external assets/network')
  }
  return gaps
}

export function requestedGameFeatureGaps(
  goal: string,
  action: LocalExecutorAction | null,
  workspaceDir?: string
): string[] {
  return requestedGameFeatureGapsFromSource(goal, executableSource(action, workspaceDir))
}

export function scoreLocalExecutorAttempt(
  args: LocalExecutorQualityArgs
): LocalExecutorScore {
  const reasons: string[] = []
  const validStructuredOutput =
    args.parseOk && args.validationErrors.length === 0 && Boolean(args.action)
  // An empty command list means no deterministic syntax validator applies to
  // this artifact. Blocked model commands are evidence only; they are never
  // executed and do not discard an otherwise structurally verified patch.
  const allowedCommandResults = args.commandResults.filter((result) => result.allowed)
  const validationPassed = allowedCommandResults.every((result) => result.passed)
  const patchApplied = args.patchApplied
  const meaningfulChange = args.changedFiles.length > 0
  const alignedWithGoal = Boolean(args.action?.summary?.trim()) && Boolean(args.goal.trim())
  const scopedDiff =
    args.changedFiles.length > 0 && args.changedFiles.length <= MAX_FILES_PER_ATTEMPT
  const docsOnly =
    args.changedFiles.length > 0 &&
    args.changedFiles.every((file) => DOC_FILE_RE.test(file))
  const avoidsSpam = !(docsOnly && !DOC_GOAL_RE.test(args.goal))
  const placeholderFile = args.action?.files.find(
    (file) =>
      file.operation !== 'delete' &&
      typeof file.content === 'string' &&
      PLACEHOLDER_CONTENT_RE.test(file.content)
  )
  const noPlaceholderContent = !placeholderFile
  const completeRequest = args.completionMode === 'complete_request'
  const finalSource = completeRequest
    ? executableSource(args.action, args.workspaceDir)
    : { html: '', css: '', js: '' }
  const authoredChars = completeRequest
    ? finalSource.html.trim().length +
      finalSource.css.trim().length +
      finalSource.js.trim().length
    : (args.action?.files.reduce(
        (total, file) =>
          total +
          (file.operation !== 'delete' && typeof file.content === 'string'
            ? file.content.trim().length
            : 0),
        0
      ) ?? 0)
  const gameBuildGoal =
    completeRequest &&
    GAME_GOAL_RE.test(args.goal) &&
    (COMPLEX_BUILD_RE.test(args.goal) || SHOOTER_GOAL_RE.test(args.goal))
  const complexBuildGoal =
    completeRequest &&
    (gameBuildGoal ||
      (COMPLEX_BUILD_RE.test(args.goal) && BUILD_ARTIFACT_RE.test(args.goal))) &&
    !DOC_GOAL_RE.test(args.goal)
  const sufficientSubstance =
    !complexBuildGoal || authoredChars >= MIN_COMPLEX_BUILD_CONTENT_CHARS
  const requestedFeatureGaps =
    gameBuildGoal ? requestedGameFeatureGapsFromSource(args.goal, finalSource) : []
  const requestedFeaturesImplemented = requestedFeatureGaps.length === 0

  if (!validStructuredOutput) {
    reasons.push(args.validationErrors[0] ?? 'invalid structured output')
  }
  if (!patchApplied) reasons.push('patch did not apply cleanly')
  if (!meaningfulChange) reasons.push('no workspace file changed')
  const failedCommand = allowedCommandResults.find((result) => !result.passed)
  if (failedCommand) {
    reasons.push(`${failedCommand.cmd} failed`)
  }
  if (!alignedWithGoal) reasons.push('change is not clearly aligned with the loop goal')
  if (!scopedDiff) reasons.push('diff is too broad for one autonomous local attempt')
  if (!avoidsSpam) {
    reasons.push('doc-only churn is blocked unless the loop asks for documentation')
  }
  if (!noPlaceholderContent) {
    reasons.push(
      `${placeholderFile?.path ?? 'created file'} still contains placeholder implementation text`
    )
  }
  if (!sufficientSubstance) {
    reasons.push(
      `complex build returned only ${authoredChars} characters of file content; at least ${MIN_COMPLEX_BUILD_CONTENT_CHARS} are required before validation`
    )
  }
  if (!requestedFeaturesImplemented) {
    reasons.push(`missing implemented gameplay features: ${requestedFeatureGaps.join(', ')}`)
  }

  const checks = {
    validStructuredOutput,
    patchApplied,
    validationPassed,
    meaningfulChange,
    alignedWithGoal,
    scopedDiff,
    avoidsSpam,
    noPlaceholderContent,
    sufficientSubstance,
    requestedFeaturesImplemented
  }
  const passedChecks = Object.values(checks).filter(Boolean).length
  const score = Math.round((passedChecks / Object.keys(checks).length) * 100)
  const shouldCommit = Object.values(checks).every(Boolean)
  return {
    score,
    shouldCommit,
    verdict: shouldCommit
      ? 'commit'
      : validStructuredOutput && patchApplied
        ? 'no_commit'
        : 'attempt_failed',
    reasons,
    checks
  }
}
