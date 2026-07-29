import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { sendWorkspacePrompt } from '../providers/registry'
import { runCli, type RunCliResult } from '../providers/util'
import {
  AUTORESEARCH_LOG_DIR,
  AUTORESEARCH_PROGRAM_FILE,
  AUTORESEARCH_RESULTS_FILE,
  extractMetric,
  extractPeakMemoryGb,
  metricImproved,
  parseStoredAutoresearchResult,
  pathAllowed,
  type StoredAutoresearchResult
} from './autoresearch-core'
import {
  finishResearchCycle,
  getResearchJob,
  listResearchCycles,
  logResearchEvent,
  researchCancellationRequested,
  startResearchActiveClock,
  startResearchCycle,
  updateResearchJob
} from './store'
import type {
  AutoresearchExperimentConfig,
  AutoresearchExperimentState,
  ResearchCycleResult,
  ResearchJob
} from './types'
import { RESEARCH_DEPTH_PROFILES } from './types'
import {
  RESEARCH_REPORT_FILE,
  isManagedResearchPath,
  safeResearchPath
} from './workspace'
import { recordResearchModelUsage } from './usage'

const SETUP_TIMEOUT_MS = 45 * 60_000
const NEXT_EXPERIMENT_DELAY_MS = 1_000
const MAX_LOG_BYTES = 4_000_000
const MAX_AGENT_CONTEXT_RESULTS = 30

export async function runAutoresearchCycle(
  jobId: string,
  signal?: AbortSignal
): Promise<ResearchCycleResult> {
  let job = requireAutoresearchJob(jobId)
  if (job.status === 'completed' || job.status === 'archived' || job.status === 'paused') {
    return { ok: false, job, completed: job.status === 'completed', error: `Research is ${job.status}.` }
  }
  if (researchCancellationRequested(job.id)) {
    updateResearchJob(job.id, { status: 'paused', nextRunAt: undefined })
    job = requireAutoresearchJob(job.id)
    return { ok: false, job, completed: false, error: 'Research was cancelled.' }
  }

  startResearchActiveClock(job.id)
  job = requireAutoresearchJob(job.id)
  try {
    job = await ensureAutoresearchWorkspace(job, signal)
  } catch (error) {
    const message = publicError(error)
    job = updateResearchJob(job.id, {
      status: signal?.aborted ? 'paused' : 'error',
      phase: 'understand',
      error: message,
      nextRunAt: signal?.aborted ? undefined : Date.now() + 60_000
    })!
    if (!signal?.aborted) {
      logResearchEvent({
        jobId: job.id,
        kind: 'error',
        title: 'Autoresearch setup needs attention',
        detail: message
      })
    }
    return { ok: false, job, completed: false, error: message }
  }

  const config = requireExperimentConfig(job)
  const state = requireExperimentState(job)
  const repositoryDir = requireManagedRepository(job, state)
  await restoreBestCheckpoint(repositoryDir, state, signal)

  const baseline = state.baselineMetric === undefined
  const cycle = startResearchCycle({
    jobId: job.id,
    phase: baseline ? 'plan' : 'research',
    objective: baseline ? 'Establish the unchanged baseline' : `Run focused experiment ${job.cycleCount + 1}`
  })
  logResearchEvent({
    jobId: job.id,
    cycleId: cycle.id,
    kind: baseline ? 'baseline_started' : 'experiment_proposed',
    title: baseline ? 'Baseline run started' : `Experiment ${cycle.cycleIndex} started`,
    detail: baseline
      ? `${config.command.display} · metric ${config.metric.name}`
      : `The selected agent is preparing one scoped change in ${config.editablePaths.join(', ')}.`
  })

  let modelUsage: { promptTokens?: number; completionTokens?: number } = {}
  let description = baseline ? 'baseline' : 'Agent proposed no description.'
  let changedFiles: string[] = []
  let candidateCommit: string | undefined
  const previousBest = state.bestMetric
  const startedAt = Date.now()

  try {
    if (!baseline) {
      updateResearchJob(job.id, { status: 'researching', phase: 'research', error: undefined })
      const response = await sendWorkspacePrompt(
        job.providerId,
        job.model,
        buildExperimentPrompt(job, config, state),
        repositoryDir,
        signal
      )
      recordResearchModelUsage({
        job,
        kind: 'research-cycle',
        turnId: cycle.id,
        model: response.model,
        usage: response.usage
      })
      modelUsage = response.usage
      description = experimentDescription(response.text)
      changedFiles = await changedWorkspacePaths(repositoryDir, signal)
      if (changedFiles.length === 0) {
        return await finishWithoutBenchmark({
          job,
          cycleId: cycle.id,
          state,
          description,
          error: 'The agent completed its turn without a scoped file change.',
          startedAt,
          modelUsage,
          signal
        })
      }
      const escaped = changedFiles.filter((path) => !pathAllowed(path, config.editablePaths))
      if (escaped.length > 0) {
        await restoreBestCheckpoint(repositoryDir, state, signal)
        return await finishWithoutBenchmark({
          job,
          cycleId: cycle.id,
          state,
          description,
          changedFiles,
          error: `The proposal changed files outside the experiment boundary: ${escaped.join(', ')}`,
          startedAt,
          modelUsage,
          signal
        })
      }
      candidateCommit = await commitCandidate(repositoryDir, cycle.cycleIndex, description, config, signal)
    }

    updateResearchJob(job.id, { status: 'verifying', phase: 'verify', error: undefined })
    const execution = await runExperimentCommand(job, cycle.cycleIndex, config, repositoryDir, signal)
    const combinedOutput = `${execution.result.stdout}\n${execution.result.stderr}`
    const metric = execution.result.code === 0
      ? extractMetric(combinedOutput, config.metric.pattern)
      : undefined
    const memoryGb = extractPeakMemoryGb(combinedOutput)
    const durationMs = Date.now() - startedAt
    const commandError = execution.result.code === 0
      ? metric === undefined
        ? `Metric "${config.metric.name}" was not found in the command output.`
        : undefined
      : `${config.command.display} exited with code ${execution.result.code ?? 'unknown'}.`
    const status: StoredAutoresearchResult['status'] = commandError
      ? 'crash'
      : baseline || previousBest === undefined || metricImproved(metric!, previousBest, config.metric.direction)
        ? 'keep'
        : 'discard'

    if (status === 'keep' && metric !== undefined) {
      state.bestMetric = metric
      state.baselineMetric ??= metric
      state.bestCommit = candidateCommit ?? state.bestCommit
    }
    // The benchmark itself is read-only by contract. Restore the selected
    // checkpoint either way so generated outputs or accidental harness writes
    // cannot leak into the next experiment.
    await restoreBestCheckpoint(repositoryDir, state, signal)
    const stored: StoredAutoresearchResult = {
      version: 1,
      kind: baseline ? 'baseline' : 'candidate',
      status,
      description,
      commit: candidateCommit ?? state.bestCommit,
      metric,
      previousBest,
      memoryGb,
      durationMs,
      changedFiles,
      logFile: basename(execution.logPath),
      error: commandError
    }
    appendResults(job, stored)
    const finished = finishResearchCycle(cycle.id, {
      status: 'completed',
      result: JSON.stringify(stored),
      promptTokens: modelUsage.promptTokens,
      completionTokens: modelUsage.completionTokens,
      error: commandError
    })

    const nextCycleCount = job.cycleCount + 1
    const priorResults = listResearchCycles(job.id)
      .map(parseStoredAutoresearchResult)
      .filter((result): result is StoredAutoresearchResult => Boolean(result))
    const kept = priorResults.filter((result) => result.status === 'keep').length
    const discarded = priorResults.filter((result) => result.status === 'discard').length
    const crashed = priorResults.filter((result) => result.status === 'crash').length
    logExperimentDecision(job, cycle.id, stored)

    job = updateResearchJob(job.id, {
      experimentState: state,
      cycleCount: nextCycleCount,
      // Legacy counters remain populated so older library builds show useful
      // numbers instead of "0 sources" for an Autoresearch job.
      sourceCount: kept,
      findingCount: discarded + crashed,
      status: 'researching',
      phase: 'research',
      nextRunAt: Date.now() + NEXT_EXPERIMENT_DELAY_MS,
      error: baseline && commandError ? commandError : undefined
    })!

    if (baseline && commandError) {
      job = updateResearchJob(job.id, {
        status: 'error',
        phase: 'verify',
        nextRunAt: Date.now() + 60_000,
        error: commandError
      })!
      return { ok: false, job, cycle: finished ?? undefined, completed: false, error: commandError }
    }

    if (shouldComplete(job)) {
      job = await completeAutoresearch(job)
    }
    return { ok: true, job, cycle: finished ?? undefined, completed: job.status === 'completed' }
  } catch (error) {
    const message = publicError(error)
    try {
      await restoreBestCheckpoint(repositoryDir, state, undefined)
    } catch {
      // Preserve the original error; the next cycle retries checkpoint recovery.
    }
    const failed = finishResearchCycle(cycle.id, {
      status: signal?.aborted ? 'cancelled' : 'failed',
      promptTokens: modelUsage.promptTokens,
      completionTokens: modelUsage.completionTokens,
      error: message
    })
    if (!signal?.aborted) {
      updateResearchJob(job.id, {
        status: 'error',
        error: message,
        nextRunAt: Date.now() + 60_000
      })
      logResearchEvent({
        jobId: job.id,
        cycleId: cycle.id,
        kind: 'error',
        title: 'Autoresearch cycle failed before evaluation',
        detail: message
      })
    }
    job = requireAutoresearchJob(job.id)
    return { ok: false, job, cycle: failed ?? undefined, completed: false, error: message }
  }
}

async function ensureAutoresearchWorkspace(job: ResearchJob, signal?: AbortSignal): Promise<ResearchJob> {
  const config = requireExperimentConfig(job)
  const state = job.experimentState ?? { version: 1, setupStatus: 'pending' as const }
  const repositoryDir = safeResearchPath(job.workspaceDir, 'repository')
  const logDir = safeResearchPath(job.workspaceDir, AUTORESEARCH_LOG_DIR)
  mkdirSync(logDir, { recursive: true })
  const branchName = state.branchName ?? researchBranchName(job)

  updateResearchJob(job.id, { status: 'planning', phase: 'understand', error: undefined })
  if (!(await gitWorkspaceReady(repositoryDir, signal))) {
    if (existsSync(repositoryDir)) rmSync(repositoryDir, { recursive: true, force: true })
    if (config.target.kind === 'karpathy-starter') {
      mkdirSync(repositoryDir, { recursive: true })
      await checkedCli('git', ['init'], repositoryDir, signal)
      await checkedCli('git', ['remote', 'add', 'origin', config.target.repositoryUrl], repositoryDir, signal)
      await checkedCli(
        'git',
        ['fetch', '--depth', '1', 'origin', config.target.repositoryRef],
        repositoryDir,
        signal,
        SETUP_TIMEOUT_MS
      )
      await checkedCli('git', ['checkout', '-b', branchName, 'FETCH_HEAD'], repositoryDir, signal)
    } else {
      const sourceRoot = (await checkedCli(
        'git',
        ['rev-parse', '--show-toplevel'],
        config.target.projectPath,
        signal
      )).stdout.trim()
      if (!sourceRoot || !existsSync(sourceRoot)) throw new Error('The selected project is not a Git repository.')
      await checkedCli('git', ['worktree', 'prune'], sourceRoot, signal)
      const existingBranch = await runCli(
        'git',
        ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
        { cwd: sourceRoot, signal, timeoutMs: 30_000 }
      )
      await checkedCli(
        'git',
        existingBranch.code === 0
          ? ['worktree', 'add', repositoryDir, branchName]
          : ['worktree', 'add', '-b', branchName, repositoryDir, 'HEAD'],
        sourceRoot,
        signal
      )
    }
  }

  writeProgram(job, config)
  ensureResultsFile(job)
  if (config.target.kind === 'karpathy-starter' && state.setupStatus !== 'ready') {
    logResearchEvent({
      jobId: job.id,
      kind: 'note',
      title: 'Preparing the pinned Karpathy autoresearch environment',
      detail: 'Akorith is running `uv sync` and the upstream one-time data/tokenizer preparation before the baseline.'
    })
    const sync = await runSetupCommand(job, repositoryDir, ['sync'], 'setup-uv-sync.log', signal)
    if (sync.code !== 0) throw new Error(`uv sync failed: ${tail(`${sync.stdout}\n${sync.stderr}`)}`)
    const prepare = await runSetupCommand(
      job,
      repositoryDir,
      ['run', 'prepare.py'],
      'setup-prepare.log',
      signal
    )
    if (prepare.code !== 0) {
      throw new Error(`uv run prepare.py failed: ${tail(`${prepare.stdout}\n${prepare.stderr}`)}`)
    }
  }
  const head = (await checkedCli('git', ['rev-parse', 'HEAD'], repositoryDir, signal)).stdout.trim()
  const nextState: AutoresearchExperimentState = {
    ...state,
    version: 1,
    setupStatus: 'ready',
    repositoryDir,
    branchName,
    bestCommit: state.bestCommit ?? head
  }
  const updated = updateResearchJob(job.id, {
    experimentState: nextState,
    status: 'planning',
    phase: 'plan',
    nextRunAt: Date.now(),
    error: undefined
  })!
  if (state.setupStatus !== 'ready') {
    logResearchEvent({
      jobId: job.id,
      kind: 'plan_ready',
      title: 'Isolated experiment workspace is ready',
      detail: `${branchName} · ${config.editablePaths.join(', ')} · ${config.command.display}`
    })
  }
  return updated
}

async function runSetupCommand(
  job: ResearchJob,
  repositoryDir: string,
  args: string[],
  logName: string,
  signal?: AbortSignal
): Promise<RunCliResult> {
  const result = await runCli('uv', args, {
    cwd: repositoryDir,
    signal,
    timeoutMs: SETUP_TIMEOUT_MS,
    env: autoresearchEnvironment(job)
  })
  writeBoundedLog(
    safeResearchPath(job.workspaceDir, AUTORESEARCH_LOG_DIR, logName),
    result,
    `uv ${args.join(' ')}`
  )
  return result
}

async function runExperimentCommand(
  job: ResearchJob,
  cycleIndex: number,
  config: AutoresearchExperimentConfig,
  repositoryDir: string,
  signal?: AbortSignal
): Promise<{ result: RunCliResult; logPath: string }> {
  const result = await runCli(config.command.executable, config.command.args, {
    cwd: repositoryDir,
    signal,
    timeoutMs: config.experimentTimeoutMs,
    env: autoresearchEnvironment(job)
  })
  const logPath = safeResearchPath(
    job.workspaceDir,
    AUTORESEARCH_LOG_DIR,
    `experiment-${String(cycleIndex).padStart(4, '0')}.log`
  )
  writeBoundedLog(logPath, result, config.command.display)
  return { result, logPath }
}

async function finishWithoutBenchmark(input: {
  job: ResearchJob
  cycleId: string
  state: AutoresearchExperimentState
  description: string
  changedFiles?: string[]
  error: string
  startedAt: number
  modelUsage: { promptTokens?: number; completionTokens?: number }
  signal?: AbortSignal
}): Promise<ResearchCycleResult> {
  const stored: StoredAutoresearchResult = {
    version: 1,
    kind: 'candidate',
    status: 'crash',
    description: input.description,
    commit: input.state.bestCommit,
    previousBest: input.state.bestMetric,
    durationMs: Date.now() - input.startedAt,
    changedFiles: input.changedFiles ?? [],
    error: input.error
  }
  appendResults(input.job, stored)
  const finished = finishResearchCycle(input.cycleId, {
    status: input.signal?.aborted ? 'cancelled' : 'completed',
    result: JSON.stringify(stored),
    promptTokens: input.modelUsage.promptTokens,
    completionTokens: input.modelUsage.completionTokens,
    error: input.error
  })
  const nextCycleCount = input.job.cycleCount + 1
  logExperimentDecision(input.job, input.cycleId, stored)
  let job = updateResearchJob(input.job.id, {
    cycleCount: nextCycleCount,
    findingCount: input.job.findingCount + 1,
    status: input.signal?.aborted ? 'paused' : 'researching',
    phase: 'research',
    nextRunAt: input.signal?.aborted ? undefined : Date.now() + NEXT_EXPERIMENT_DELAY_MS,
    error: undefined
  })!
  if (shouldComplete(job)) job = await completeAutoresearch(job)
  return { ok: !input.signal?.aborted, job, cycle: finished ?? undefined, completed: job.status === 'completed', error: input.error }
}

function buildExperimentPrompt(
  job: ResearchJob,
  config: AutoresearchExperimentConfig,
  state: AutoresearchExperimentState
): string {
  const recent = listResearchCycles(job.id)
    .map(parseStoredAutoresearchResult)
    .filter((result): result is StoredAutoresearchResult => Boolean(result))
    .slice(-MAX_AGENT_CONTEXT_RESULTS)
    .map((result, index) => {
      const metric = result.metric === undefined ? 'no metric' : `${config.metric.name}=${result.metric}`
      return `${index + 1}. ${result.status.toUpperCase()} · ${metric} · ${result.description}`
    })
    .join('\n')
  return `Read the repository and perform exactly one focused autonomous research experiment.

Research objective:
${job.prompt}

Protocol:
- Current best ${config.metric.name}: ${state.bestMetric ?? 'baseline not recorded'} (${config.metric.direction} is better).
- You may edit only: ${config.editablePaths.join(', ')}.
- Do not edit the evaluation harness, package dependencies, Git metadata, or any other path.
- Do not create a commit. Akorith owns commits and rollback.
- Do not run the experiment command (${config.command.display}). Akorith runs it once after your edit.
- Make one coherent hypothesis-driven change, keeping the diff small and reviewable.
- If prior ideas failed, do not repeat them unchanged.
- Finish with a concise description of the hypothesis and exact change.

Recent experiment ledger:
${recent || 'Only the baseline exists; choose the first measured hypothesis.'}`
}

function writeProgram(job: ResearchJob, config: AutoresearchExperimentConfig): void {
  const text = `# Akorith Autoresearch Program

This workspace follows the autonomous experiment protocol introduced by
karpathy/autoresearch and adapted for Akorith.

## Objective

${job.prompt}

## Immutable experiment contract

- Command: \`${config.command.display}\`
- Metric: \`${config.metric.name}\` (${config.metric.direction})
- Editable boundary: ${config.editablePaths.map((path) => `\`${path}\``).join(', ')}
- Per-run timeout: ${Math.round(config.experimentTimeoutMs / 60_000)} minutes
- Baseline first; keep only strict improvements; discard equal or worse results.
- Crashes are logged and rolled back.
- The loop continues until its duration budget is exhausted or the user pauses it.
`
  writeFileSync(safeResearchPath(job.workspaceDir, AUTORESEARCH_PROGRAM_FILE), text, 'utf8')
}

function ensureResultsFile(job: ResearchJob): void {
  const path = safeResearchPath(job.workspaceDir, AUTORESEARCH_RESULTS_FILE)
  if (!existsSync(path)) {
    writeFileSync(path, 'commit\tmetric\tmemory_gb\tstatus\tdescription\n', 'utf8')
  }
}

function appendResults(job: ResearchJob, result: StoredAutoresearchResult): void {
  ensureResultsFile(job)
  const path = safeResearchPath(job.workspaceDir, AUTORESEARCH_RESULTS_FILE)
  const line = [
    result.commit?.slice(0, 7) ?? '-------',
    result.metric === undefined ? '0.000000' : result.metric.toFixed(6),
    result.memoryGb === undefined ? '0.0' : result.memoryGb.toFixed(1),
    result.status,
    oneLine(result.description || result.error || 'experiment')
  ].join('\t')
  writeFileSync(path, `${readFileSync(path, 'utf8').replace(/\s*$/, '\n')}${line}\n`, 'utf8')
}

async function changedWorkspacePaths(repositoryDir: string, signal?: AbortSignal): Promise<string[]> {
  const result = await checkedCli(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
    repositoryDir,
    signal
  )
  return [...new Set(result.stdout.split('\0').flatMap((entry) => {
    if (entry.length < 4 || entry[2] !== ' ') return []
    const path = entry.slice(3).replace(/\\/g, '/')
    return path ? [path] : []
  }))]
}

async function commitCandidate(
  repositoryDir: string,
  cycleIndex: number,
  description: string,
  config: AutoresearchExperimentConfig,
  signal?: AbortSignal
): Promise<string> {
  await checkedCli('git', ['add', '--all', '--', ...config.editablePaths], repositoryDir, signal)
  const staged = await runCli('git', ['diff', '--cached', '--quiet'], {
    cwd: repositoryDir,
    signal,
    timeoutMs: 60_000
  })
  if (staged.code === 0) throw new Error('The experiment produced no staged change.')
  if (staged.code !== 1) throw new Error(`Git could not inspect the staged experiment (code ${staged.code}).`)
  await checkedCli(
    'git',
    [
      '-c', 'user.name=Akorith Autoresearch',
      '-c', 'user.email=autoresearch@local.invalid',
      'commit',
      '-m',
      `autoresearch experiment ${cycleIndex}: ${oneLine(description).slice(0, 120)}`
    ],
    repositoryDir,
    signal
  )
  return (await checkedCli('git', ['rev-parse', 'HEAD'], repositoryDir, signal)).stdout.trim()
}

async function restoreBestCheckpoint(
  repositoryDir: string,
  state: AutoresearchExperimentState,
  signal?: AbortSignal
): Promise<void> {
  if (!state.bestCommit) return
  await checkedCli('git', ['reset', '--hard', state.bestCommit], repositoryDir, signal)
  await checkedCli('git', ['clean', '-fdx'], repositoryDir, signal)
}

function autoresearchEnvironment(job: ResearchJob): NodeJS.ProcessEnv | undefined {
  if (job.experimentConfig?.target.kind !== 'karpathy-starter') return undefined
  // Keep the reusable uv environment outside the Git worktree. This lets the
  // rollback path remove every ignored experiment artifact without rebuilding
  // dependencies or exposing the environment to model-authored repository edits.
  return {
    UV_PROJECT_ENVIRONMENT: safeResearchPath(job.workspaceDir, 'environment')
  }
}

async function completeAutoresearch(job: ResearchJob): Promise<ResearchJob> {
  const config = requireExperimentConfig(job)
  const state = requireExperimentState(job)
  const results = listResearchCycles(job.id)
    .map(parseStoredAutoresearchResult)
    .filter((result): result is StoredAutoresearchResult => Boolean(result))
  const kept = results.filter((result) => result.status === 'keep')
  const discarded = results.filter((result) => result.status === 'discard')
  const crashed = results.filter((result) => result.status === 'crash')
  const delta = state.baselineMetric === undefined || state.bestMetric === undefined
    ? undefined
    : state.bestMetric - state.baselineMetric
  const rows = results.map((result, index) =>
    `| ${index + 1} | ${result.kind} | ${result.status} | ${result.metric ?? '—'} | ${result.commit?.slice(0, 7) ?? '—'} | ${markdownCell(result.description)} |`
  ).join('\n')
  const report = `# ${job.title}

## Abstract

Akorith ran an isolated, repeatable Autoresearch program for: ${job.prompt}
The baseline was ${formatMetric(state.baselineMetric)} and the best retained
${config.metric.name} was ${formatMetric(state.bestMetric)}.

## Method

The run follows the core protocol from karpathy/autoresearch: one editable
surface, a fixed experiment command, one comparable metric, a baseline first,
and automatic keep/discard rollback. Akorith ran \`${config.command.display}\`
with a ${Math.round(config.experimentTimeoutMs / 60_000)} minute cap and allowed
changes only in ${config.editablePaths.map((path) => `\`${path}\``).join(', ')}.
The work was isolated on branch \`${state.branchName ?? 'autoresearch'}\`.

## Results

| # | Kind | Decision | ${config.metric.name} | Commit | Experiment |
|---:|---|---|---:|---|---|
${rows || '| 1 | baseline | crash | — | — | No successful experiment |'}

Retained: ${kept.length}. Discarded: ${discarded.length}. Crashed: ${crashed.length}.
${delta === undefined ? '' : `Net metric change from baseline: ${delta > 0 ? '+' : ''}${delta.toFixed(6)}.`}

## Conclusion

The branch remains at commit \`${state.bestCommit?.slice(0, 12) ?? 'unavailable'}\`,
the best verified checkpoint. Rejected and crashed candidates remain in the
durable experiment ledger and were removed from the working tree.
`
  writeFileSync(safeResearchPath(job.workspaceDir, RESEARCH_REPORT_FILE), report, 'utf8')
  const summary = state.bestMetric === undefined
    ? 'Autoresearch completed without a valid metric.'
    : `Best ${config.metric.name}: ${state.bestMetric}. ${kept.length} retained, ${discarded.length} discarded, ${crashed.length} crashed.`
  let completed = updateResearchJob(job.id, {
    status: 'completed',
    phase: 'export',
    summary,
    completedAt: Date.now(),
    nextRunAt: undefined,
    error: undefined
  })!
  logResearchEvent({
    jobId: job.id,
    kind: 'completed',
    title: 'Autoresearch program completed',
    detail: summary
  })
  try {
    const { exportResearchJob } = await import('./exporters')
    await exportResearchJob(job.id, 'md')
    completed = requireAutoresearchJob(job.id)
  } catch (error) {
    logResearchEvent({
      jobId: job.id,
      kind: 'warning',
      title: 'The experiment report is readable, but Markdown packaging failed',
      detail: publicError(error)
    })
  }
  return completed
}

function shouldComplete(job: ResearchJob): boolean {
  if (job.depth === 'continuous') return false
  const profile = RESEARCH_DEPTH_PROFILES[job.depth]
  // Evidence Research used maxCycles as a source-coverage cap. Autoresearch is
  // explicitly time-boxed: fast benchmarks should be allowed to complete more
  // experiments, while the upstream five-minute benchmark naturally yields
  // about twelve runs per hour.
  return profile.targetDurationMs > 0 && job.activeElapsedMs >= profile.targetDurationMs
}

function logExperimentDecision(
  job: ResearchJob,
  cycleId: string,
  result: StoredAutoresearchResult
): void {
  const metric = result.metric === undefined
    ? 'no metric'
    : `${requireExperimentConfig(job).metric.name} ${result.metric}`
  logResearchEvent({
    jobId: job.id,
    cycleId,
    kind: result.kind === 'baseline' && result.status === 'keep'
      ? 'baseline_recorded'
      : result.status === 'keep'
        ? 'experiment_kept'
        : result.status === 'discard'
          ? 'experiment_discarded'
          : 'experiment_crashed',
    title: result.kind === 'baseline'
      ? result.status === 'keep' ? `Baseline recorded · ${metric}` : 'Baseline failed'
      : result.status === 'keep'
        ? `Improvement kept · ${metric}`
        : result.status === 'discard'
          ? `Candidate discarded · ${metric}`
          : 'Candidate crashed and was rolled back',
    detail: result.error ? `${result.description}\n\n${result.error}` : result.description
  })
}

function requireAutoresearchJob(jobId: string): ResearchJob {
  const job = getResearchJob(jobId)
  if (!job) throw new Error('Research job not found.')
  if (job.mode !== 'autoresearch') throw new Error('Research job is not an Autoresearch program.')
  return job
}

function requireExperimentConfig(job: ResearchJob): AutoresearchExperimentConfig {
  if (!job.experimentConfig || job.experimentConfig.version !== 1) {
    throw new Error('Autoresearch configuration is unavailable.')
  }
  return job.experimentConfig
}

function requireExperimentState(job: ResearchJob): AutoresearchExperimentState {
  const state = job.experimentState
  if (!state || state.version !== 1 || state.setupStatus !== 'ready') {
    throw new Error('Autoresearch workspace is not ready.')
  }
  return { ...state }
}

function requireManagedRepository(job: ResearchJob, state: AutoresearchExperimentState): string {
  if (!state.repositoryDir || !isManagedResearchPath(job.workspaceDir, state.repositoryDir)) {
    throw new Error('Autoresearch repository is outside its managed workspace.')
  }
  if (!isGitWorkspace(state.repositoryDir)) throw new Error('Autoresearch repository is unavailable.')
  return state.repositoryDir
}

function researchBranchName(job: ResearchJob): string {
  const date = new Date(job.createdAt).toISOString().slice(0, 10).replace(/-/g, '')
  return `autoresearch/${date}-${job.id.slice(0, 8)}`
}

function isGitWorkspace(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    if (!statSync(path).isDirectory()) return false
    return existsSync(join(path, '.git'))
  } catch {
    return false
  }
}

async function gitWorkspaceReady(path: string, signal?: AbortSignal): Promise<boolean> {
  if (!isGitWorkspace(path)) return false
  try {
    const result = await runCli('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: path,
      signal,
      timeoutMs: 30_000
    })
    return result.code === 0 && /^[a-f0-9]{40,64}$/i.test(result.stdout.trim())
  } catch {
    return false
  }
}

async function checkedCli(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 60_000
): Promise<RunCliResult> {
  const result = await runCli(command, args, { cwd, signal, timeoutMs })
  if (result.code !== 0) {
    throw new Error(`${command} failed with code ${result.code ?? 'unknown'}: ${tail(`${result.stderr}\n${result.stdout}`)}`)
  }
  return result
}

function writeBoundedLog(path: string, result: RunCliResult, command: string): void {
  const content = [
    `command: ${command}`,
    `exit_code: ${result.code ?? 'unknown'}`,
    '',
    '--- stdout ---',
    result.stdout,
    '',
    '--- stderr ---',
    result.stderr
  ].join('\n')
  const bounded = content.length > MAX_LOG_BYTES
    ? `[Earlier output truncated by Akorith]\n${content.slice(-MAX_LOG_BYTES)}`
    : content
  writeFileSync(path, bounded, 'utf8')
}

function experimentDescription(value: string): string {
  const text = oneLine(value)
  if (!text) return 'Focused agent experiment'
  return text.slice(0, 500)
}

function oneLine(value: string): string {
  return value
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function markdownCell(value: string): string {
  return oneLine(value).replace(/\|/g, '\\|')
}

function tail(value: string): string {
  const clean = value.replace(/\0/g, '').trim()
  return clean.length > 1_200 ? `…${clean.slice(-1_199)}` : clean
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatMetric(value: number | undefined): string {
  return value === undefined ? 'unavailable' : value.toFixed(6)
}
