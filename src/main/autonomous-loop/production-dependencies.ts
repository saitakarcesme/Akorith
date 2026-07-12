import {
  commitExplicitPaths,
  createRepositoryCheckpoint,
  pushNonForce,
  restoreExplicitPathsToCheckpoint,
  type RepositoryService
} from '../repository'
import { sendMetaPrompt } from '../providers/registry'
import type { SendResult } from '../providers/types'
import { estimateTokens } from '../providers/util'
import type { AutonomousExecutorRouter } from './executor'
import { buildFeatureInventory } from './inventory'
import { observeRepository } from './observer'
import { buildLoopPlannerPrompt, deterministicPlannerFallback, isRepeatedPlannerTask } from './planner'
import { buildLoopReviewerPrompt, deterministicLoopReview, inspectLoopDiff, mergeLoopReviews } from './reviewer'
import { parseLoopPlannedTask, parseLoopReview } from './validation'
import { runLoopValidation } from './validator'
import type { AutonomousLoopEngineDependencies, LoopModelDecision } from './engine-types'
import type { LoopPlannedTask, LoopReviewResult, LoopTokenUsage } from './types'

const REPOSITORY_LEASE_TTL_MS = 15 * 60_000

function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('cancelled')
}

function usage(result: SendResult, prompt: string): LoopTokenUsage {
  return {
    input: result.usage.promptTokens ?? estimateTokens(prompt),
    output: result.usage.completionTokens ?? estimateTokens(result.text),
    cached: 0,
    costUsd: result.usage.costUsd ?? 0
  }
}

export interface ProductionLoopDependenciesOptions {
  repository: RepositoryService
  executor: AutonomousExecutorRouter
  now?: () => number
  delayMs?: number
}

export function createProductionLoopDependencies(
  options: ProductionLoopDependenciesOptions
): AutonomousLoopEngineDependencies {
  const now = options.now ?? Date.now
  return {
    async acquireRepository(loop) {
      const prepared = await options.repository.prepare()
      const lease = await options.repository.leases.acquire(loop.workspacePath, {
        owner: `autonomous-loop:${loop.id}`,
        ttlMs: REPOSITORY_LEASE_TTL_MS
      })
      return {
        checkpoint: () => createRepositoryCheckpoint(options.repository.runner, loop.workspacePath),
        restore: (checkpoint, paths) => restoreExplicitPathsToCheckpoint(
          options.repository.runner, loop.workspacePath, checkpoint, paths
        ),
        async commit(paths, message) {
          const result = await commitExplicitPaths(
            options.repository.runner,
            loop.workspacePath,
            paths,
            message,
            { hooksPath: prepared.hooksPath }
          )
          if (!result.sha) throw new Error('Git commit completed without a revision identifier.')
          return { sha: result.sha, paths: result.paths }
        },
        async push(branch) {
          await pushNonForce(options.repository.runner, loop.workspacePath, branch, {
            remoteName: 'origin', setUpstream: true, hooksPath: prepared.hooksPath
          })
        },
        async heartbeat() { await lease.refresh(REPOSITORY_LEASE_TTL_MS) },
        async release() { await lease.release() }
      }
    },
    async observe(loop, signal) {
      ensureActive(signal)
      const value = await observeRepository(loop.workspacePath, { repositoryId: loop.repositoryId, now: now() })
      ensureActive(signal)
      return value
    },
    buildInventory: (snapshot) => buildFeatureInventory(snapshot, now()),
    async plan(input): Promise<LoopModelDecision<LoopPlannedTask>> {
      const prompt = buildLoopPlannerPrompt({
        snapshot: input.snapshot,
        inventory: input.inventory,
        priorCycles: input.priorCycles
      })
      const startedAt = now()
      try {
        const result = await sendMetaPrompt(
          input.loop.planner.providerId,
          input.loop.planner.model,
          prompt,
          input.signal
        )
        const parsed = parseLoopPlannedTask(result.text)
        if (parsed.ok && !isRepeatedPlannerTask(parsed.value, input.priorCycles)) {
          return {
            value: parsed.value,
            usage: usage(result, prompt),
            estimated: result.usage.estimated,
            durationMs: Math.max(0, now() - startedAt),
            rawSummary: parsed.value.reason
          }
        }
        const fallback = deterministicPlannerFallback(input.snapshot, input.inventory)
        return {
          value: fallback,
          usage: usage(result, prompt),
          estimated: result.usage.estimated,
          durationMs: Math.max(0, now() - startedAt),
          rawSummary: parsed.ok ? 'Planner repeated a recent task; deterministic inventory fallback selected.' : parsed.error
        }
      } catch (error) {
        ensureActive(input.signal)
        const fallback = deterministicPlannerFallback(input.snapshot, input.inventory)
        return {
          value: fallback,
          usage: { input: 0, output: 0, cached: 0, costUsd: 0 },
          estimated: false,
          durationMs: Math.max(0, now() - startedAt),
          rawSummary: `Reasoning planner unavailable; deterministic fallback selected: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    },
    execute: (request) => options.executor.execute(request),
    validate: ({ loop, snapshot, task, signal }) => runLoopValidation({
      root: loop.workspacePath,
      detectedCommands: snapshot.detectedCommands,
      plannedCommands: task.validationCommands,
      timeoutMs: loop.limits.validationTimeoutMs,
      signal
    }),
    async review(input): Promise<LoopModelDecision<LoopReviewResult>> {
      ensureActive(input.signal)
      const diff = await inspectLoopDiff(input.loop.workspacePath)
      const deterministic = deterministicLoopReview({
        task: input.task,
        validation: input.validation,
        diff
      })
      if (!deterministic.accepted) {
        return {
          value: deterministic,
          usage: { input: 0, output: 0, cached: 0, costUsd: 0 },
          estimated: false,
          durationMs: 0,
          rawSummary: deterministic.rationale
        }
      }
      const prompt = buildLoopReviewerPrompt({
        task: input.task,
        validation: input.validation,
        deterministic,
        diff
      })
      const startedAt = now()
      try {
        const result = await sendMetaPrompt(
          input.loop.planner.providerId,
          input.loop.planner.model,
          prompt,
          input.signal
        )
        const parsed = parseLoopReview(result.text)
        const merged = mergeLoopReviews(deterministic, parsed.ok ? parsed.value : null)
        return {
          value: merged,
          usage: usage(result, prompt),
          estimated: result.usage.estimated,
          durationMs: Math.max(0, now() - startedAt),
          rawSummary: parsed.ok ? merged.rationale : `Deterministic review retained: ${parsed.error}`
        }
      } catch {
        ensureActive(input.signal)
        return {
          value: deterministic,
          usage: { input: 0, output: 0, cached: 0, costUsd: 0 },
          estimated: false,
          durationMs: Math.max(0, now() - startedAt),
          rawSummary: deterministic.rationale
        }
      }
    },
    delayMs: Math.max(1_000, Math.min(options.delayMs ?? 5_000, 60 * 60_000)),
    now
  }
}

