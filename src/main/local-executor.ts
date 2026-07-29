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
    noPlaceholderContent: boolean
    sufficientSubstance: boolean
    requestedFeaturesImplemented: boolean
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
  rollbackFailed: boolean
  rollback: LocalExecutorRollbackEntry[]
}

export interface LocalExecutorRollbackEntry {
  absolutePath: string
  workspaceRoot?: string
  existed: boolean
  content: string | null
}

const MAX_MODEL_OUTPUT_CHARS = 1_000_000
const MAX_COMMAND_OUTPUT_CHARS = 24_000
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

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

function escapeRawJsonStringControls(json: string): string | null {
  let output = ''
  let inString = false
  let escaped = false
  let changed = false

  for (const char of json) {
    const code = char.charCodeAt(0)
    if (inString && code <= 0x1f) {
      const unicodeEscape = `u${code.toString(16).padStart(4, '0')}`
      output += escaped ? unicodeEscape : `\\${unicodeEscape}`
      escaped = false
      changed = true
      continue
    }

    output += char
    if (!inString) {
      if (char === '"') {
        inString = true
        escaped = false
      }
      continue
    }
    if (escaped) {
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === '"') {
      inString = false
    }
  }

  return changed ? output : null
}

function parseLocalExecutorJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown
  } catch (strictError) {
    const repaired = escapeRawJsonStringControls(json)
    if (!repaired) throw strictError
    return JSON.parse(repaired) as unknown
  }
}

export function parseLocalExecutorAction(raw: string): { ok: true; action: LocalExecutorAction } | { ok: false; error: string } {
  const json = extractJson(raw)
  if (!json) return { ok: false, error: 'Local executor did not return a JSON object.' }
  try {
    const parsed = parseLocalExecutorJson(json)
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

export function splitSuggestedCommands(text: string | null | undefined): LocalExecutorCommand[] {
  if (!text?.trim()) return []
  return text
    .split(/\n|&&/g)
    .map((cmd) => cmd.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((cmd) => ({ cmd, reason: 'Loop validation setting' }))
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
  completionMode?: 'incremental' | 'complete_request'
}): string {
  const completeRequest = args.completionMode === 'complete_request'
  return `You are Akorith's Local Executor. You do not control a shell. Return only strict JSON.

Goal:
${args.goal}

Workspace context:
${args.workspaceContext}

Previous attempts:
${args.previousAttempts || 'No prior local executor attempts.'}

Validation command policy:
- Akorith does not execute commands suggested by the model or package.json scripts.
- The host may run only non-executing syntax checks selected from changed files: node --check and isolated Python -I -S -m py_compile.
- Never suggest tests, builds, package scripts, destructive commands, network commands, git commands, shell pipes, redirects, expansions, or chained commands.
- Requested loop validation text is context only and is not executed: ${args.validationCommands || 'none'}.

Delivery mode:
${completeRequest
    ? '- Complete the entire user request in this response. Return full working file contents for every explicitly requested artifact.\n- Do not return a scaffold, “basic structure”, placeholder comments, TODO implementation, or a plan for later work.\n- Implement the requested behavior now and include a validation command that is valid for the files you create.'
    : '- Make one bounded, useful project change that advances the goal and can be validated independently.'}

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
  "commands": [],
  "expected_outcome": "What should pass or improve"
}

Rules:
- Use relative paths only. Never use absolute paths or .. path traversal.
${completeRequest
    ? '- Keep the patch scoped to the requested deliverables, but do not omit requested features merely to make the response shorter.'
    : '- Prefer one small meaningful project change per attempt.'}
- Do not edit secrets, .env files, node_modules, dist/build output, or .git internals.
- Avoid README/doc-only churn unless the goal specifically asks for docs.
- If no safe useful change is possible, return a tiny workspace_patch that updates an existing TODO/report file only when it is directly useful.`
}

export async function executeLocalExecutorAttempt(args: {
  workspaceDir: string
  rawOutput: string
  goal: string
  completionMode?: 'incremental' | 'complete_request'
  extraCommands?: LocalExecutorCommand[]
  timeoutMs?: number
  signal?: AbortSignal
  revertOnNoCommit?: boolean
}): Promise<LocalExecutorAttemptResult> {
  const {
    applyValidatedFiles,
    prepareLocalValidationCommands,
    rollbackLocalExecutorPatch,
    runLocalValidationCommands,
    scoreLocalExecutorAttempt,
    validateLocalExecutorAction
  } = await import('./local-executor-quality')
  const errors: string[] = []
  const parsed = parseLocalExecutorAction(args.rawOutput)
  if (!parsed.ok) {
    errors.push(parsed.error)
    const score = scoreLocalExecutorAttempt({
      action: null,
      parseOk: false,
      validationErrors: errors,
      patchApplied: false,
      changedFiles: [],
      commandResults: [],
      goal: args.goal,
      completionMode: args.completionMode
    })
    return { rawOutput: args.rawOutput, action: null, changedFiles: [], commandResults: [], score, errors, rolledBack: false, rollbackFailed: false, rollback: [] }
  }

  const validated = validateLocalExecutorAction(args.workspaceDir, parsed.action)
  if (!validated.ok) {
    errors.push(...validated.errors)
    const score = scoreLocalExecutorAttempt({
      action: parsed.action,
      parseOk: true,
      validationErrors: errors,
      patchApplied: false,
      changedFiles: [],
      commandResults: [],
      goal: args.goal,
      completionMode: args.completionMode
    })
    return { rawOutput: args.rawOutput, action: parsed.action, changedFiles: [], commandResults: [], score, errors, rolledBack: false, rollbackFailed: false, rollback: [] }
  }

  let rollback: LocalExecutorRollbackEntry[] = []
  let changedFiles: string[] = []
  try {
    const applied = applyValidatedFiles(validated.files)
    rollback = applied.rollback
    changedFiles = applied.changedFiles
  } catch (err) {
    const rollbackResult = rollbackLocalExecutorPatch(rollback)
    errors.push(`Patch application failed: ${err instanceof Error ? err.message : String(err)}`)
    if (!rollbackResult.ok) errors.push(`Rollback failed: ${rollbackResult.errors.join('; ')}`)
    const score = scoreLocalExecutorAttempt({
      action: parsed.action,
      parseOk: true,
      validationErrors: errors,
      patchApplied: false,
      changedFiles,
      commandResults: [],
      goal: args.goal,
      completionMode: args.completionMode
    })
    return {
      rawOutput: args.rawOutput,
      action: parsed.action,
      changedFiles,
      commandResults: [],
      score,
      errors,
      rolledBack: rollback.length > 0 && rollbackResult.ok,
      rollbackFailed: !rollbackResult.ok,
      rollback
    }
  }

  const commands = prepareLocalValidationCommands(args.workspaceDir, changedFiles)
  const commandResults = changedFiles.length > 0
    ? await runLocalValidationCommands(args.workspaceDir, commands, args.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, args.signal)
    : []
  const score = scoreLocalExecutorAttempt({
    action: parsed.action,
    parseOk: true,
    validationErrors: errors,
    patchApplied: true,
    changedFiles,
    commandResults,
    goal: args.goal,
    workspaceDir: args.workspaceDir,
    completionMode: args.completionMode
  })
  let rolledBack = false
  let rollbackFailed = false
  if ((args.revertOnNoCommit ?? true) && !score.shouldCommit) {
    const rollbackResult = rollbackLocalExecutorPatch(rollback)
    rolledBack = rollback.length > 0 && rollbackResult.ok
    rollbackFailed = !rollbackResult.ok
    if (rollbackFailed) errors.push(`Rollback failed: ${rollbackResult.errors.join('; ')}`)
  }
  return {
    rawOutput: args.rawOutput,
    action: parsed.action,
    changedFiles,
    commandResults,
    score,
    errors,
    rolledBack,
    rollbackFailed,
    rollback
  }
}
