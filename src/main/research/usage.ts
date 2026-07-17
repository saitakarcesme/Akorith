import { recordUsageEvent } from '../db'
import type { SendResult } from '../providers/types'
import type { ResearchJob } from './types'

type ResearchUsageKind = 'research-plan' | 'research-cycle' | 'research-synthesis'

/** Count the user's Research submission once, independently of autonomous turns. */
export function recordResearchRequest(job: ResearchJob): boolean {
  try {
    return recordUsageEvent({
      providerId: job.providerId,
      model: job.model,
      totalTokens: 0,
      estimated: false,
      requestCount: 1,
      sourceKind: 'research-request',
      sourceId: job.id,
      timestamp: job.createdAt
    })
  } catch (error) {
    console.error('[research] failed to record user request usage:', error)
    return false
  }
}

/** Persist one provider response once; retries cannot double-count one logical turn. */
export function recordResearchModelUsage(input: {
  job: ResearchJob
  kind: ResearchUsageKind
  turnId: string
  model?: string
  usage: SendResult['usage']
  timestamp?: number
}): boolean {
  try {
    return recordUsageEvent({
      providerId: input.job.providerId,
      model: input.model ?? input.job.model,
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      cacheReadTokens: input.usage.cacheReadTokens,
      cacheWriteTokens: input.usage.cacheWriteTokens,
      reasoningTokens: input.usage.reasoningTokens,
      totalTokens: input.usage.totalTokens,
      costUsd: input.usage.costUsd,
      estimated: input.usage.estimated,
      requestCount: 0,
      sourceKind: input.kind,
      sourceId: input.turnId,
      timestamp: input.timestamp
    })
  } catch (error) {
    console.error(`[research] failed to record ${input.kind} usage:`, error)
    return false
  }
}
