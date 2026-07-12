import type { AutonomousLoopRecord, LoopPlannedTask } from './types'

const COMMIT_TYPE: Readonly<Record<LoopPlannedTask['kind'], string>> = Object.freeze({
  code: 'feat',
  test: 'test',
  documentation: 'docs',
  refactor: 'refactor',
  bug_fix: 'fix',
  infrastructure: 'chore'
})

export function loopCommitMessage(task: LoopPlannedTask): string {
  const title = task.title
    .replace(/^(?:feat|fix|test|docs|refactor|chore|build|ci)(?:\([^)]*\))?!?:\s*/i, '')
    .replace(/[\0\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return `${COMMIT_TYPE[task.kind]}(loop): ${title || 'apply autonomous project improvement'}`
}

export function loopSafetyLimitReason(loop: AutonomousLoopRecord): string | null {
  if (loop.limits.tokenLimit !== null) {
    const tokens = loop.tokenUsage.input + loop.tokenUsage.output + loop.tokenUsage.cached
    if (tokens >= loop.limits.tokenLimit) return 'Configured Loop token limit reached.'
  }
  if (loop.limits.costLimitUsd !== null && loop.tokenUsage.costUsd >= loop.limits.costLimitUsd) {
    return 'Configured Loop cost limit reached.'
  }
  return null
}

export function shouldHardStopInfrastructure(loop: AutonomousLoopRecord, nextFailureCount: number): boolean {
  return nextFailureCount >= loop.limits.maxConsecutiveInfrastructureFailures
}

export function isPermanentRepositoryFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  return [
    'authentication-required', 'authentication-failed', 'repository-not-found',
    'permission-denied', 'repository-corrupt', 'remote-mismatch'
  ].includes(code)
}

