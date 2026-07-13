import { sendLocal } from '../local-runtime'
import { buildLocalExecutorPrompt, executeLocalExecutorAttempt } from '../local-executor'
import { getLoop, recordLoopRunResult, setLoopStatus, updateLoop } from './store'
import { startRun, finishRun } from './runs'
import { logEvent } from './events'
import { recordCommit } from './commits'
import { setBacklogStatus } from './backlog'
import { chooseObjective } from './planner'
import { inspectProject, renderProjectContext } from './context'
import { ensureRepo, commitAll } from './git'
import type { ProjectLoopRun } from './types'

// Phase 48: the Loop runner — one safe cycle. It NEVER pushes (push is a separate
// explicit action), never escapes the project root (the local-executor validates
// every path against workspaceDir), and rolls back non-commit-worthy attempts.

export interface RunCycleResult {
  ok: boolean
  run: ProjectLoopRun | null
  committed: boolean
  sha?: string
  summary: string
  error?: string
}

export async function runOneCycle(loopId: string, signal?: AbortSignal): Promise<RunCycleResult> {
  const loop = getLoop(loopId)
  if (!loop) return { ok: false, run: null, committed: false, summary: '', error: 'loop not found' }
  if (loop.status === 'archived') {
    return { ok: false, run: null, committed: false, summary: '', error: 'loop is archived' }
  }

  const run = startRun(loopId, undefined, loop.localModel)
  logEvent(loopId, 'run_started', `Run #${run.runIndex} started`, undefined, run.id)

  try {
    // 1) Inspect the project (read-only).
    const ctx = inspectProject(loop.localPath)
    logEvent(loopId, 'inspected', `Inspected project (${ctx.fileTree.length} entries)`, undefined, run.id)

    // 2) Choose the next objective.
    const chosen = await chooseObjective(loop, ctx)
    logEvent(loopId, 'planned', `Objective (${chosen.source}): ${chosen.objective.slice(0, 160)}`, chosen.objective, run.id)

    // 3) Ask the local model for a structured patch.
    await ensureRepo(loop.localPath)
    const prompt = buildLocalExecutorPrompt({
      goal: chosen.objective,
      workspaceContext: renderProjectContext(ctx),
      previousAttempts: loop.memorySummary ?? '',
      validationCommands: ''
    })
    const raw = await sendLocal(prompt, { model: loop.localModel, signal })
    if (!raw.ok) {
      logEvent(loopId, 'run_failed', 'Local model did not respond', raw.error, run.id)
      const failed = finishRun(run.id, { status: 'failed', objective: chosen.objective, error: raw.error })
      setLoopStatus(loopId, 'error')
      updateLoop(loopId, { error: raw.error })
      return { ok: false, run: failed, committed: false, summary: '', error: raw.error }
    }
    logEvent(loopId, 'patch_proposed', 'Local model proposed a patch', undefined, run.id)

    // 4) Validate + apply + run validation commands + score (rollback if not worthy).
    const attempt = await executeLocalExecutorAttempt({
      workspaceDir: loop.localPath,
      rawOutput: raw.text,
      goal: chosen.objective,
      revertOnNoCommit: true,
      signal
    })

    const filesChanged = attempt.changedFiles.length
    const commandsRun = attempt.commandResults.length
    const testsRun = attempt.commandResults.filter((c) => /test|pytest/.test(c.cmd)).length

    if (!attempt.action) {
      logEvent(loopId, 'patch_rejected', 'Patch could not be parsed/validated', attempt.errors.join('; '), run.id)
      const r = finishRun(run.id, {
        status: 'rejected',
        objective: chosen.objective,
        summary: 'No valid patch',
        error: attempt.errors.join('; '),
        filesChanged,
        commandsRun,
        testsRun
      })
      recordLoopRunResult(loopId, 0)
      return { ok: true, run: r, committed: false, summary: 'No valid patch produced.' }
    }

    logEvent(loopId, 'patch_validated', `Score ${attempt.score.score} (${attempt.score.verdict})`, attempt.score.reasons.join('; '), run.id)

    if (!attempt.score.shouldCommit || filesChanged === 0 || attempt.rolledBack) {
      logEvent(loopId, 'run_succeeded', 'No commit-worthy change this cycle', attempt.score.reasons.join('; '), run.id)
      const r = finishRun(run.id, {
        status: 'no_change',
        objective: chosen.objective,
        summary: attempt.action.summary,
        nextStep: attempt.action.expected_outcome,
        filesChanged,
        commandsRun,
        testsRun,
        validationResult: attempt.score.verdict
      })
      recordLoopRunResult(loopId, 0)
      return { ok: true, run: r, committed: false, summary: attempt.action.summary }
    }

    // 5) Commit the meaningful change.
    logEvent(loopId, 'patch_applied', `Applied ${filesChanged} file(s)`, attempt.changedFiles.join(', '), run.id)
    const message = `${attempt.action.summary}\n\n${attempt.action.rationale ?? ''}`.trim()
    const commit = await commitAll(loop.localPath, message)
    if (!commit.ok || !commit.sha) {
      logEvent(loopId, 'run_failed', 'Commit failed', commit.error, run.id)
      const r = finishRun(run.id, {
        status: 'failed',
        objective: chosen.objective,
        summary: attempt.action.summary,
        error: commit.error,
        filesChanged,
        commandsRun,
        testsRun
      })
      recordLoopRunResult(loopId, 0)
      return { ok: false, run: r, committed: false, summary: attempt.action.summary, error: commit.error }
    }

    recordCommit({
      loopId,
      runId: run.id,
      sha: commit.sha,
      message: attempt.action.summary,
      filesChanged: commit.filesChanged,
      validationSummary: attempt.score.verdict
    })
    logEvent(loopId, 'committed', `Committed ${commit.sha.slice(0, 8)}: ${attempt.action.summary}`, undefined, run.id)

    if (chosen.backlogItemId) setBacklogStatus(chosen.backlogItemId, 'done')

    const finished = finishRun(run.id, {
      status: 'success',
      objective: chosen.objective,
      summary: attempt.action.summary,
      nextStep: attempt.action.expected_outcome,
      filesChanged: commit.filesChanged,
      commandsRun,
      testsRun,
      commitsCreated: 1,
      validationResult: attempt.score.verdict
    })
    recordLoopRunResult(loopId, 1)
    if (loop.status === 'error') setLoopStatus(loopId, 'active')
    logEvent(loopId, 'run_succeeded', `Run #${run.runIndex} committed a change`, undefined, run.id)

    return { ok: true, run: finished, committed: true, sha: commit.sha, summary: attempt.action.summary }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logEvent(loopId, 'error', 'Run errored', message, run.id)
    const r = finishRun(run.id, { status: 'failed', error: message })
    setLoopStatus(loopId, 'error')
    updateLoop(loopId, { error: message })
    return { ok: false, run: r, committed: false, summary: '', error: message }
  }
}
