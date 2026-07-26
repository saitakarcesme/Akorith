import { randomUUID } from 'crypto'
import {
  addMessage,
  getDb,
  getSessionProjectContext,
  recordUsageEvent,
  updateMessage,
  type StoredMessageMetadata
} from '../db'
import { describeProviders } from '../providers/registry'
import type { SendResult } from '../providers/types'
import {
  acquireWorkspaceWriterLease,
  canonicalWorkspaceDirectory,
  type WorkspaceWriterLease
} from '../workspace-writer-lease'
import { addBacklogItem } from './backlog'
import { inspectProject } from './context'
import { listEvents, logEvent } from './events'
import { runGoalToCompletion } from './goal'
import { isRepo } from './git'
import { listRuns } from './runs'
import { createLoop, getLoop, setLoopStatus, updateLoop } from './store'
import type {
  ProjectLoop,
  StartWorkspaceGoalInput,
  WorkspaceGoalSnapshot,
  WorkspaceGoalStatus
} from './types'

type BindingRow = {
  id: string
  loop_id: string
  session_id: string
  request_id: string
  user_message_id: string | null
  assistant_message_id: string | null
  provider_id: string
  model: string | null
  workspace_path: string
  goal: string
  state: WorkspaceGoalStatus
  attempts: number
  error: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

const VALID_REQUEST_ID = /^[\w:.-]{1,128}$/
const VALID_PROVIDER_ID = /^[a-z0-9-]{1,32}$/
const VALID_MODEL = /^[\w.:/-]{1,64}$/
const MAX_GOAL_CHARS = 100_000
const controllers = new Map<string, AbortController>()
const tasks = new Map<string, Promise<void>>()
const writerLeases = new Map<string, WorkspaceWriterLease>()
let shuttingDown = false

function countUnescaped(value: string, token: string): number {
  let count = 0
  let cursor = 0
  while (cursor < value.length) {
    const index = value.indexOf(token, cursor)
    if (index < 0) break
    let slashes = 0
    for (let position = index - 1; position >= 0 && value[position] === '\\'; position -= 1) slashes += 1
    if (slashes % 2 === 0) count += 1
    cursor = index + token.length
  }
  return count
}

function commandIsQuotedOrCode(valueBeforeCommand: string): boolean {
  if (countUnescaped(valueBeforeCommand, '```') % 2 === 1) return true
  if (countUnescaped(valueBeforeCommand, '~~~') % 2 === 1) return true
  const withoutFences = valueBeforeCommand.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
  if (countUnescaped(withoutFences, '`') % 2 === 1) return true
  const currentLine = withoutFences.slice(withoutFences.lastIndexOf('\n') + 1)
  if (/^\s*>/.test(currentLine)) return true
  if (countUnescaped(currentLine, '"') % 2 === 1) return true
  if (/(?:^|\s)'[^']*$/.test(currentLine)) return true
  if (countUnescaped(currentLine, '\u2018') !== countUnescaped(currentLine, '\u2019')) return true
  if (countUnescaped(currentLine, '\u201c') !== countUnescaped(currentLine, '\u201d')) return true
  return false
}

function stripTerminalLoopCommand(prompt: unknown): string {
  if (typeof prompt !== 'string' || prompt.length > MAX_GOAL_CHARS + 64) {
    throw new Error('invalid /loop prompt')
  }
  // The command is deliberately narrow: ordinary text, whitespace, then the
  // final `/loop` token. Embedded occurrences remain ordinary text; command-
  // looking suffixes inside unfinished quotes/code are rejected.
  const match = prompt.match(/^([\s\S]*\S)\s+\/loop\s*$/i)
  const beforeCommand = match?.[1]
  if (beforeCommand && commandIsQuotedOrCode(beforeCommand)) {
    throw new Error('Close the quote or code block before adding /loop.')
  }
  const goal = beforeCommand?.trim()
  if (!goal) throw new Error('Add a concrete goal before the final /loop command.')
  if (goal.length > MAX_GOAL_CHARS) throw new Error('The /loop goal is too long.')
  return goal
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function canonicalSessionWorkspace(sessionId: string): { name: string; path: string } {
  const context = getSessionProjectContext(sessionId)
  if (!context) throw new Error('Open a persisted project before starting /loop.')
  return { name: context.projectName, path: canonicalWorkspaceDirectory(context.projectPath) }
}

function metadataFor(
  binding: BindingRow,
  status = binding.state,
  attempts = binding.attempts,
  error = binding.error ?? undefined
): StoredMessageMetadata {
  return {
    workspaceGoal: {
      bindingId: binding.id,
      loopId: binding.loop_id,
      goal: binding.goal,
      status,
      attempts,
      final: status === 'completed',
      ...(error ? { error } : {})
    }
  }
}

function statusContent(
  binding: BindingRow,
  status: WorkspaceGoalStatus,
  attempts: number,
  error?: string
): string {
  if (status === 'completed') {
    const latest = listRuns(binding.loop_id, 1)[0]
    const completion = listEvents(binding.loop_id, 100).find((event) => event.kind === 'goal_completed')
    const evidence = completion?.detail?.trim()
    const lines = [
      'The /loop goal is complete.',
      latest?.summary ? `Result: ${latest.summary}` : undefined,
      latest?.validationResult ? `Validation: ${latest.validationResult}` : undefined,
      latest ? `Cycles: ${Math.max(attempts, latest.runIndex)}; files changed in the final cycle: ${latest.filesChanged}` : undefined,
      evidence ? `Evidence:\n${evidence}` : undefined
    ].filter((line): line is string => Boolean(line))
    return lines.join('\n\n')
  }
  if (status === 'paused') {
    return 'This /loop goal is paused. Its progress and evidence are saved; resume it to continue toward the verified outcome.'
  }
  if (status === 'needs_review') {
    return `This /loop goal has not produced a final result. Akorith preserved its progress after reaching a blocker${
      error ? `: ${error}` : '.'
    } Resume it after reviewing the workspace to continue.`
  }
  if (status === 'error') {
    return `This /loop goal has not produced a final result. Akorith preserved its progress after an execution error${
      error ? `: ${error}` : '.'
    } Resume it to retry from the durable checkpoint.`
  }
  return 'Akorith is working toward this /loop goal. It will keep planning, executing, validating, and replanning; a final result is withheld until the complete goal is verified.'
}

function rowByLoop(loopId: string): BindingRow | null {
  return (
    (getDb()
      .prepare('SELECT * FROM workspace_goal_bindings WHERE loop_id = ?')
      .get(loopId) as BindingRow | undefined) ?? null
  )
}

function rowByRequest(requestId: string): BindingRow | null {
  return (
    (getDb()
      .prepare('SELECT * FROM workspace_goal_bindings WHERE request_id = ?')
      .get(requestId) as BindingRow | undefined) ?? null
  )
}

function assertWorkspaceAvailable(workspacePath: string, exceptLoopId?: string): void {
  const owner = getDb()
    .prepare(
      `SELECT loop_id, goal
       FROM workspace_goal_bindings
       WHERE workspace_path = ? AND state = 'running' AND loop_id <> ?
       LIMIT 1`
    )
    .get(workspacePath, exceptLoopId ?? '') as { loop_id: string; goal: string } | undefined
  if (owner) {
    throw new Error(
      `Another /loop goal is already working in this project: ${owner.goal.replace(/\s+/g, ' ').slice(0, 120)}`
    )
  }
}

function assertMatchingRequest(
  binding: BindingRow,
  input: StartWorkspaceGoalInput,
  goal: string,
  workspacePath: string
): void {
  if (
    binding.session_id !== input.sessionId ||
    binding.goal !== goal ||
    binding.provider_id !== input.providerId ||
    (binding.model ?? undefined) !== input.model ||
    !samePath(binding.workspace_path, workspacePath)
  ) {
    throw new Error('The /loop request id is already bound to a different Workspace goal.')
  }
}

function acquireBindingLease(binding: BindingRow): WorkspaceWriterLease {
  const current = writerLeases.get(binding.loop_id)
  if (current) {
    if (!samePath(current.workspacePath, binding.workspace_path)) {
      throw new Error('The active /loop writer lease does not match its durable workspace path.')
    }
    return current
  }
  const lease = acquireWorkspaceWriterLease(binding.workspace_path, {
    kind: 'workspace-loop',
    id: binding.request_id,
    label: `/loop goal: ${binding.goal.replace(/\s+/g, ' ').slice(0, 160)}`
  })
  writerLeases.set(binding.loop_id, lease)
  return lease
}

function releaseBindingLease(loopId: string): void {
  const lease = writerLeases.get(loopId)
  if (!lease) return
  writerLeases.delete(loopId)
  lease.release()
}

function snapshotFromRow(row: BindingRow): WorkspaceGoalSnapshot {
  const loop = getLoop(row.loop_id)
  if (!loop) throw new Error('Workspace goal data is incomplete.')
  const attempts = Math.max(row.attempts, loop.runCount)
  return {
    bindingId: row.id,
    loopId: row.loop_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    userMessageId: row.user_message_id ?? '',
    assistantMessageId: row.assistant_message_id ?? '',
    providerId: row.provider_id,
    model: row.model ?? undefined,
    workspacePath: row.workspace_path,
    goal: row.goal,
    status: row.state,
    attempts,
    final: row.state === 'completed',
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: Math.max(row.updated_at, loop.updatedAt),
    completedAt: row.completed_at ?? undefined,
    loop
  }
}

function updateBinding(
  loopId: string,
  status: WorkspaceGoalStatus,
  attempts: number,
  error?: string
): WorkspaceGoalSnapshot {
  const current = rowByLoop(loopId)
  if (!current) throw new Error('Workspace goal binding not found.')
  const now = Date.now()
  getDb()
    .prepare(
      `UPDATE workspace_goal_bindings
       SET state = ?, attempts = ?, error = ?, updated_at = ?, completed_at = ?
       WHERE loop_id = ?`
    )
    .run(status, Math.max(0, attempts), error ?? null, now, status === 'completed' ? now : null, loopId)
  const next = rowByLoop(loopId)!
  if (next.assistant_message_id) {
    updateMessage(
      next.assistant_message_id,
      statusContent(next, status, attempts, error),
      metadataFor(next, status, attempts, error)
    )
  }
  return snapshotFromRow(next)
}

function recordStageUsage(
  binding: BindingRow,
  input: {
    stage: 'understand' | 'execute' | 'review'
    attempt: number
    model: string
    usage: SendResult['usage']
  }
): void {
  recordUsageEvent({
    providerId: binding.provider_id,
    model: input.model || (binding.model ?? undefined),
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    cacheReadTokens: input.usage.cacheReadTokens,
    cacheWriteTokens: input.usage.cacheWriteTokens,
    reasoningTokens: input.usage.reasoningTokens,
    totalTokens: input.usage.totalTokens,
    costUsd: input.usage.costUsd,
    estimated: input.usage.estimated,
    sessionId: binding.session_id,
    requestCount: 0,
    sourceKind: 'workspace-loop',
    sourceId: `${binding.id}:${input.stage}:${Math.max(0, input.attempt)}`
  })
}

function validateWorkspaceLock(binding: BindingRow): void {
  const current = canonicalSessionWorkspace(binding.session_id)
  if (!samePath(current.path, binding.workspace_path)) {
    throw new Error(
      `Workspace changed after /loop started. Expected "${binding.workspace_path}" but the chat now points to "${current.path}".`
    )
  }
  const loop = getLoop(binding.loop_id)
  if (!loop || !samePath(canonicalWorkspaceDirectory(loop.localPath), binding.workspace_path)) {
    throw new Error('The durable Goal workspace no longer matches its locked project path.')
  }
}

async function runBinding(loopId: string): Promise<void> {
  const binding = rowByLoop(loopId)
  if (!binding || binding.state === 'completed' || controllers.has(loopId) || shuttingDown) return
  const controller = new AbortController()
  controllers.set(loopId, controller)
  try {
    acquireBindingLease(binding)
    validateWorkspaceLock(binding)
    updateBinding(loopId, 'running', binding.attempts)
    setLoopStatus(loopId, 'active')
    updateLoop(loopId, { error: undefined, pushEnabled: false })
    const result = await runGoalToCompletion(loopId, controller.signal, 12, {
      workspaceGoal: true,
      onUsage: (usage) => {
        try {
          recordStageUsage(binding, usage)
        } catch (error) {
          console.error(`[workspace-loop] failed to record ${usage.stage} usage:`, error)
        }
      }
    })
    const attempts = listRuns(loopId, 10_000).length
    if (shuttingDown && controller.signal.aborted) {
      // Keep it recoverable as running; startup will relaunch from the durable
      // goal contract. The aborted in-flight run is reconciled on startup.
      setLoopStatus(loopId, 'active')
      updateBinding(loopId, 'running', attempts)
      return
    }
    if (result.status === 'completed') {
      updateBinding(loopId, 'completed', attempts)
    } else if (result.status === 'paused') {
      updateBinding(loopId, 'paused', attempts)
    } else if (result.status === 'needs_review') {
      updateBinding(loopId, 'needs_review', attempts, result.error)
    } else {
      updateBinding(loopId, 'error', attempts, result.error)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const attempts = listRuns(loopId, 10_000).length
    if (shuttingDown && controller.signal.aborted) {
      setLoopStatus(loopId, 'active')
      updateBinding(loopId, 'running', attempts)
    } else if (controller.signal.aborted) {
      setLoopStatus(loopId, 'paused')
      updateBinding(loopId, 'paused', attempts)
    } else {
      setLoopStatus(loopId, 'needs_review')
      updateLoop(loopId, { error: message })
      logEvent(loopId, 'error', 'Workspace /loop stopped before completion', message)
      updateBinding(loopId, 'needs_review', attempts, message)
    }
  } finally {
    controllers.delete(loopId)
    releaseBindingLease(loopId)
  }
}

function launch(loopId: string): void {
  if (tasks.has(loopId) || shuttingDown) return
  const task = runBinding(loopId)
    .catch((error) => console.error(`[workspace-loop] ${loopId} failed:`, error))
    .finally(() => tasks.delete(loopId))
  tasks.set(loopId, task)
}

export function isWorkspaceGoal(loopId: string): boolean {
  return Boolean(rowByLoop(loopId))
}

export function workspaceGoalRunningIds(): string[] {
  return [...controllers.keys()]
}

export async function startWorkspaceGoal(input: StartWorkspaceGoalInput): Promise<WorkspaceGoalSnapshot> {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.requestId !== 'string' ||
    !VALID_REQUEST_ID.test(input.requestId)
  ) {
    throw new Error('invalid /loop request id')
  }
  if (typeof input.sessionId !== 'string' || input.sessionId.length < 1 || input.sessionId.length > 128) {
    throw new Error('invalid /loop session id')
  }
  if (typeof input.providerId !== 'string' || !VALID_PROVIDER_ID.test(input.providerId)) {
    throw new Error('invalid /loop provider')
  }
  if (input.model !== undefined && (typeof input.model !== 'string' || !VALID_MODEL.test(input.model))) {
    throw new Error('invalid /loop model')
  }
  if (shuttingDown) throw new Error('Akorith is shutting down and cannot start a Workspace goal.')
  const goal = stripTerminalLoopCommand(input.prompt)

  const session = getDb()
    .prepare('SELECT id, provider_id FROM sessions WHERE id = ?')
    .get(input.sessionId) as { id: string; provider_id: string } | undefined
  if (!session) throw new Error('The selected chat session no longer exists.')
  if (session.provider_id !== input.providerId) {
    throw new Error('The selected provider does not match this project chat session.')
  }
  const workspace = canonicalSessionWorkspace(input.sessionId)
  const existing = rowByRequest(input.requestId)
  if (existing) {
    assertMatchingRequest(existing, input, goal, workspace.path)
    if (existing.state === 'running') {
      acquireBindingLease(existing)
      launch(existing.loop_id)
    }
    return snapshotFromRow(existing)
  }

  assertWorkspaceAvailable(workspace.path)
  const writerLease = acquireWorkspaceWriterLease(workspace.path, {
    kind: 'workspace-loop',
    id: input.requestId,
    label: `/loop goal: ${goal.replace(/\s+/g, ' ').slice(0, 160)}`
  })
  let leaseTransferred = false
  try {
    const provider = (await describeProviders()).find((item) => item.id === input.providerId)
    if (!provider?.kind.includes('executor')) throw new Error('The selected provider cannot edit a workspace.')
    if (!provider.available.ok) throw new Error(provider.available.reason || 'The selected provider is unavailable.')
    const repository = await isRepo(workspace.path)
    const mode = repository
      ? 'repo_grower'
      : inspectProject(workspace.path).fileTree.length === 0
        ? 'project_builder'
        : 'maintenance'

    const created = getDb().transaction((): WorkspaceGoalSnapshot => {
      const duplicate = rowByRequest(input.requestId)
      if (duplicate) {
        assertMatchingRequest(duplicate, input, goal, workspace.path)
        return snapshotFromRow(duplicate)
      }
      assertWorkspaceAvailable(workspace.path)
      const loop = createLoop({
        title: goal.replace(/\s+/g, ' ').slice(0, 200),
        mode,
        localPath: workspace.path,
        idea: goal,
        autonomy: 'manual',
        safety: 'standard',
        scheduleKind: 'manual',
        scheduleMinutes: 0,
        minCommitsPerRun: 0,
        maxCommitsPerRun: 0,
        dailyCommitTarget: 0,
        localModelProvider: input.providerId,
        localModel: input.model,
        pushEnabled: false
      })
      addBacklogItem({
        loopId: loop.id,
        title: goal.replace(/\s+/g, ' ').slice(0, 200),
        detail: goal,
        priority: 100
      })
      const bindingId = randomUUID()
      const userMessageId = addMessage(input.sessionId, 'user', goal, input.providerId, input.model)
      const now = Date.now()
      const pendingRow: BindingRow = {
        id: bindingId,
        loop_id: loop.id,
        session_id: input.sessionId,
        request_id: input.requestId,
        user_message_id: userMessageId,
        assistant_message_id: null,
        provider_id: input.providerId,
        model: input.model ?? null,
        workspace_path: workspace.path,
        goal,
        state: 'running',
        attempts: 0,
        error: null,
        created_at: now,
        updated_at: now,
        completed_at: null
      }
      const assistantMessageId = addMessage(
        input.sessionId,
        'assistant',
        statusContent(pendingRow, 'running', 0),
        input.providerId,
        input.model,
        [],
        metadataFor(pendingRow, 'running', 0)
      )
      getDb()
        .prepare(
          `INSERT INTO workspace_goal_bindings (
            id, loop_id, session_id, request_id, user_message_id, assistant_message_id,
            provider_id, model, workspace_path, goal, state, attempts, error,
            created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, NULL, ?, ?, NULL)`
        )
        .run(
          bindingId,
          loop.id,
          input.sessionId,
          input.requestId,
          userMessageId,
          assistantMessageId,
          input.providerId,
          input.model ?? null,
          workspace.path,
          goal,
          now,
          now
        )
      recordUsageEvent({
        providerId: input.providerId,
        model: input.model,
        estimated: false,
        sessionId: input.sessionId,
        requestCount: 1,
        sourceKind: 'workspace-loop',
        sourceId: `${bindingId}:request`
      })
      logEvent(
        loop.id,
        'created',
        `Workspace /loop started for ${workspace.name}`,
        'The project path is canonical-locked. Akorith will not automatically initialize, stage, commit, or push, and the selected executor is instructed to leave git history unchanged.'
      )
      return snapshotFromRow(rowByLoop(loop.id)!)
    })()

    if (created.status === 'running') {
      if (writerLeases.has(created.loopId)) {
        throw new Error('The Workspace goal already owns a writer lease.')
      }
      writerLeases.set(created.loopId, writerLease)
      leaseTransferred = true
      launch(created.loopId)
    }
    return created
  } finally {
    if (!leaseTransferred) writerLease.release()
  }
}

export function getWorkspaceGoal(loopId: string): WorkspaceGoalSnapshot | null {
  const row = rowByLoop(loopId)
  return row ? snapshotFromRow(row) : null
}

export async function pauseWorkspaceGoal(loopId: string): Promise<WorkspaceGoalSnapshot> {
  const row = rowByLoop(loopId)
  if (!row) throw new Error('Workspace goal not found.')
  if (row.state === 'completed') {
    releaseBindingLease(loopId)
    return snapshotFromRow(row)
  }
  logEvent(loopId, 'paused', 'Workspace /loop pause requested')
  controllers.get(loopId)?.abort()
  await tasks.get(loopId)
  const stopped = rowByLoop(loopId)
  if (!stopped) throw new Error('Workspace goal not found.')
  try {
    if (stopped.state === 'completed') return snapshotFromRow(stopped)
    setLoopStatus(loopId, 'paused')
    return updateBinding(loopId, 'paused', Math.max(stopped.attempts, getLoop(loopId)?.runCount ?? 0))
  } finally {
    releaseBindingLease(loopId)
  }
}

export async function resumeWorkspaceGoal(loopId: string): Promise<WorkspaceGoalSnapshot> {
  // A quick Pause -> Resume must not be overwritten by the aborting run's
  // finally path. Wait for that bounded provider cancellation to checkpoint.
  await tasks.get(loopId)
  const row = rowByLoop(loopId)
  if (!row) throw new Error('Workspace goal not found.')
  if (row.state === 'completed') {
    releaseBindingLease(loopId)
    return snapshotFromRow(row)
  }
  validateWorkspaceLock(row)
  assertWorkspaceAvailable(row.workspace_path, loopId)
  acquireBindingLease(row)
  try {
    setLoopStatus(loopId, 'active')
    updateLoop(loopId, { error: undefined, pushEnabled: false })
    const snapshot = updateBinding(loopId, 'running', Math.max(row.attempts, getLoop(loopId)?.runCount ?? 0))
    launch(loopId)
    return snapshot
  } catch (error) {
    releaseBindingLease(loopId)
    throw error
  }
}

/**
 * Mark interrupted cycle rows and relaunch only goals that were durably running.
 * Paused/review/error goals remain visible and resumable but never masquerade
 * as a final assistant answer.
 */
export function resumeWorkspaceGoalsAtStartup(): void {
  if (shuttingDown) return
  const running = getDb()
    .prepare("SELECT * FROM workspace_goal_bindings WHERE state = 'running' ORDER BY created_at")
    .all() as BindingRow[]
  if (running.length === 0) return
  const now = Date.now()
  const reconcile = getDb().prepare(
    `UPDATE project_loop_runs
     SET status = 'failed', ended_at = ?, error = COALESCE(error, 'Akorith restarted during this cycle; the durable goal resumed.')
     WHERE loop_id = ? AND status = 'running'`
  )
  for (const row of running) {
    reconcile.run(now, row.loop_id)
    const loop = getLoop(row.loop_id)
    if (loop?.status === 'completed') {
      updateBinding(row.loop_id, 'completed', listRuns(row.loop_id, 10_000).length)
    } else {
      try {
        acquireBindingLease(row)
        launch(row.loop_id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setLoopStatus(row.loop_id, 'needs_review')
        updateBinding(row.loop_id, 'needs_review', listRuns(row.loop_id, 10_000).length, message)
        releaseBindingLease(row.loop_id)
      }
    }
  }
}

/** Abort in-flight provider work and wait before SQLite is closed. */
export async function shutdownWorkspaceGoals(): Promise<void> {
  shuttingDown = true
  for (const controller of controllers.values()) controller.abort()
  await Promise.allSettled([...tasks.values()])
  for (const loopId of [...writerLeases.keys()]) releaseBindingLease(loopId)
}
