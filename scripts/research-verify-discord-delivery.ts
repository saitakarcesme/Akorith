import assert from 'node:assert/strict'
import {
  buildDiscordResearchPayload,
  classifyDiscordHttpResponse,
  DISCORD_DEFAULT_ATTACHMENT_LIMIT_BYTES,
  discordRetryDelayMs,
  parseDiscordWebhookUrl,
  safeDiscordError
} from '../src/main/research/discord-delivery-core'
import type { ResearchArtifact, ResearchJob } from '../src/main/research/types'

const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'

const target = parseDiscordWebhookUrl(`https://discord.com/api/webhooks/123456789012345678/${token}`)
assert.equal(target.webhookId, '123456789012345678')
assert.equal(target.endpoint.endsWith('?wait=true'), true)
assert.equal(target.endpoint.includes(token), true)

const threadTarget = parseDiscordWebhookUrl(
  `https://canary.discord.com/api/v10/webhooks/123456789012345678/${token}?thread_id=987654321012345678&wait=false`
)
assert.equal(threadTarget.threadId, '987654321012345678')
assert.equal(threadTarget.endpoint.includes('thread_id=987654321012345678'), true)
assert.equal(threadTarget.endpoint.includes('wait=true'), true)

for (const invalid of [
  `http://discord.com/api/webhooks/123456789012345678/${token}`,
  `https://discord.com.evil.example/api/webhooks/123456789012345678/${token}`,
  `https://user:password@discord.com/api/webhooks/123456789012345678/${token}`,
  `https://discord.com/api/webhooks/123456789012345678/${token}/messages`,
  `https://discord.com/api/webhooks/123456789012345678/${token}?redirect=https://example.com`,
  'not a url'
]) {
  assert.throws(() => parseDiscordWebhookUrl(invalid), /Discord webhook|HTTPS Discord/)
}

assert.deepEqual(classifyDiscordHttpResponse({ status: 204 }), { kind: 'delivered' })
assert.equal(classifyDiscordHttpResponse({ status: 429, responseBody: { retry_after: 2.5 } }).kind, 'retry')
assert.equal(discordRetryDelayMs({ responseBody: { retry_after: 2.5 } }), 2_500)
assert.equal(classifyDiscordHttpResponse({ status: 503 }).kind, 'retry')
assert.equal(classifyDiscordHttpResponse({ status: 404 }).kind, 'failed')
assert.equal(classifyDiscordHttpResponse({ status: 400 }).kind, 'failed')

const job: ResearchJob = {
  id: 'research-discord-job',
  title: '@everyone Research result',
  prompt: 'Research a bounded topic.',
  status: 'completed',
  phase: 'export',
  providerId: 'local',
  model: 'qwen-test',
  depth: 'quick',
  outputFormat: 'pdf',
  targetDurationMs: 600_000,
  maxCycles: 4,
  sourceTarget: 8,
  cycleCount: 4,
  sourceCount: 8,
  findingCount: 6,
  workspaceDir: '/managed/research',
  artifactPath: '/managed/research/report.pdf',
  summary: '@everyone The evidence-backed summary remains bounded.',
  createdAt: 1_000,
  updatedAt: 601_000,
  startedAt: 1_000,
  activeElapsedMs: 600_000,
  completedAt: 601_000,
  revision: 3
}
const artifact: ResearchArtifact = {
  id: 'artifact-discord',
  jobId: job.id,
  format: 'pdf',
  title: job.title,
  path: '/managed/research/report.pdf',
  byteSize: 512_000,
  status: 'ready',
  checksum: 'a'.repeat(64),
  mimeType: 'application/pdf',
  version: 2,
  pageCount: 14,
  createdAt: 601_000
}
const payload = buildDiscordResearchPayload({
  deliveryId: 'delivery-public-id',
  job,
  artifact,
  stats: { sourceCount: 8, claimCount: 7, verifiedClaimCount: 6, conflictedClaimCount: 1 }
})
assert.deepEqual(payload.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false })
assert.equal(payload.embeds[0].fields.some((field) => field.name === 'Pages / slides' && field.value === '14'), true)
assert.equal(payload.embeds[0].fields.some((field) => field.name === 'Sources' && field.value === '8'), true)
assert.equal(payload.attachments[0].filename, 'report.pdf')
assert.equal(payload.embeds[0].footer.text.includes('delivery-public-id'), true)
assert.equal(DISCORD_DEFAULT_ATTACHMENT_LIMIT_BYTES, 10 * 1024 * 1024)

const leaked = `POST https://discord.com/api/webhooks/123456789012345678/${token} failed token=${token}`
const redacted = safeDiscordError(leaked)
assert.equal(redacted.includes(token), false)
assert.equal(redacted.includes('[redacted Discord webhook]'), true)

console.log('research Discord delivery verifier passed (URL allowlist, payload limits, mentions, retry policy, redaction)')
