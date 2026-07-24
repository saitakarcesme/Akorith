import { basename } from 'path'
import { RESEARCH_DEPTH_PROFILES, type ResearchArtifact, type ResearchJob } from './types'

/** Discord's documented default per-file upload limit. A boosted server may
 * allow more, but a webhook has no preflight endpoint that reports that limit. */
export const DISCORD_DEFAULT_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024
export const DISCORD_DELIVERY_TIMEOUT_MS = 30_000

const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'ptb.discord.com',
  'canary.discord.com',
  'discordapp.com'
])

export interface DiscordWebhookTarget {
  /** Normalized secret execution URL. Main-process only. */
  endpoint: string
  webhookId: string
  threadId?: string
}

export interface DiscordResearchStats {
  sourceCount: number
  claimCount: number
  verifiedClaimCount: number
  conflictedClaimCount: number
}

export interface DiscordWebhookPayload {
  content: string
  username: string
  allowed_mentions: { parse: never[]; users: never[]; roles: never[]; replied_user: false }
  embeds: Array<{
    title: string
    description: string
    color: number
    fields: Array<{ name: string; value: string; inline: boolean }>
    footer: { text: string }
    timestamp: string
  }>
  attachments: Array<{ id: number; filename: string; description: string }>
}

export type DiscordHttpDisposition =
  | { kind: 'delivered' }
  | { kind: 'retry'; delayMs: number; reason: string }
  | { kind: 'failed'; reason: string }

/** Accept only Discord-owned HTTPS webhook endpoints. Unknown query
 * parameters are rejected instead of being reflected into an authenticated
 * request. `thread_id` is retained for forum-thread webhooks; `wait=true` is
 * always set by Akorith so a local receipt contains Discord's message id. */
export function parseDiscordWebhookUrl(input: unknown): DiscordWebhookTarget {
  if (typeof input !== 'string' || input.length > 2_048 || /[\0\r\n]/.test(input)) {
    throw new Error('Enter a valid Discord webhook URL.')
  }
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('Enter a valid Discord webhook URL.')
  }
  const hostname = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !DISCORD_WEBHOOK_HOSTS.has(hostname)
  ) {
    throw new Error('Only an HTTPS Discord webhook URL can be used.')
  }
  const match = url.pathname.match(/^\/api(?:\/v(?:9|10))?\/webhooks\/([0-9]{5,30})\/([A-Za-z0-9._-]{20,256})\/?$/)
  if (!match) throw new Error('The Discord webhook URL has an invalid path.')

  const unknownParams = [...url.searchParams.keys()].filter((key) => key !== 'thread_id' && key !== 'wait')
  if (unknownParams.length > 0) throw new Error('The Discord webhook URL contains unsupported parameters.')
  const threadId = url.searchParams.get('thread_id')?.trim()
  if (threadId && !/^[0-9]{5,30}$/.test(threadId)) {
    throw new Error('The Discord webhook thread id is invalid.')
  }

  url.hash = ''
  url.search = ''
  if (threadId) url.searchParams.set('thread_id', threadId)
  url.searchParams.set('wait', 'true')
  return { endpoint: url.toString(), webhookId: match[1], ...(threadId ? { threadId } : {}) }
}

export function buildDiscordResearchPayload(input: {
  deliveryId: string
  job: ResearchJob
  artifact: ResearchArtifact
  stats: DiscordResearchStats
}): DiscordWebhookPayload {
  const { deliveryId, job, artifact, stats } = input
  const filename = safeDiscordFilename(artifact.path, artifact.format)
  const duration = Math.max(
    0,
    job.activeElapsedMs || ((job.completedAt ?? artifact.createdAt) - (job.startedAt ?? job.createdAt))
  )
  const summary = clampDiscordText(
    job.summary || 'Akorith completed this research and validated the attached deliverable.',
    1_600
  )
  const depth = RESEARCH_DEPTH_PROFILES[job.depth]?.label ?? job.depth
  const pageLabel = artifact.pageCount && artifact.pageCount > 0 ? String(artifact.pageCount) : 'Not reported'
  const claimLabel = stats.claimCount > 0
    ? `${stats.claimCount} total · ${stats.verifiedClaimCount} verified${stats.conflictedClaimCount ? ` · ${stats.conflictedClaimCount} conflicted` : ''}`
    : 'No structured claims recorded'

  return {
    content: 'Akorith research delivery',
    username: 'Akorith Research',
    // User-controlled titles/summaries must never ping @everyone, roles, or users.
    allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    embeds: [{
      title: clampDiscordText(job.title || artifact.title || 'Completed research', 256),
      description: summary,
      color: 0x37a66b,
      fields: [
        { name: 'Depth', value: clampDiscordText(depth, 1_024), inline: true },
        { name: 'Duration', value: formatDuration(duration), inline: true },
        { name: 'Output', value: `${artifact.format.toUpperCase()} · ${formatBytes(artifact.byteSize)} · v${artifact.version}`, inline: true },
        { name: 'Pages / slides', value: pageLabel, inline: true },
        { name: 'Sources', value: String(stats.sourceCount), inline: true },
        { name: 'Claims', value: clampDiscordText(claimLabel, 1_024), inline: false },
        { name: 'Provider', value: clampDiscordText(`${job.providerId}${job.model ? ` · ${job.model}` : ''}`, 1_024), inline: false }
      ],
      footer: { text: `Akorith · delivery ${clampDiscordText(deliveryId, 120)}` },
      timestamp: new Date(job.completedAt ?? artifact.createdAt).toISOString()
    }],
    attachments: [{
      id: 0,
      filename,
      description: clampDiscordText(`${job.title} — validated Akorith research output`, 1_024)
    }]
  }
}

export function classifyDiscordHttpResponse(input: {
  status: number
  retryAfterHeader?: string | null
  rateLimitResetAfterHeader?: string | null
  responseBody?: unknown
}): DiscordHttpDisposition {
  const { status } = input
  if (status >= 200 && status < 300) return { kind: 'delivered' }
  if (status === 429) {
    return {
      kind: 'retry',
      delayMs: discordRetryDelayMs(input),
      reason: 'Discord rate-limited this delivery.'
    }
  }
  if (status === 408 || status >= 500) {
    return {
      kind: 'retry',
      delayMs: 0,
      reason: `Discord temporarily rejected the delivery (HTTP ${status}).`
    }
  }
  if (status === 401 || status === 403 || status === 404) {
    return { kind: 'failed', reason: 'The Discord webhook is unavailable or no longer authorized.' }
  }
  return { kind: 'failed', reason: `Discord rejected the delivery (HTTP ${status}).` }
}

export function discordRetryDelayMs(input: {
  retryAfterHeader?: string | null
  rateLimitResetAfterHeader?: string | null
  responseBody?: unknown
}): number {
  const body = isRecord(input.responseBody) ? Number(input.responseBody.retry_after) : Number.NaN
  const retryAfter = parseRetrySeconds(input.retryAfterHeader)
  const resetAfter = parseRetrySeconds(input.rateLimitResetAfterHeader)
  const seconds = [body, retryAfter, resetAfter].find((value) => Number.isFinite(value) && value >= 0)
  return Math.min(Math.max(Math.ceil((seconds ?? 1) * 1_000), 1_000), 15 * 60_000)
}

/** Remove tokens and control characters before an error reaches SQLite/UI. */
export function safeDiscordError(input: unknown, max = 600): string {
  const text = input instanceof Error ? input.message : String(input)
  return clampDiscordText(
    text
      .replace(/https:\/\/(?:ptb\.|canary\.)?(?:discord(?:app)?\.com)\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9._-]+/gi, '[redacted Discord webhook]')
      .replace(/(["']?(?:token|webhookUrl|webhook_url)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
      .replace(/[\0\r\n\t]+/g, ' '),
    max
  )
}

function safeDiscordFilename(path: string, format: string): string {
  const fallback = `akorith-research.${format}`
  const raw = basename(path || fallback).replace(/[\0\r\n"\\/]/g, '_').trim()
  return clampDiscordText(raw || fallback, 180)
}

function clampDiscordText(value: string, max: number): string {
  const clean = value.replace(/\0/g, '').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / (1024 ** index)
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.round(milliseconds / 60_000))
  if (totalMinutes < 60) return `${totalMinutes} min`
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (minutes || parts.length === 0) parts.push(`${minutes}m`)
  return parts.join(' ')
}

function parseRetrySeconds(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1_000) : Number.NaN
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
