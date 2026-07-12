import { randomUUID } from 'node:crypto'
import { loopCommitMessage, loopSafetyLimitReason, isPermanentRepositoryFailure, shouldHardStopInfrastructure } from './engine-policy'
import type { AutonomousLoopEngineDependencies, LoopCycleRunResult, LoopModelDecision, LoopRepositorySession } from './engine-types'
import type { AutonomousLoopStore } from './store'
import type {
  AutonomousLoopRecord,
  AutonomousLoopStage,
  LoopActivityLevel,
  LoopCycleRecord,
  LoopPlannedTask,
  LoopReviewResult,
  LoopTokenUsage,
  LoopValidationResult,
  RepositorySnapshot
} from './types'

const LEASE_TTL_MS = 90_000
const LEASE_HEARTBEAT_MS = 30_000
const EMPTY_USAGE: LoopTokenUsage = { input: 0, output: 0, cached: 0, costUsd: 0 }

function addUsage(left: LoopTokenUsage, right: LoopTokenUsage): LoopTokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cached: left.cached + right.cached,
    costUsd: left.costUsd + right.costUsd
  }
}

function initialCycle(loop: AutonomousLoopRecord, id: string, index: number, now: number): LoopCycleRecord {
  return {
    id,
    loopId: loop.id,
    index,
    status: 'running',
    stage: 'observing',
    plannedTask: null,
    executorCatalogId: loop.executor.catalogId,
    executorProviderId: loop.executor.providerId,
    executorModel: loop.executor.model,
    plannerCatalogId: loop.planner.catalogId,
    plannerProviderId: loop.planner.providerId,
    plannerModel: loop.planner.model,
    reviewerCatalogId: null,
    reviewerProviderId: null,
    reviewerModel: null,
    repairAttempts: 0,
    startedAt: now,
    finishedAt: null,
    durationMs: null,
    validation: null,
    review: null,
    changedFiles: [],
    commitSha: null,
    commitMessage: null,
    pushed: false,
    tokenUsage: { ...EMPTY_USAGE },
    summary: null,
    error: null
  }
}

function failedValidation(summary: string, changedFiles: readonly string[]): LoopValidationResult {
  return {
    passed: false,
    commands: [],
    changedFiles: [...changedFiles],
    regressionDetected: changedFiles.length > 0,
    failureSummary: summary.slice(0, 4_000)
  }
}

function asMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\0/g, '').slice(0, 4_000)
}

export class AutonomousLoopEngine {
  constructor(
    private readonly store: AutonomousLoopStore,
    private readonly dependencies: AutonomousLoopEngineDependencies
  ) {}

  private event(input: {
    loopId: string
    cycleId: string | null
    stage: AutonomousLoopStage
    level?: LoopActivityLevel
    kind: string
    title: string
    summary: string
    details?: Record<string, string | number | boolean | null>
  }): void {
    this.store.appendEvent({
      ...input,
      occurredAt: this.dependencies.now(),
      level: input.level ?? 'info',
      details: input.details ?? {}
    })
  }

  private setStage(loop: AutonomousLoopRecord, cycle: LoopCycleRecord, stage: AutonomousLoopStage): LoopCycleRecord {
    const now = this.dependencies.now()
    this.store.setLoopState(loop.id, { stage, lastActivityAt: now })
    return this.store.updateCycle({ ...cycle, stage })
  }

  private gate(loopId: string): 'continue' | 'pause' | 'stop' {
    const loop = this.store.getLoop(loopId)
    if (!loop) return 'stop'
    if (loop.status === 'pausing' || loop.status === 'paused') return 'pause'
    if (loop.status === 'stopping' || loop.status === 'stopped' || loop.status === 'error') return 'stop'
    return 'continue'
  }

  private recordDecision<T>(
    loop: AutonomousLoopRecord,
    cycle: LoopCycleRecord,
    role: 'planner' | 'reviewer',
    decision: LoopModelDecision<T>
  ): void {
    const selection = role === 'planner' ? loop.planner : loop.planner
    this.store.recordModelCall({
      loopId: loop.id,
      cycleId: cycle.id,
      role,
      providerId: selection.providerId,
      model: selection.model,
      catalogId: selection.catalogId,
      location: selection.location,
      nodeId: selection.nodeId,
      durationMs: decision.durationMs,
      tokenUsage: decision.usage,
      estimated: decision.estimated,
      outcome: 'completed'
    })
  }

  private recordExecution(
    loop: AutonomousLoopRecord,
    cycle: LoopCycleRecord,
    role: 'executor' | 'repair',
    attempt: number,
    result: Awaited<ReturnType<AutonomousLoopEngineDependencies['execute']>>
  ): void {
    this.store.recordModelCall({
      loopId: loop.id,
      cycleId: cycle.id,
      role,
      attemptIndex: attempt,
      providerId: loop.executor.providerId,
      model: loop.executor.model,
      catalogId: loop.executor.catalogId,
      location: loop.executor.location,
      nodeId: loop.executor.nodeId,
      durationMs: result.durationMs,
      tokenUsage: result.usage,
      estimated: result.estimatedUsage,
      outcome: result.outcome === 'completed' ? 'completed' : result.outcome === 'cancelled' ? 'cancelled' : 'failed',
      errorCode: result.errorCode ?? undefined
    })
  }

  private async restoreAttempt(
    session: LoopRepositorySession,
    checkpoint: Awaited<ReturnType<LoopRepositorySession['checkpoint']>>,
    changedFiles: readonly string[]
  ): Promise<void> {
    if (changedFiles.length > 0) await session.restore(checkpoint, changedFiles)
  }

  private finishControlState(loop: AutonomousLoopRecord, kind: 'pause' | 'stop'): LoopCycleRunResult {
    const now = this.dependencies.now()
    if (kind === 'pause') {
      this.store.setLoopState(loop.id, {
        status: 'paused', stage: 'idle', activeCycleId: null, pausedAt: now, nextCycleAt: null
      })
      return { loopId: loop.id, cycleId: loop.activeCycleId, outcome: 'paused', nextCycleAt: null, error: null }
    }
    this.store.setLoopState(loop.id, {
      status: 'stopped', stage: 'idle', activeCycleId: null, stoppedAt: now, nextCycleAt: null,
      stopReason: loop.stopReason ?? 'Stopped by user.'
    })
    return { loopId: loop.id, cycleId: loop.activeCycleId, outcome: 'stopped', nextCycleAt: null, error: null }
  }

  private async recoverUnpushed(
    loop: AutonomousLoopRecord,
    session: LoopRepositorySession
  ): Promise<LoopCycleRunResult | null> {
    const pending = this.store.listCycles(loop.id, 1)[0]
    if (!pending || pending.status !== 'committed' || pending.pushed || !pending.commitSha) return null
    this.event({
      loopId: loop.id, cycleId: pending.id, stage: 'pushing', kind: 'push-retry',
      title: 'Retrying repository push', summary: `Retrying push for ${pending.commitSha.slice(0, 10)}.`
    })
    await session.push(loop.branch)
    const now = this.dependencies.now()
    this.store.updateCycle({
      ...pending, status: 'pushed', stage: 'scheduling', pushed: true,
      finishedAt: now, durationMs: pending.startedAt === null ? null : now - pending.startedAt
    })
    this.store.applyLoopCounters(loop.id, { pushCount: 1, successfulTasks: 1 })
    const nextCycleAt = now + this.dependencies.delayMs
    this.store.setLoopState(loop.id, {
      status: 'running', stage: 'scheduling', activeCycleId: null, nextCycleAt,
      lastActivityAt: now, consecutiveInfrastructureFailures: 0, error: null
    })
    this.event({
      loopId: loop.id, cycleId: pending.id, stage: 'pushing', level: 'success', kind: 'push-complete',
      title: 'Push completed', summary: `Pushed recovered commit ${pending.commitSha.slice(0, 10)}.`
    })
    return { loopId: loop.id, cycleId: pending.id, outcome: 'pushed', nextCycleAt, error: null }
  }

  async runCycle(loopId: string, signal?: AbortSignal): Promise<LoopCycleRunResult> {
    let loop = this.store.getLoop(loopId)
    if (!loop) throw new Error(`Autonomous Loop ${loopId} was not found.`)
    const gate = this.gate(loopId)
    if (gate !== 'continue') return this.finishControlState(loop, gate)
    if (loop.status !== 'running' && loop.status !== 'setting_up') {
      return { loopId, cycleId: null, outcome: 'cancelled', nextCycleAt: loop.nextCycleAt, error: null }
    }
    const safetyReason = loopSafetyLimitReason(loop)
    if (safetyReason) {
      this.store.setLoopState(loop.id, {
        status: 'stopped', stage: 'idle', activeCycleId: null, stoppedAt: this.dependencies.now(),
        stopReason: safetyReason, nextCycleAt: null
      })
      return { loopId, cycleId: null, outcome: 'stopped', nextCycleAt: null, error: safetyReason }
    }

    const leaseNow = this.dependencies.now()
    const dbLease = this.store.acquireLease({
      repositoryId: loop.repositoryId,
      loopId: loop.id,
      acquiredAt: leaseNow,
      heartbeatAt: leaseNow,
      expiresAt: leaseNow + LEASE_TTL_MS,
      processId: process.pid
    }, leaseNow)
    if (!dbLease) {
      const error = 'Another autonomous Loop owns this repository.'
      return { loopId, cycleId: null, outcome: 'infrastructure-failure', nextCycleAt: loop.nextCycleAt, error }
    }

    let session: LoopRepositorySession | null = null
    let cycle: LoopCycleRecord | null = null
    let checkpoint: Awaited<ReturnType<LoopRepositorySession['checkpoint']>> | null = null
    let changedFiles: string[] = []
    let heartbeat: NodeJS.Timeout | null = null
    try {
      session = await this.dependencies.acquireRepository(loop, signal)
      heartbeat = setInterval(() => {
        const now = this.dependencies.now()
        this.store.heartbeatLease(loop!.repositoryId, loop!.id, now, now + LEASE_TTL_MS)
        void session?.heartbeat().catch(() => undefined)
      }, LEASE_HEARTBEAT_MS)

      const recovered = await this.recoverUnpushed(loop, session)
      if (recovered) return recovered

      const now = this.dependencies.now()
      cycle = this.store.createCycle(initialCycle(loop, randomUUID(), this.store.nextCycleIndex(loop.id), now))
      this.store.setLoopState(loop.id, {
        status: 'running', stage: 'observing', activeCycleId: cycle.id, startedAt: loop.startedAt ?? now,
        lastActivityAt: now, nextCycleAt: null, error: null
      })
      this.event({
        loopId, cycleId: cycle.id, stage: 'observing', kind: 'analysis-started',
        title: 'Repository analysis started', summary: `Cycle ${cycle.index} is observing the latest repository state.`
      })

      const snapshot = await this.dependencies.observe(loop, signal)
      this.store.saveSnapshot(loop.id, cycle.id, snapshot)
      cycle = this.setStage(loop, cycle, 'inventory')
      const inventory = this.dependencies.buildInventory(snapshot)
      this.store.saveInventory(loop.id, cycle.id, inventory)
      await session.heartbeat()
      this.event({
        loopId, cycleId: cycle.id, stage: 'inventory', level: 'success', kind: 'inventory-updated',
        title: 'Feature inventory updated',
        summary: `${inventory.highValueNextSteps.length} evidence-backed next steps are available.`,
        details: { files: snapshot.fileCount, languages: snapshot.languages.length }
      })

      if (this.gate(loopId) !== 'continue' || signal?.aborted) throw new Error('cycle-control-requested')
      cycle = this.setStage(loop, cycle, 'planning')
      const priorCycles = this.store.listCycles(loop.id, 30).filter((item) => item.id !== cycle!.id).reverse()
      const planned = await this.dependencies.plan({ loop, snapshot, inventory, priorCycles, signal })
      this.recordDecision(loop, cycle, 'planner', planned)
      cycle = this.store.updateCycle({
        ...cycle, plannedTask: planned.value, tokenUsage: addUsage(cycle.tokenUsage, planned.usage)
      })
      this.event({
        loopId, cycleId: cycle.id, stage: 'planning', kind: 'task-selected',
        title: planned.value.title, summary: planned.value.reason,
        details: { kind: planned.value.kind, risk: planned.value.riskLevel, complexity: planned.value.estimatedComplexity }
      })

      checkpoint = await session.checkpoint()
      let validation: LoopValidationResult = failedValidation('Execution has not run.', [])
      let review: LoopReviewResult | null = null
      let executionSummary = ''
      let accepted = false
      for (let attempt = 0; attempt <= loop.limits.maxRepairAttempts; attempt += 1) {
        if (this.gate(loopId) !== 'continue' || signal?.aborted) throw new Error('cycle-control-requested')
        const repair = attempt > 0
        cycle = this.setStage(loop, cycle, repair ? 'repairing' : 'executing')
        if (repair) {
          cycle = this.store.updateCycle({ ...cycle, status: 'repairing', repairAttempts: attempt })
          this.event({
            loopId, cycleId: cycle.id, stage: 'repairing', level: 'warning', kind: 'repair-attempt',
            title: `Repair attempt ${attempt}`, summary: validation.failureSummary ?? review?.rationale ?? 'Independent review requested a repair.'
          })
        }
        const execution = await this.dependencies.execute({
          workspacePath: loop.workspacePath,
          selection: loop.executor,
          task: planned.value,
          repositoryContext: JSON.stringify({ snapshot, inventory }),
          repair: repair ? { attempt, priorSummary: executionSummary, validation } : undefined,
          timeoutMs: loop.limits.validationTimeoutMs,
          signal,
          onEvent: (event) => this.event({
            loopId, cycleId: cycle?.id ?? null, stage: repair ? 'repairing' : 'executing',
            kind: `executor-${event.kind}`, title: event.summary, summary: event.summary, details: event.details
          })
        })
        this.recordExecution(loop, cycle, repair ? 'repair' : 'executor', attempt, execution)
        executionSummary = execution.summary
        changedFiles = [...new Set([...changedFiles, ...execution.changedFiles])]
        cycle = this.store.updateCycle({
          ...cycle,
          changedFiles,
          tokenUsage: addUsage(cycle.tokenUsage, execution.usage),
          summary: execution.summary
        })
        if (execution.outcome === 'cancelled') throw new Error('cycle-control-requested')
        if (execution.outcome === 'unavailable') throw new Error(execution.summary)
        if (execution.outcome !== 'completed') {
          validation = failedValidation(execution.summary, changedFiles)
          if (!execution.retryable) break
          continue
        }

        cycle = this.setStage(loop, cycle, 'validating')
        validation = await this.dependencies.validate({
          loop, snapshot, task: planned.value, changedFiles, signal
        })
        validation.commands.forEach((command, index) => {
          this.store.recordCommand(loop.id, cycle!.id, attempt, index, command)
        })
        changedFiles = [...new Set([...changedFiles, ...validation.changedFiles])]
        cycle = this.store.updateCycle({ ...cycle, validation, changedFiles })
        this.event({
          loopId, cycleId: cycle.id, stage: 'validating',
          level: validation.passed ? 'success' : 'warning', kind: validation.passed ? 'validation-passed' : 'validation-failed',
          title: validation.passed ? 'Validation passed' : 'Validation failed',
          summary: validation.failureSummary ?? `${validation.commands.length} validation commands passed.`,
          details: { commands: validation.commands.length, changedFiles: validation.changedFiles.length }
        })
        if (!validation.passed) continue

        cycle = this.setStage(loop, cycle, 'reviewing')
        const reviewed = await this.dependencies.review({ loop, task: planned.value, validation, signal })
        this.recordDecision(loop, cycle, 'reviewer', reviewed)
        review = reviewed.value
        cycle = this.store.updateCycle({
          ...cycle, review, tokenUsage: addUsage(cycle.tokenUsage, reviewed.usage),
          reviewerCatalogId: loop.planner.catalogId,
          reviewerProviderId: loop.planner.providerId,
          reviewerModel: loop.planner.model
        })
        this.event({
          loopId, cycleId: cycle.id, stage: 'reviewing', level: review.accepted ? 'success' : 'warning',
          kind: review.accepted ? 'review-accepted' : 'review-rejected',
          title: review.accepted ? 'Independent review accepted the change' : 'Independent review requested repair',
          summary: review.rationale
        })
        if (review.accepted) {
          accepted = true
          break
        }
        validation = failedValidation(review.rationale, changedFiles)
      }

      if (!accepted) {
        await this.restoreAttempt(session, checkpoint, changedFiles)
        const finishedAt = this.dependencies.now()
        cycle = this.store.updateCycle({
          ...cycle, status: 'reverted', stage: 'scheduling', validation, review,
          finishedAt, durationMs: cycle.startedAt === null ? null : finishedAt - cycle.startedAt,
          error: validation.failureSummary ?? review?.rationale ?? 'Repair ceiling reached.'
        })
        this.store.applyLoopCounters(loop.id, { failedTasks: 1 }, cycle.tokenUsage)
        const nextCycleAt = finishedAt + this.dependencies.delayMs
        this.store.setLoopState(loop.id, {
          status: 'running', stage: 'scheduling', activeCycleId: null, nextCycleAt,
          lastActivityAt: finishedAt, consecutiveInfrastructureFailures: 0, error: null
        })
        this.event({
          loopId, cycleId: cycle.id, stage: 'scheduling', level: 'warning', kind: 'task-reverted',
          title: 'Task reverted safely', summary: 'The repair ceiling was reached; Loop will select a different task next.'
        })
        return { loopId, cycleId: cycle.id, outcome: 'reverted', nextCycleAt, error: cycle.error }
      }

      cycle = this.setStage(loop, cycle, 'committing')
      const commitMessage = loopCommitMessage(planned.value)
      const committed = await session.commit(changedFiles, commitMessage)
      cycle = this.store.updateCycle({
        ...cycle, status: 'committed', commitSha: committed.sha, commitMessage,
        changedFiles: committed.paths
      })
      this.store.applyLoopCounters(loop.id, { commitCount: 1 }, cycle.tokenUsage)
      this.event({
        loopId, cycleId: cycle.id, stage: 'committing', level: 'success', kind: 'commit-created',
        title: 'Commit created', summary: `${committed.sha.slice(0, 10)} ${commitMessage}`,
        details: { files: committed.paths.length }
      })

      cycle = this.setStage(loop, cycle, 'pushing')
      try {
        await session.push(loop.branch)
      } catch (error) {
        const message = asMessage(error)
        const permanent = isPermanentRepositoryFailure(error)
        const failures = loop.consecutiveInfrastructureFailures + 1
        this.store.setLoopState(loop.id, {
          status: permanent || shouldHardStopInfrastructure(loop, failures) ? 'error' : 'running',
          stage: 'pushing', activeCycleId: null,
          nextCycleAt: permanent ? null : this.dependencies.now() + this.dependencies.delayMs,
          consecutiveInfrastructureFailures: failures, error: message,
          stopReason: permanent ? message : null
        })
        this.event({
          loopId, cycleId: cycle.id, stage: 'pushing', level: 'error', kind: 'push-failed',
          title: 'Push failed', summary: message, details: { permanent }
        })
        return {
          loopId, cycleId: cycle.id, outcome: 'infrastructure-failure',
          nextCycleAt: permanent ? null : this.dependencies.now() + this.dependencies.delayMs,
          error: message
        }
      }

      const finishedAt = this.dependencies.now()
      cycle = this.store.updateCycle({
        ...cycle, status: 'pushed', stage: 'scheduling', pushed: true,
        finishedAt, durationMs: cycle.startedAt === null ? null : finishedAt - cycle.startedAt
      })
      this.store.applyLoopCounters(loop.id, { pushCount: 1, successfulTasks: 1 })
      const nextCycleAt = finishedAt + this.dependencies.delayMs
      this.store.setLoopState(loop.id, {
        status: 'running', stage: 'scheduling', activeCycleId: null, nextCycleAt,
        lastActivityAt: finishedAt, consecutiveInfrastructureFailures: 0, error: null
      })
      this.event({
        loopId, cycleId: cycle.id, stage: 'pushing', level: 'success', kind: 'push-complete',
        title: 'Task committed and pushed', summary: `${planned.value.title} is now on ${loop.branch}.`,
        details: { commit: cycle.commitSha, files: cycle.changedFiles.length }
      })
      return { loopId, cycleId: cycle.id, outcome: 'pushed', nextCycleAt, error: null }
    } catch (error) {
      const current = this.store.getLoop(loopId) ?? loop
      const control = this.gate(loopId)
      const cancelled = signal?.aborted === true || asMessage(error) === 'cycle-control-requested'
      const hasCommittedChange = cycle?.commitSha !== null && cycle?.commitSha !== undefined
      if (session && checkpoint && changedFiles.length > 0 && !hasCommittedChange) {
        await this.restoreAttempt(session, checkpoint, changedFiles).catch(() => undefined)
      }
      if (cycle) {
        const finishedAt = this.dependencies.now()
        cycle = this.store.updateCycle({
          ...cycle,
          status: cancelled ? 'cancelled' : 'failed',
          finishedAt,
          durationMs: cycle.startedAt === null ? null : finishedAt - cycle.startedAt,
          error: cancelled ? 'Cycle cancelled at a safe boundary.' : asMessage(error)
        })
      }
      if (control !== 'continue') return this.finishControlState(current, control)
      if (cancelled) {
        this.store.setLoopState(loopId, {
          status: 'running', stage: 'idle', activeCycleId: null,
          nextCycleAt: this.dependencies.now() + this.dependencies.delayMs
        })
        return {
          loopId, cycleId: cycle?.id ?? null, outcome: 'cancelled',
          nextCycleAt: this.dependencies.now() + this.dependencies.delayMs, error: null
        }
      }
      const message = asMessage(error)
      const failures = current.consecutiveInfrastructureFailures + 1
      const permanent = isPermanentRepositoryFailure(error)
      const hardStop = permanent || shouldHardStopInfrastructure(current, failures)
      const nextCycleAt = hardStop ? null : this.dependencies.now() + this.dependencies.delayMs
      this.store.setLoopState(loopId, {
        status: hardStop ? 'error' : 'running', stage: 'idle', activeCycleId: null, nextCycleAt,
        consecutiveInfrastructureFailures: failures, error: message,
        stopReason: hardStop ? message : null
      })
      this.event({
        loopId, cycleId: cycle?.id ?? null, stage: cycle?.stage ?? 'idle', level: 'error',
        kind: 'infrastructure-failure', title: hardStop ? 'Loop requires attention' : 'Cycle infrastructure failed',
        summary: message, details: { consecutiveFailures: failures, hardStop }
      })
      return { loopId, cycleId: cycle?.id ?? null, outcome: 'infrastructure-failure', nextCycleAt, error: message }
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      await session?.release().catch(() => undefined)
      this.store.releaseLease(loop.repositoryId, loop.id)
    }
  }
}
