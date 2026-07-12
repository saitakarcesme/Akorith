import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  CatalogModel,
  ModelCapability,
  ModelCapabilityProbeRecord,
  ProbeCapabilityObservation,
  ProbeKind
} from './types'

const PROBE_VERSION = 'catalog-runtime-1'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_FRESH_MS = 7 * 24 * 60 * 60_000
const MAX_MODEL_TURNS = 24
const MAX_RESPONSE_CHARS = 32_000
const MAX_TRANSCRIPT_CHARS = 64_000
const WRITABLE_PATHS = new Set(['src/math.mjs', 'probe-result.json'])
const READABLE_PATHS = new Set(['src/math.mjs', 'src/format.mjs', 'test.mjs', 'obsolete.txt', 'probe-result.json'])
const DELETABLE_PATHS = new Set(['obsolete.txt'])

export interface ProbeCompletionInput {
  model: CatalogModel
  prompt: string
  signal: AbortSignal
  /** Each callback is observable streaming evidence from the transport. */
  onDelta(delta: string): void
}

export interface ProbeModelTransport {
  complete(input: ProbeCompletionInput): Promise<string>
}

export type ProbeTransportResolver = (
  model: CatalogModel,
  signal: AbortSignal
) => Promise<ProbeModelTransport | null> | ProbeModelTransport | null

export interface CapabilityProbeOptions {
  id?: string
  model: CatalogModel
  probeKind: ProbeKind
  transport: ProbeModelTransport
  signal?: AbortSignal
  timeoutMs?: number
  freshForMs?: number
  tempRoot?: string
  now?: () => number
}

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

type ToolAction =
  | { action: 'read'; path: string }
  | { action: 'write'; path: string; content: string }
  | { action: 'delete'; path: string }
  | { action: 'run_tests' }
  | { action: 'finish' }

interface ToolTrace {
  reads: Set<string>
  writes: { path: string; operation: 'create' | 'edit' | 'delete'; index: number }[]
  tests: { exitCode: number; index: number }[]
  toolCalls: number
  deltas: number
  streamedChars: number
}

interface FixtureInspection {
  baselineFailed: boolean
  finalTestsPassed: boolean
  editedMath: boolean
  createdMarker: boolean
  deletedObsolete: boolean
  protectedFilesIntact: boolean
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error(typeof reason === 'string' ? reason : 'Operation cancelled.')
  error.name = 'AbortError'
  return error
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

function combinedSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  didTimeout: () => boolean
  dispose: () => void
} {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = (): void => controller.abort(parent?.reason ?? new Error('Probe cancelled.'))
  if (parent?.aborted) onAbort()
  else parent?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    const error = new Error('Capability probe timed out.')
    error.name = 'TimeoutError'
    controller.abort(error)
  }, timeoutMs)
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    }
  }
}

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  timeout = 30_000
): Promise<CommandResult> {
  assertActive(signal)
  return new Promise((resolvePromise, reject) => {
    execFile(command, [...args], {
      cwd,
      windowsHide: true,
      timeout,
      maxBuffer: 1024 * 1024,
      signal,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }, (error, stdout, stderr) => {
      if (signal.aborted) {
        reject(abortError(signal))
        return
      }
      const exitCode = error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0
      resolvePromise({
        exitCode,
        stdout: bounded(String(stdout), 16_000),
        stderr: bounded(String(stderr), 16_000)
      })
    })
  })
}

function safeFixturePath(root: string, candidate: string, allowed: ReadonlySet<string>): string {
  const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!allowed.has(normalized) || isAbsolute(candidate) || normalized.includes('..') || normalized.includes('\0')) {
    throw new Error(`Probe tool path is not allowed: ${candidate}`)
  }
  const target = resolve(root, normalized)
  const rel = relative(root, target)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`Probe tool path escapes the fixture: ${candidate}`)
  }
  return target
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function createFixture(tempRoot: string, signal: AbortSignal): Promise<{
  root: string
  protectedContents: Map<string, string>
  baselineFailed: boolean
}> {
  assertActive(signal)
  await mkdir(tempRoot, { recursive: true })
  const root = await mkdtemp(join(tempRoot, 'akorith-model-probe-'))
  await mkdir(join(root, 'src'), { recursive: true })
  const files: Record<string, string> = {
    'src/math.mjs': 'export function total(items) {\n  return items.reduce((sum, item) => sum - item, 0)\n}\n',
    'src/format.mjs': 'export function formatTotal(value) {\n  return `total:${value}`\n}\n',
    'test.mjs': [
      "import assert from 'node:assert/strict'",
      "import { readFile, access } from 'node:fs/promises'",
      "import { total } from './src/math.mjs'",
      "import { formatTotal } from './src/format.mjs'",
      "assert.equal(formatTotal(total([2, 3])), 'total:5')",
      "assert.deepEqual(JSON.parse(await readFile('probe-result.json', 'utf8')), { probe: 'passed' })",
      "await assert.rejects(access('obsolete.txt'))",
      "process.stdout.write('fixture tests passed\\n')",
      ''
    ].join('\n'),
    'obsolete.txt': 'delete this obsolete fixture file\n'
  }
  await Promise.all(Object.entries(files).map(async ([path, content]) => {
    await writeFile(join(root, path), content, 'utf8')
  }))
  await runProcess('git', ['init', '--quiet'], root, signal)
  await runProcess('git', ['config', 'user.email', 'probe@akorith.invalid'], root, signal)
  await runProcess('git', ['config', 'user.name', 'Akorith Probe'], root, signal)
  await runProcess('git', ['add', '--', '.'], root, signal)
  const commit = await runProcess('git', ['commit', '--quiet', '-m', 'probe fixture baseline'], root, signal)
  if (commit.exitCode !== 0) throw new Error(`Could not commit probe fixture: ${commit.stderr || commit.stdout}`)
  const baseline = await runFixtureTests(root, signal)
  return {
    root,
    protectedContents: new Map([
      ['src/format.mjs', files['src/format.mjs']],
      ['test.mjs', files['test.mjs']]
    ]),
    baselineFailed: baseline.exitCode !== 0
  }
}

async function runFixtureTests(root: string, signal: AbortSignal): Promise<CommandResult> {
  return runProcess(process.execPath, ['test.mjs'], root, signal, 20_000)
}

function parseAction(text: string): ToolAction {
  if (text.length > MAX_RESPONSE_CHARS) throw new Error('Probe model response exceeded the action size limit.')
  const match = text.trim().match(/^(?:```(?:json)?\s*)?(\{[\s\S]*\})(?:\s*```)?$/i)
  if (!match) throw new Error('Probe model response was not one JSON action.')
  let raw: unknown
  try {
    raw = JSON.parse(match[1])
  } catch {
    throw new Error('Probe model response contained invalid JSON.')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Probe action must be an object.')
  const value = raw as Record<string, unknown>
  const keys = Object.keys(value).sort().join(',')
  if (value.action === 'read' && keys === 'action,path' && typeof value.path === 'string') {
    return { action: 'read', path: value.path }
  }
  if (value.action === 'write' && keys === 'action,content,path' && typeof value.path === 'string' && typeof value.content === 'string' && value.content.length <= 20_000) {
    return { action: 'write', path: value.path, content: value.content }
  }
  if (value.action === 'delete' && keys === 'action,path' && typeof value.path === 'string') {
    return { action: 'delete', path: value.path }
  }
  if (value.action === 'run_tests' && keys === 'action') return { action: 'run_tests' }
  if (value.action === 'finish' && keys === 'action') return { action: 'finish' }
  throw new Error('Probe model returned an unsupported or over-permissive action.')
}

function codeProbePrompt(transcript: string): string {
  return [
    'You are operating a disposable Akorith capability-probe Git repository through bounded tools.',
    'Return exactly one JSON action and no prose on each turn.',
    'Allowed actions:',
    '{"action":"read","path":"src/math.mjs"}',
    '{"action":"write","path":"src/math.mjs","content":"..."}',
    '{"action":"delete","path":"obsolete.txt"}',
    '{"action":"run_tests"}',
    '{"action":"finish"}',
    'You may also read src/format.mjs, test.mjs, obsolete.txt, and probe-result.json.',
    'You may create probe-result.json with the write action.',
    'Task: inspect all source and test files, run the failing tests before editing, repair total(),',
    'create probe-result.json containing exactly {"probe":"passed"}, delete obsolete.txt,',
    'then run the tests until they pass and finish. Never edit test.mjs or src/format.mjs.',
    '',
    'TOOL TRANSCRIPT:',
    transcript || '(empty)'
  ].join('\n')
}

function appendTranscript(transcript: string, action: ToolAction, result: string): string {
  return bounded(`${transcript}\nACTION ${JSON.stringify(action)}\nRESULT ${bounded(result, 8_000)}`.trim(), MAX_TRANSCRIPT_CHARS)
}

async function executeToolLoop(
  model: CatalogModel,
  transport: ProbeModelTransport,
  root: string,
  signal: AbortSignal,
  trace: ToolTrace
): Promise<boolean> {
  let transcript = ''
  for (let turn = 0; turn < MAX_MODEL_TURNS; turn += 1) {
    assertActive(signal)
    const response = await transport.complete({
      model,
      prompt: codeProbePrompt(transcript),
      signal,
      onDelta: (delta) => {
        if (typeof delta !== 'string' || delta.length === 0) return
        trace.deltas += 1
        trace.streamedChars += delta.length
      }
    })
    const action = parseAction(response)
    trace.toolCalls += 1
    if (action.action === 'finish') return true
    if (action.action === 'read') {
      const path = action.path.replace(/\\/g, '/').replace(/^\.\//, '')
      const content = await readFile(safeFixturePath(root, path, READABLE_PATHS), 'utf8')
      trace.reads.add(path)
      transcript = appendTranscript(transcript, action, bounded(content, 8_000))
      continue
    }
    if (action.action === 'write') {
      const path = action.path.replace(/\\/g, '/').replace(/^\.\//, '')
      const target = safeFixturePath(root, path, WRITABLE_PATHS)
      const operation = await exists(target) ? 'edit' : 'create'
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, action.content, 'utf8')
      trace.writes.push({ path, operation, index: trace.toolCalls })
      transcript = appendTranscript(transcript, action, `${operation} observed`)
      continue
    }
    if (action.action === 'delete') {
      const path = action.path.replace(/\\/g, '/').replace(/^\.\//, '')
      const target = safeFixturePath(root, path, DELETABLE_PATHS)
      await unlink(target)
      trace.writes.push({ path, operation: 'delete', index: trace.toolCalls })
      transcript = appendTranscript(transcript, action, 'delete observed')
      continue
    }
    const result = await runFixtureTests(root, signal)
    trace.tests.push({ exitCode: result.exitCode, index: trace.toolCalls })
    transcript = appendTranscript(
      transcript,
      action,
      `exit=${result.exitCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`
    )
  }
  return false
}

async function inspectFixture(
  root: string,
  protectedContents: ReadonlyMap<string, string>,
  baselineFailed: boolean,
  signal: AbortSignal
): Promise<FixtureInspection> {
  const finalTests = await runFixtureTests(root, signal)
  const diff = await runProcess('git', ['status', '--porcelain=v1', '--untracked-files=all'], root, signal)
  if (diff.exitCode !== 0) throw new Error(`Could not inspect probe fixture diff: ${diff.stderr}`)
  const statuses = new Map(diff.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => {
    const status = line.slice(0, 2).trim()
    const path = line.slice(3).trim()
    return [path.replace(/\\/g, '/'), status] as const
  }))
  const markerPath = join(root, 'probe-result.json')
  let markerValid = false
  try {
    markerValid = JSON.stringify(JSON.parse(await readFile(markerPath, 'utf8'))) === JSON.stringify({ probe: 'passed' })
  } catch {
    markerValid = false
  }
  let protectedFilesIntact = true
  for (const [path, expected] of protectedContents) {
    if (await readFile(join(root, path), 'utf8') !== expected) protectedFilesIntact = false
  }
  return {
    baselineFailed,
    finalTestsPassed: finalTests.exitCode === 0,
    editedMath: statuses.get('src/math.mjs') === 'M',
    createdMarker: statuses.get('probe-result.json') === '??' && markerValid,
    deletedObsolete: statuses.get('obsolete.txt') === 'D' && !(await exists(join(root, 'obsolete.txt'))),
    protectedFilesIntact
  }
}

function observed(
  outcome: ProbeCapabilityObservation['outcome'],
  summary: string
): ProbeCapabilityObservation {
  return { outcome, summary }
}

function assessCodeCapabilities(trace: ToolTrace, inspection: FixtureInspection): ModelCapabilityProbeRecord['capabilities'] {
  const readAll = ['src/math.mjs', 'src/format.mjs', 'test.mjs'].every((path) => trace.reads.has(path))
  const ranTests = trace.tests.length > 0
  const toolFailure = trace.tests.find((test) => test.exitCode !== 0)
  const toolSuccessAfterFailure = toolFailure
    ? trace.tests.some((test) => test.exitCode === 0 && test.index > toolFailure.index)
    : false
  const mutationAfterFailure = toolFailure
    ? trace.writes.some((write) => write.index > toolFailure.index)
    : false
  const finalSolution = inspection.finalTestsPassed && inspection.protectedFilesIntact
  const outcomes: Partial<Record<ModelCapability, ProbeCapabilityObservation>> = {
    file_read: observed(readAll ? 'confirmed' : 'rejected', readAll ? 'Bounded tools observed reads of both source modules and the test.' : 'Required file reads were not all observed.'),
    file_edit: observed(inspection.editedMath ? 'confirmed' : 'rejected', inspection.editedMath ? 'Git observed a modification to src/math.mjs.' : 'Git did not observe the required source edit.'),
    file_create: observed(inspection.createdMarker ? 'confirmed' : 'rejected', inspection.createdMarker ? 'Git and content inspection observed the required new JSON file.' : 'The required created file was absent or invalid.'),
    file_delete: observed(inspection.deletedObsolete ? 'confirmed' : 'rejected', inspection.deletedObsolete ? 'Git and filesystem inspection observed the required deletion.' : 'The required deletion was not observed.'),
    command_execution: observed(ranTests ? 'confirmed' : 'rejected', ranTests ? 'The host tool harness observed a bounded command exit.' : 'No host-mediated command execution was observed.'),
    tool_use: observed(trace.toolCalls >= 4 ? 'confirmed' : 'rejected', trace.toolCalls >= 4 ? `The host executed ${trace.toolCalls} validated tool calls.` : 'Too few validated tool calls were observed.'),
    multi_file_reasoning: observed(readAll && finalSolution ? 'confirmed' : 'rejected', readAll && finalSolution ? 'The model read multiple related files and produced a passing protected solution.' : 'Multi-file evidence was incomplete.'),
    code_generation: observed(finalSolution && inspection.editedMath && inspection.createdMarker ? 'confirmed' : 'rejected', finalSolution && inspection.editedMath && inspection.createdMarker ? 'Generated changes passed the immutable fixture test.' : 'Generated changes did not satisfy the fixture.'),
    test_execution: observed(ranTests ? 'confirmed' : 'rejected', ranTests ? 'Fixture test execution was invoked through the bounded host tool.' : 'The model did not invoke the fixture tests.'),
    debugging: observed(inspection.baselineFailed && finalSolution ? 'confirmed' : 'rejected', inspection.baselineFailed && finalSolution ? 'An observed failing baseline became a passing protected fixture.' : 'Failure-to-pass repair evidence was incomplete.'),
    iterative_repair: observed(toolFailure && mutationAfterFailure && toolSuccessAfterFailure ? 'confirmed' : 'rejected', toolFailure && mutationAfterFailure && toolSuccessAfterFailure ? 'A failed model-invoked test was followed by a mutation and a passing model-invoked test.' : 'No observed failed-test, repair, passed-test sequence occurred.'),
    streaming_status: observed(trace.deltas >= 2 && trace.streamedChars > 0 ? 'confirmed' : 'rejected', trace.deltas >= 2 && trace.streamedChars > 0 ? `${trace.deltas} non-empty transport deltas were observed.` : 'The transport did not expose multiple non-empty deltas.')
  }
  return outcomes
}

function reasoningPrompt(): { prompt: string; expected: string } {
  return {
    prompt: [
      'Akorith reasoning capability check. Do not use tools.',
      'Compute (17 * 29) + 4. Then reverse the order of the words "akorith catalog".',
      'Return only: <number>|<reversed words joined by a hyphen>'
    ].join('\n'),
    expected: '497|catalog-akorith'
  }
}

function failureRecord(
  running: ModelCapabilityProbeRecord,
  status: ModelCapabilityProbeRecord['status'],
  now: number,
  code: string,
  message: string,
  capabilities: ModelCapabilityProbeRecord['capabilities'] = {}
): ModelCapabilityProbeRecord {
  return {
    ...running,
    status,
    completedAt: now,
    freshUntil: null,
    capabilities,
    failureCode: code,
    failureMessage: bounded(message.replace(/[\r\n]+/g, ' '), 500),
    durationMs: Math.max(0, now - running.startedAt)
  }
}

export function createRunningProbeRecord(
  model: CatalogModel,
  probeKind: ProbeKind,
  now = Date.now(),
  id = `probe-${randomUUID()}`
): ModelCapabilityProbeRecord {
  return {
    schemaVersion: 1,
    id,
    catalogModelId: model.id,
    probeKind,
    probeVersion: PROBE_VERSION,
    status: 'running',
    startedAt: now,
    completedAt: null,
    freshUntil: null,
    providerId: model.providerId,
    modelName: model.modelName,
    source: model.source,
    nodeId: model.nodeId,
    capabilities: {}
  }
}

export function unavailableProbeRecord(
  running: ModelCapabilityProbeRecord,
  now: number,
  message: string
): ModelCapabilityProbeRecord {
  return failureRecord(running, 'unavailable', now, 'probe_transport_unavailable', message)
}

export async function runCapabilityProbe(options: CapabilityProbeOptions): Promise<ModelCapabilityProbeRecord> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const running = createRunningProbeRecord(options.model, options.probeKind, startedAt, options.id)
  const timeoutMs = Math.max(1, Math.min(Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS), 10 * 60_000))
  const freshForMs = Math.max(60_000, Math.min(Math.trunc(options.freshForMs ?? DEFAULT_FRESH_MS), 30 * 24 * 60 * 60_000))
  const combined = combinedSignal(options.signal, timeoutMs)
  let fixtureRoot: string | null = null
  try {
    if (options.model.availability.status !== 'available') {
      return unavailableProbeRecord(running, now(), options.model.availability.reason ?? 'Model is not currently available.')
    }
    if (options.probeKind === 'reasoning') {
      let deltas = 0
      const challenge = reasoningPrompt()
      const response = await options.transport.complete({
        model: options.model,
        prompt: challenge.prompt,
        signal: combined.signal,
        onDelta: (delta) => {
          if (delta) deltas += 1
        }
      })
      const completedAt = now()
      if (response.trim() !== challenge.expected) {
        return failureRecord(
          running,
          'failed',
          completedAt,
          'reasoning_probe_mismatch',
          'The model did not produce the deterministic reasoning result.',
          { reasoning: observed('rejected', 'Deterministic reasoning answer did not match.') }
        )
      }
      return {
        ...running,
        status: 'succeeded',
        completedAt,
        freshUntil: completedAt + freshForMs,
        durationMs: Math.max(0, completedAt - startedAt),
        capabilities: {
          reasoning: observed('confirmed', 'Deterministic arithmetic and ordering challenge matched.'),
          streaming_status: observed(deltas >= 2 ? 'confirmed' : 'rejected', deltas >= 2 ? `${deltas} transport deltas were observed.` : 'Fewer than two transport deltas were observed.')
        }
      }
    }

    const fixture = await createFixture(options.tempRoot ?? tmpdir(), combined.signal)
    fixtureRoot = fixture.root
    const trace: ToolTrace = {
      reads: new Set(),
      writes: [],
      tests: [],
      toolCalls: 0,
      deltas: 0,
      streamedChars: 0
    }
    const finished = await executeToolLoop(options.model, options.transport, fixture.root, combined.signal, trace)
    const inspection = await inspectFixture(
      fixture.root,
      fixture.protectedContents,
      fixture.baselineFailed,
      combined.signal
    )
    const capabilities = assessCodeCapabilities(trace, inspection)
    const completedAt = now()
    if (!finished || !inspection.finalTestsPassed || !inspection.protectedFilesIntact) {
      return failureRecord(
        running,
        'failed',
        completedAt,
        'code_probe_fixture_failed',
        !finished
          ? 'The model did not finish within the bounded tool-turn budget.'
          : !inspection.protectedFilesIntact
            ? 'The model modified protected fixture files.'
            : 'The final fixture validation failed.',
        capabilities
      )
    }
    return {
      ...running,
      status: 'succeeded',
      completedAt,
      freshUntil: completedAt + freshForMs,
      durationMs: Math.max(0, completedAt - startedAt),
      capabilities
    }
  } catch (error) {
    const completedAt = now()
    if (combined.didTimeout()) {
      return failureRecord(running, 'error', completedAt, 'probe_timeout', 'Capability probe timed out.')
    }
    if (options.signal?.aborted || combined.signal.aborted) {
      return failureRecord(running, 'cancelled', completedAt, 'probe_cancelled', 'Capability probe was cancelled.')
    }
    return failureRecord(
      running,
      'error',
      completedAt,
      'probe_runtime_error',
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    combined.dispose()
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}
