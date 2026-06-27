import { spawn } from 'child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'

export type LocalExecutorOperation = 'create' | 'modify' | 'delete'

export interface LocalExecutorFileAction {
  path: string
  operation: LocalExecutorOperation
  content?: string
}

export interface LocalExecutorCommand {
  cmd: string
  reason?: string
}

export interface LocalExecutorAction {
  type: 'workspace_patch'
  summary: string
  rationale?: string
  files: LocalExecutorFileAction[]
  commands?: LocalExecutorCommand[]
  expected_outcome?: string
}

export interface LocalCommandResult {
  cmd: string
  reason: string | null
  allowed: boolean
  passed: boolean
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  error: string | null
}

export interface LocalExecutorScore {
  score: number
  shouldCommit: boolean
  verdict: 'commit' | 'attempt_failed' | 'no_commit'
  reasons: string[]
  checks: {
    validStructuredOutput: boolean
    patchApplied: boolean
    validationPassed: boolean
    meaningfulChange: boolean
    alignedWithGoal: boolean
    scopedDiff: boolean
    avoidsSpam: boolean
  }
}

export interface LocalExecutorAttemptResult {
  rawOutput: string
  action: LocalExecutorAction | null
  changedFiles: string[]
  commandResults: LocalCommandResult[]
  score: LocalExecutorScore
  errors: string[]
  rolledBack: boolean
  rollback: LocalExecutorRollbackEntry[]
}

interface ResolvedFileAction {
  path: string
  absolutePath: string
  operation: LocalExecutorOperation
  content?: string
}

export interface LocalExecutorRollbackEntry {
  absolutePath: string
  existed: boolean
  content: string | null
}

const MAX_MODEL_OUTPUT_CHARS = 1_000_000
const MAX_FILE_CONTENT_CHARS = 1_500_000
const MAX_COMMAND_OUTPUT_CHARS = 24_000
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const MAX_FILES_PER_ATTEMPT = 12
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

const SECRET_FILE_RE = /(^|[\\/])\.env($|[\\/_.-])|\.pem$|\.key$|id_rsa$|id_ed25519$/i
const DOC_FILE_RE = /(^|[\\/])(readme|changelog|license)(\.[^.\\/]+)?$|\.(md|mdx|txt|rst)$/i
const DOC_GOAL_RE = /\b(doc|docs|documentation|readme|changelog|copy|guide|manual|text)\b/i

function bounded(text: string, max = MAX_COMMAND_OUTPUT_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[output truncated: ${text.length - max} chars omitted]`
}

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\r/g, '')
}

function normalizeRelPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').trim()
}

function safeReason(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? stripAnsi(value).replace(/\0/g, '').trim().slice(0, 600) : fallback
}

function extractJson(raw: string): string | null {
  const text = raw.slice(0, MAX_MODEL_OUTPUT_CHARS).trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  return text.slice(first, last + 1).trim()
}

export function parseLocalExecutorAction(raw: string): { ok: true; action: LocalExecutorAction } | { ok: false; error: string } {
  const json = extractJson(raw)
  if (!json) return { ok: false, error: 'Local executor did not return a JSON object.' }
  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'Structured output must be a JSON object.' }
    const value = parsed as Record<string, unknown>
    if (value.type !== 'workspace_patch') return { ok: false, error: 'Structured output type must be "workspace_patch".' }
    if (typeof value.summary !== 'string' || !value.summary.trim()) return { ok: false, error: 'Structured output needs a non-empty summary.' }
    if (!Array.isArray(value.files) || value.files.length === 0) return { ok: false, error: 'Structured output needs at least one file action.' }
    const files: LocalExecutorFileAction[] = []
    for (const item of value.files) {
      if (!item || typeof item !== 'object') return { ok: false, error: 'Each file action must be an object.' }
      const file = item as Record<string, unknown>
      if (typeof file.path !== 'string' || !file.path.trim()) return { ok: false, error: 'Each file action needs a path.' }
      if (file.operation !== 'create' && file.operation !== 'modify' && file.operation !== 'delete') {
        return { ok: false, error: `Unsupported file operation for ${file.path}.` }
      }
      const action: LocalExecutorFileAction = {
        path: file.path,
        operation: file.operation
      }
      if (file.content !== undefined) {
        if (typeof file.content !== 'string') return { ok: false, error: `File content for ${file.path} must be a string.` }
        action.content = file.content
      }
      files.push(action)
    }
    const commands = Array.isArray(value.commands)
      ? value.commands
          .filter((cmd): cmd is Record<string, unknown> => Boolean(cmd) && typeof cmd === 'object' && typeof (cmd as Record<string, unknown>).cmd === 'string')
          .map((cmd) => ({ cmd: String(cmd.cmd), reason: safeReason(cmd.reason) }))
      : []
    return {
      ok: true,
      action: {
        type: 'workspace_patch',
        summary: safeReason(value.summary, 'Local executor patch'),
        rationale: safeReason(value.rationale),
        files,
        commands,
        expected_outcome: safeReason(value.expected_outcome)
      }
    }
  } catch (err) {
    return { ok: false, error: `Malformed local executor JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function resolveWorkspacePath(workspaceDir: string, requestedPath: string): { ok: true; path: string; absolutePath: string } | { ok: false; error: string } {
  const root = resolve(workspaceDir)
  const clean = normalizeRelPath(requestedPath)
  if (!clean) return { ok: false, error: 'File path is empty.' }
  if (clean.includes('\0') || clean.includes('\n') || clean.includes('\r')) return { ok: false, error: `${requestedPath}: path contains control characters.` }
  if (isAbsolute(requestedPath) || /^[a-zA-Z]:[\\/]/.test(requestedPath)) return { ok: false, error: `${requestedPath}: absolute paths are not allowed.` }
  const absolutePath = resolve(root, clean)
  const rel = relative(root, absolutePath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, error: `${requestedPath}: path traversal outside the workspace is blocked.` }
  const segments = rel.split(/[\\/]+/).filter(Boolean)
  if (segments.some((segment) => segment === '..')) return { ok: false, error: `${requestedPath}: path traversal is blocked.` }
  const protectedSegment = segments.find((segment) => PROTECTED_SEGMENTS.has(segment))
  if (protectedSegment) return { ok: false, error: `${requestedPath}: writing inside ${protectedSegment} is blocked.` }
  if (SECRET_FILE_RE.test(rel)) return { ok: false, error: `${requestedPath}: secret-like files are blocked.` }
  return { ok: true, path: rel.split(sep).join('/'), absolutePath }
}

export function validateLocalExecutorAction(
  workspaceDir: string,
  action: LocalExecutorAction
): { ok: true; files: ResolvedFileAction[]; warnings: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!existsSync(workspaceDir) || !lstatSync(workspaceDir).isDirectory()) {
    return { ok: false, errors: ['Workspace folder does not exist.'] }
  }
  if (action.type !== 'workspace_patch') errors.push('Action type must be workspace_patch.')
  if (!action.summary.trim()) errors.push('Action summary is required.')
  if (!Array.isArray(action.files) || action.files.length === 0) errors.push('At least one file action is required.')
  if (action.files.length > MAX_FILES_PER_ATTEMPT) errors.push(`Too many files in one attempt (${action.files.length}/${MAX_FILES_PER_ATTEMPT}).`)

  const seen = new Set<string>()
  const files: ResolvedFileAction[] = []
  for (const file of action.files) {
    const resolved = resolveWorkspacePath(workspaceDir, file.path)
    if (!resolved.ok) {
      errors.push(resolved.error)
      continue
    }
    if (seen.has(resolved.path)) {
      errors.push(`${file.path}: duplicate file action.`)
      continue
    }
    seen.add(resolved.path)
    if (file.operation === 'delete') {
      if (!existsSync(resolved.absolutePath)) errors.push(`${file.path}: delete target does not exist.`)
      else if (!lstatSync(resolved.absolutePath).isFile()) errors.push(`${file.path}: only single-file deletes are allowed.`)
    } else {
      if (typeof file.content !== 'string') errors.push(`${file.path}: create/modify requires full file content.`)
      else if (file.content.length > MAX_FILE_CONTENT_CHARS) errors.push(`${file.path}: content is too large for one local executor attempt.`)
    }
    files.push({ ...file, path: resolved.path, absolutePath: resolved.absolutePath })
  }

  for (const command of action.commands ?? []) {
    const policy = commandPolicy(command.cmd)
    if (!policy.allowed) warnings.push(`${command.cmd}: ${policy.reason}`)
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, files, warnings }
}

function applyValidatedFiles(files: ResolvedFileAction[]): { changedFiles: string[]; rollback: LocalExecutorRollbackEntry[] } {
  const rollback: LocalExecutorRollbackEntry[] = []
  const changedFiles: string[] = []
  for (const file of files) {
    const existed = existsSync(file.absolutePath)
    const previous = existed && lstatSync(file.absolutePath).isFile() ? readFileSync(file.absolutePath, 'utf8') : null
    rollback.push({ absolutePath: file.absolutePath, existed, content: previous })
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
    writeFileSync(file.absolutePath, next, 'utf8')
    changedFiles.push(file.path)
  }
  return { changedFiles, rollback }
}

export function rollbackLocalExecutorPatch(rollback: LocalExecutorRollbackEntry[]): void {
  for (const entry of [...rollback].reverse()) {
    try {
      if (entry.existed) {
        mkdirSync(dirname(entry.absolutePath), { recursive: true })
        writeFileSync(entry.absolutePath, entry.content ?? '', 'utf8')
      } else if (existsSync(entry.absolutePath)) {
        rmSync(entry.absolutePath)
      }
    } catch {
      // Best-effort rollback; caller records the original failed attempt.
    }
  }
}

function commandPolicy(cmd: string): { allowed: boolean; reason: string } {
  const text = cmd.trim().replace(/\s+/g, ' ')
  if (!text) return { allowed: false, reason: 'empty command' }
  if (/[;&|<>`]/.test(text)) return { allowed: false, reason: 'shell chaining, pipes, redirects, and interpolation are blocked' }
  if (/\b(git\s+push|git\s+reset|git\s+clean|git\s+rm|git\s+checkout|rm|rmdir|del|erase|format|shutdown|reboot|sudo|su|mkfs|diskpart|takeown|icacls|chmod|chown|curl|wget|powershell|pwsh|cmd)\b/i.test(text)) {
    return { allowed: false, reason: 'dangerous or network-capable command is blocked' }
  }
  const pkg = /^(npm|pnpm|yarn)(?:\.cmd)? (?:(?:run )?(?:test|typecheck|lint|check)|run verify(?::[A-Za-z0-9._-]+)?)(?: -- [A-Za-z0-9_./:=@+-]+(?: [A-Za-z0-9_./:=@+-]+)*)?$/i
  const nodeScript = /^node(?:\.exe)?(?: --experimental-strip-types)? scripts[\\/][A-Za-z0-9._/-]+\.(?:js|cjs|mjs|ts)(?: [A-Za-z0-9_./:=@+-]+)*$/i
  const testRunner = /^(?:npx --yes |npx )?(?:vitest|jest)(?: run| --run)?(?: [A-Za-z0-9_./:=@+-]+)*$/i
  const pytest = /^(?:python|python3|py) -m pytest(?: [A-Za-z0-9_./:=@+-]+)*$|^pytest(?: [A-Za-z0-9_./:=@+-]+)*$/i
  if (pkg.test(text) || nodeScript.test(text) || testRunner.test(text) || pytest.test(text)) return { allowed: true, reason: 'allowed validation command' }
  return { allowed: false, reason: 'command is not in the local executor validation allowlist' }
}

export function isAllowedLocalExecutorCommand(cmd: string): boolean {
  return commandPolicy(cmd).allowed
}

export function splitSuggestedCommands(text: string | null | undefined): LocalExecutorCommand[] {
  if (!text?.trim()) return []
  return text
    .split(/\n|&&/g)
    .map((cmd) => cmd.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((cmd) => ({ cmd, reason: 'Loop validation setting' }))
}

function packageJsonCommands(workspaceDir: string): LocalExecutorCommand[] {
  const file = resolve(workspaceDir, 'package.json')
  if (!existsSync(file)) return []
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string> }
    const scripts = pkg.scripts ?? {}
    const commands: LocalExecutorCommand[] = []
    if (scripts.typecheck) commands.push({ cmd: 'npm run typecheck', reason: 'Auto-detected package validation' })
    if (scripts.test) commands.push({ cmd: 'npm test', reason: 'Auto-detected package validation' })
    if (scripts.lint) commands.push({ cmd: 'npm run lint', reason: 'Auto-detected package validation' })
    return commands
  } catch {
    return []
  }
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
  return out.slice(0, 6)
}

function runOneCommand(workspaceDir: string, command: LocalExecutorCommand, timeoutMs: number, signal?: AbortSignal): Promise<LocalCommandResult> {
  const policy = commandPolicy(command.cmd)
  const started = Date.now()
  if (!policy.allowed) {
    return Promise.resolve({
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
    })
  }
  return new Promise((resolveResult) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(command.cmd, {
      cwd: workspaceDir,
      shell: true,
      windowsHide: true,
      env: { ...process.env, CI: process.env.CI ?? '1' }
    })
    const finish = (result: Omit<LocalCommandResult, 'cmd' | 'reason' | 'durationMs' | 'stdout' | 'stderr'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolveResult({
        cmd: command.cmd,
        reason: command.reason ?? null,
        durationMs: Date.now() - started,
        stdout: bounded(stripAnsi(stdout)),
        stderr: bounded(stripAnsi(stderr)),
        ...result
      })
    }
    const kill = (): void => {
      try {
        if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
        else child.kill('SIGTERM')
      } catch {
        /* ignore kill failures */
      }
    }
    const timer = setTimeout(() => {
      kill()
      finish({ allowed: true, passed: false, exitCode: null, timedOut: true, error: `command timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    const onAbort = (): void => {
      kill()
      finish({ allowed: true, passed: false, exitCode: null, timedOut: false, error: 'cancelled' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > MAX_COMMAND_OUTPUT_CHARS * 2) stdout = stdout.slice(-MAX_COMMAND_OUTPUT_CHARS)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > MAX_COMMAND_OUTPUT_CHARS * 2) stderr = stderr.slice(-MAX_COMMAND_OUTPUT_CHARS)
    })
    child.on('error', (err) => finish({ allowed: true, passed: false, exitCode: null, timedOut: false, error: err.message }))
    child.on('close', (code) => finish({ allowed: true, passed: code === 0, exitCode: code, timedOut: false, error: code === 0 ? null : `exit ${code ?? 'unknown'}` }))
  })
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

function scoreAttempt(args: {
  action: LocalExecutorAction | null
  parseOk: boolean
  validationErrors: string[]
  patchApplied: boolean
  changedFiles: string[]
  commandResults: LocalCommandResult[]
  goal: string
}): LocalExecutorScore {
  const reasons: string[] = []
  const validStructuredOutput = args.parseOk && args.validationErrors.length === 0 && Boolean(args.action)
  const validationPassed = args.commandResults.length > 0 && args.commandResults.every((result) => result.allowed && result.passed)
  const patchApplied = args.patchApplied
  const meaningfulChange = args.changedFiles.length > 0
  const alignedWithGoal = Boolean(args.action?.summary?.trim()) && Boolean(args.goal.trim())
  const scopedDiff = args.changedFiles.length > 0 && args.changedFiles.length <= MAX_FILES_PER_ATTEMPT
  const docsOnly = args.changedFiles.length > 0 && args.changedFiles.every((file) => DOC_FILE_RE.test(file))
  const avoidsSpam = !(docsOnly && !DOC_GOAL_RE.test(args.goal))

  if (!validStructuredOutput) reasons.push(args.validationErrors[0] ?? 'invalid structured output')
  if (!patchApplied) reasons.push('patch did not apply cleanly')
  if (!meaningfulChange) reasons.push('no workspace file changed')
  if (args.commandResults.length === 0) reasons.push('no validation command ran')
  else {
    const failed = args.commandResults.find((result) => !result.allowed || !result.passed)
    if (failed) reasons.push(failed.allowed ? `${failed.cmd} failed` : `${failed.cmd} was blocked`)
  }
  if (!alignedWithGoal) reasons.push('change is not clearly aligned with the loop goal')
  if (!scopedDiff) reasons.push('diff is too broad for one autonomous local attempt')
  if (!avoidsSpam) reasons.push('doc-only churn is blocked unless the loop asks for documentation')

  const checks = { validStructuredOutput, patchApplied, validationPassed, meaningfulChange, alignedWithGoal, scopedDiff, avoidsSpam }
  const passedChecks = Object.values(checks).filter(Boolean).length
  const score = Math.round((passedChecks / Object.keys(checks).length) * 100)
  const shouldCommit = Object.values(checks).every(Boolean)
  return {
    score,
    shouldCommit,
    verdict: shouldCommit ? 'commit' : validStructuredOutput && patchApplied ? 'no_commit' : 'attempt_failed',
    reasons,
    checks
  }
}

export function renderLocalValidationEvidence(results: LocalCommandResult[]): string {
  if (results.length === 0) return 'No validation command ran.'
  return results
    .map((result) => {
      const status = result.allowed ? (result.passed ? 'passed' : result.timedOut ? 'timed out' : 'failed') : 'blocked'
      const body = [result.stdout, result.stderr, result.error].filter(Boolean).join('\n').trim()
      return `$ ${result.cmd}\n${status} (${result.durationMs}ms)${body ? `\n${bounded(body, 6000)}` : ''}`
    })
    .join('\n\n')
}

export function buildLocalExecutorPrompt(args: {
  goal: string
  workspaceContext: string
  previousAttempts: string
  validationCommands: string
}): string {
  return `You are Akorith's Local Executor. You do not control a shell. Return only strict JSON.

Goal:
${args.goal}

Workspace context:
${args.workspaceContext}

Previous attempts:
${args.previousAttempts || 'No prior local executor attempts.'}

Validation command policy:
- You may suggest validation commands, but Akorith will run only allowlisted commands.
- Good commands: npm test, npm run test, npm run typecheck, npm run lint, pnpm test, pnpm run typecheck, yarn test, node scripts/verify-name.ts.
- Never suggest destructive commands, network install commands, git push, sudo/admin commands, shell pipes, redirects, or chained commands.
- Preferred validation for this loop: ${args.validationCommands || 'auto-detect package scripts when available'}.

Return exactly this JSON shape and nothing else:
{
  "type": "workspace_patch",
  "summary": "Short useful change",
  "rationale": "Why this is useful for the goal",
  "files": [
    {
      "path": "relative/path/from/workspace",
      "operation": "create | modify | delete",
      "content": "full file content for create/modify"
    }
  ],
  "commands": [
    {
      "cmd": "npm run typecheck",
      "reason": "Validate the change"
    }
  ],
  "expected_outcome": "What should pass or improve"
}

Rules:
- Use relative paths only. Never use absolute paths or .. path traversal.
- Prefer one small meaningful project change per attempt.
- Do not edit secrets, .env files, node_modules, dist/build output, or .git internals.
- Avoid README/doc-only churn unless the goal specifically asks for docs.
- If no safe useful change is possible, return a tiny workspace_patch that updates an existing TODO/report file only when it is directly useful.`
}

export async function executeLocalExecutorAttempt(args: {
  workspaceDir: string
  rawOutput: string
  goal: string
  extraCommands?: LocalExecutorCommand[]
  timeoutMs?: number
  signal?: AbortSignal
  revertOnNoCommit?: boolean
}): Promise<LocalExecutorAttemptResult> {
  const errors: string[] = []
  const parsed = parseLocalExecutorAction(args.rawOutput)
  if (!parsed.ok) {
    errors.push(parsed.error)
    const score = scoreAttempt({
      action: null,
      parseOk: false,
      validationErrors: errors,
      patchApplied: false,
      changedFiles: [],
      commandResults: [],
      goal: args.goal
    })
    return { rawOutput: args.rawOutput, action: null, changedFiles: [], commandResults: [], score, errors, rolledBack: false, rollback: [] }
  }

  const validated = validateLocalExecutorAction(args.workspaceDir, parsed.action)
  if (!validated.ok) {
    errors.push(...validated.errors)
    const score = scoreAttempt({
      action: parsed.action,
      parseOk: true,
      validationErrors: errors,
      patchApplied: false,
      changedFiles: [],
      commandResults: [],
      goal: args.goal
    })
    return { rawOutput: args.rawOutput, action: parsed.action, changedFiles: [], commandResults: [], score, errors, rolledBack: false, rollback: [] }
  }

  let rollback: LocalExecutorRollbackEntry[] = []
  let changedFiles: string[] = []
  try {
    const applied = applyValidatedFiles(validated.files)
    rollback = applied.rollback
    changedFiles = applied.changedFiles
  } catch (err) {
    rollbackLocalExecutorPatch(rollback)
    errors.push(`Patch application failed: ${err instanceof Error ? err.message : String(err)}`)
    const score = scoreAttempt({
      action: parsed.action,
      parseOk: true,
      validationErrors: errors,
      patchApplied: false,
      changedFiles,
      commandResults: [],
      goal: args.goal
    })
    return { rawOutput: args.rawOutput, action: parsed.action, changedFiles, commandResults: [], score, errors, rolledBack: true, rollback }
  }

  const commands = dedupeCommands([
    ...splitSuggestedCommands(args.extraCommands?.map((c) => c.cmd).join('\n')),
    ...(parsed.action.commands ?? []),
    ...packageJsonCommands(args.workspaceDir)
  ])
  const commandResults = changedFiles.length > 0
    ? await runLocalValidationCommands(args.workspaceDir, commands, args.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, args.signal)
    : []
  const score = scoreAttempt({
    action: parsed.action,
    parseOk: true,
    validationErrors: errors,
    patchApplied: true,
    changedFiles,
    commandResults,
    goal: args.goal
  })
  let rolledBack = false
  if ((args.revertOnNoCommit ?? true) && !score.shouldCommit) {
    rollbackLocalExecutorPatch(rollback)
    rolledBack = rollback.length > 0
  }
  return { rawOutput: args.rawOutput, action: parsed.action, changedFiles, commandResults, score, errors, rolledBack, rollback }
}
