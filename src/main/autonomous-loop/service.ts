import type { RepositoryService } from '../repository'
import type { CatalogDiscoveryResult, ModelCatalogService } from '../model-catalog'
import type { AutonomousLoopEngine } from './engine'
import type { LoopOnboardingReview, LoopOnboardingService } from './onboarding'
import type { AutonomousLoopStore } from './store'
import type { AutonomousLoopRecord, LoopActivityEvent, LoopCycleRecord } from './types'

export interface AutonomousLoopDetail {
  loop: AutonomousLoopRecord
  cycles: LoopCycleRecord[]
  events: LoopActivityEvent[]
}

export interface AutonomousLoopServiceOptions {
  store: AutonomousLoopStore
  engine: AutonomousLoopEngine
  onboarding: LoopOnboardingService
  catalog: ModelCatalogService
  repository: RepositoryService
  now?: () => number
}

const MAX_TIMER_MS = 2_147_000_000

export class AutonomousLoopService {
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<(loopId: string) => void>()
  private readonly now: () => number
  private disposed = false

  constructor(private readonly options: AutonomousLoopServiceOptions) {
    this.now = options.now ?? Date.now
  }

  subscribe(listener: (loopId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(loopId: string): void {
    for (const listener of this.listeners) {
      try { listener(loopId) } catch { /* listeners are isolated */ }
    }
  }

  list(): AutonomousLoopRecord[] {
    return this.options.store.listLoops(1_000)
  }

  detail(loopId: string): AutonomousLoopDetail | null {
    const loop = this.options.store.getLoop(loopId)
    if (!loop) return null
    return {
      loop,
      cycles: this.options.store.listCycles(loopId, 200),
      events: this.options.store.listEvents(loopId, 1_000)
    }
  }

  catalog(signal?: AbortSignal): Promise<CatalogDiscoveryResult> {
    return this.options.catalog.discover(signal)
  }

  probe(catalogModelId: string, signal?: AbortSignal) {
    return this.options.catalog.runProbe(catalogModelId, 'code_execution', { signal })
  }

  async create(input: unknown, signal?: AbortSignal): Promise<LoopOnboardingReview> {
    const review = await this.options.onboarding.create(input, signal)
    this.notify(review.loop.id)
    this.schedule(review.loop.id, 0)
    return review
  }

  private clearTimer(loopId: string): void {
    const timer = this.timers.get(loopId)
    if (timer) clearTimeout(timer)
    this.timers.delete(loopId)
  }

  private schedule(loopId: string, delayMs?: number): void {
    if (this.disposed || this.controllers.has(loopId)) return
    this.clearTimer(loopId)
    const loop = this.options.store.getLoop(loopId)
    if (!loop || loop.status !== 'running') return
    const delay = Math.max(0, Math.min(
      delayMs ?? Math.max(0, (loop.nextCycleAt ?? this.now()) - this.now()),
      MAX_TIMER_MS
    ))
    const timer = setTimeout(() => {
      this.timers.delete(loopId)
      void this.run(loopId)
    }, delay)
    timer.unref?.()
    this.timers.set(loopId, timer)
  }

  private async run(loopId: string): Promise<void> {
    if (this.disposed || this.controllers.has(loopId)) return
    const controller = new AbortController()
    this.controllers.set(loopId, controller)
    try {
      await this.options.engine.runCycle(loopId, controller.signal)
    } catch (error) {
      this.options.store.setLoopState(loopId, {
        status: 'error', stage: 'idle', activeCycleId: null, nextCycleAt: null,
        error: error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000)
      })
    } finally {
      this.controllers.delete(loopId)
      this.notify(loopId)
      const loop = this.options.store.getLoop(loopId)
      if (loop?.status === 'running') this.schedule(loopId)
    }
  }

  async pause(loopId: string): Promise<AutonomousLoopRecord> {
    const loop = this.options.store.getLoop(loopId)
    if (!loop) throw new Error('Loop not found.')
    if (loop.status !== 'running' && loop.status !== 'setting_up') return loop
    const updated = this.options.store.setLoopState(loopId, {
      status: 'pausing', nextCycleAt: null, stopReason: null
    })!
    this.clearTimer(loopId)
    const controller = this.controllers.get(loopId)
    if (controller) controller.abort(new Error('Loop pause requested.'))
    else this.options.store.setLoopState(loopId, {
      status: 'paused', stage: 'idle', activeCycleId: null, pausedAt: this.now(), nextCycleAt: null
    })
    this.notify(loopId)
    return this.options.store.getLoop(loopId) ?? updated
  }

  async resume(loopId: string): Promise<AutonomousLoopRecord> {
    const loop = this.options.store.getLoop(loopId)
    if (!loop) throw new Error('Loop not found.')
    if (loop.status !== 'paused') throw new Error('Only a paused Loop can be resumed.')
    const now = this.now()
    const updated = this.options.store.setLoopState(loopId, {
      status: 'running', stage: 'scheduling', pausedAt: null, nextCycleAt: now,
      lastActivityAt: now, stopReason: null, error: null
    })!
    this.notify(loopId)
    this.schedule(loopId, 0)
    return updated
  }

  async stop(loopId: string): Promise<AutonomousLoopRecord> {
    const loop = this.options.store.getLoop(loopId)
    if (!loop) throw new Error('Loop not found.')
    if (loop.status === 'stopped' || loop.status === 'completed') return loop
    const updated = this.options.store.setLoopState(loopId, {
      status: 'stopping', nextCycleAt: null, stopReason: 'Stopped by user.'
    })!
    this.clearTimer(loopId)
    const controller = this.controllers.get(loopId)
    if (controller) controller.abort(new Error('Loop stop requested.'))
    else this.options.store.setLoopState(loopId, {
      status: 'stopped', stage: 'idle', activeCycleId: null,
      stoppedAt: this.now(), nextCycleAt: null, stopReason: 'Stopped by user.'
    })
    this.notify(loopId)
    return this.options.store.getLoop(loopId) ?? updated
  }

  private async recoverInterrupted(loop: AutonomousLoopRecord): Promise<void> {
    if (!loop.activeCycleId) return
    const cycle = this.options.store.getCycle(loop.activeCycleId)
    const snapshot = this.options.store.latestSnapshot(loop.id)
    if (cycle && cycle.commitSha === null && cycle.changedFiles.length > 0) {
      if (!snapshot?.headSha || cycle.changedFiles.length > 256) {
        throw new Error('Interrupted Loop changes require manual repository recovery.')
      }
      await this.options.repository.restore(loop.workspacePath, {
        repositoryPath: loop.workspacePath,
        headSha: snapshot.headSha,
        branch: snapshot.branch,
        createdAt: snapshot.capturedAt
      }, cycle.changedFiles)
    }
    if (cycle && cycle.status !== 'pushed' && cycle.status !== 'committed') {
      const finishedAt = this.now()
      this.options.store.updateCycle({
        ...cycle,
        status: 'cancelled',
        finishedAt,
        durationMs: cycle.startedAt === null ? null : finishedAt - cycle.startedAt,
        error: 'Recovered after application restart at a safe repository checkpoint.'
      })
    }
    this.options.store.setLoopState(loop.id, {
      stage: 'scheduling', activeCycleId: null, nextCycleAt: this.now(), error: null
    })
  }

  async start(): Promise<void> {
    this.disposed = false
    for (const loop of this.options.store.listLoops(1_000)) {
      if (loop.status === 'pausing') {
        this.options.store.setLoopState(loop.id, {
          status: 'paused', stage: 'idle', activeCycleId: null, pausedAt: this.now(), nextCycleAt: null
        })
        continue
      }
      if (loop.status === 'stopping') {
        this.options.store.setLoopState(loop.id, {
          status: 'stopped', stage: 'idle', activeCycleId: null, stoppedAt: this.now(), nextCycleAt: null
        })
        continue
      }
      if (loop.status !== 'running') continue
      try {
        await this.recoverInterrupted(loop)
        this.schedule(loop.id)
      } catch (error) {
        this.options.store.setLoopState(loop.id, {
          status: 'error', stage: 'idle', activeCycleId: null, nextCycleAt: null,
          stopReason: 'Repository recovery failed.',
          error: error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000)
        })
      }
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const controller of this.controllers.values()) controller.abort(new Error('Application shutting down.'))
    this.controllers.clear()
    this.listeners.clear()
  }
}

