import { createHash } from 'crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'fs'
import { safeStorage } from 'electron'
import {
  getResearchDiscordConfig,
  setResearchDiscordConfig
} from '../config'
import {
  buildDiscordResearchPayload,
  classifyDiscordHttpResponse,
  DISCORD_DEFAULT_ATTACHMENT_LIMIT_BYTES,
  DISCORD_DELIVERY_TIMEOUT_MS,
  parseDiscordWebhookUrl,
  safeDiscordError,
  type DiscordWebhookTarget
} from './discord-delivery-core'
import {
  claimResearchDiscordDelivery,
  enqueueResearchDiscordDelivery,
  getResearchArtifact,
  getResearchDiscordDeliveryByArtifact,
  getResearchJob,
  listDueResearchDiscordDeliveries,
  listResearchClaims,
  listResearchDiscordDeliveries,
  listResearchSources,
  logResearchEvent,
  markResearchDiscordDeliveryDelivered,
  markResearchDiscordDeliveryFailed,
  markResearchDiscordDeliveryNeedsReview,
  markResearchDiscordDeliveryRetry,
  recoverInterruptedResearchDiscordDeliveries,
  researchDiscordDeliveryCounts,
  retryResearchDiscordDelivery,
  type ResearchDiscordDelivery
} from './store'
import { isManagedResearchPath } from './workspace'

const CIPHERTEXT_PREFIX = 'safe-storage:v1:'
const WORKER_INTERVAL_MS = 30_000
const MAX_AUTOMATIC_ATTEMPTS = 6
const MAX_DISCORD_RESPONSE_BYTES = 64_000
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000]

export interface ResearchDiscordPublicSettings {
  enabled: boolean
  configured: boolean
  secureStorageAvailable: boolean
  destinationLabel: string
  maxAttachmentBytes: number
  workerStarted: boolean
  counts: {
    pending: number
    delivered: number
    failed: number
    needsReview: number
  }
}

export interface ResearchDiscordSettingsPatch {
  enabled?: boolean
  /** Write-only. `undefined` preserves the current secret; an empty string or
   * null removes it. It is never included in a response. */
  webhookUrl?: string | null
}

export interface ResearchDiscordTestResult {
  ok: boolean
  messageId?: string
  error?: string
}

let workerStarted = false
let workerTimer: NodeJS.Timeout | null = null
let workerQueued = false
let workerPromise: Promise<void> | null = null
let activeRequestController: AbortController | null = null

export function getResearchDiscordPublicSettings(): ResearchDiscordPublicSettings {
  const config = getResearchDiscordConfig()
  return {
    enabled: config.enabled,
    configured: Boolean(config.webhookUrlCiphertext),
    secureStorageAvailable: safeStorage.isEncryptionAvailable(),
    destinationLabel: config.destinationLabel,
    maxAttachmentBytes: DISCORD_DEFAULT_ATTACHMENT_LIMIT_BYTES,
    workerStarted,
    counts: researchDiscordDeliveryCounts()
  }
}

export function updateResearchDiscordSettings(
  patch: ResearchDiscordSettingsPatch
): ResearchDiscordPublicSettings {
  const current = getResearchDiscordConfig()
  let ciphertext: string | null | undefined
  if (patch.webhookUrl !== undefined) {
    const raw = patch.webhookUrl?.trim() ?? ''
    if (!raw) {
      ciphertext = null
    } else {
      const target = parseDiscordWebhookUrl(raw)
      ciphertext = encryptWebhookUrl(target.endpoint)
    }
  }
  const willHaveCredential = ciphertext === undefined
    ? Boolean(current.webhookUrlCiphertext)
    : Boolean(ciphertext)
  const enabled = typeof patch.enabled === 'boolean'
    ? patch.enabled
    : ciphertext === null
      ? false
      : current.enabled
  if (enabled && !willHaveCredential) {
    throw new Error('Add the # research Discord webhook before enabling automatic delivery.')
  }
  setResearchDiscordConfig({
    enabled: willHaveCredential ? enabled : false,
    ...(ciphertext !== undefined ? { webhookUrlCiphertext: ciphertext } : {})
  })
  kickResearchDiscordDeliveryWorker()
  return getResearchDiscordPublicSettings()
}

/** Called only after a final, validated artifact has completed. Configuration
 * failures are logged as Research warnings and never roll back the report. */
export function enqueueCompletedResearchDiscordDelivery(
  jobId: string,
  artifactId: string
): ResearchDiscordDelivery | null {
  const config = getResearchDiscordConfig()
  if (!config.enabled || !config.webhookUrlCiphertext) return null
  try {
    // Fail closed before creating an outbox row if the OS keychain cannot read
    // the credential. This keeps a completed Research job successful.
    requireDiscordTarget()
    const existing = getResearchDiscordDeliveryByArtifact(artifactId)
    const delivery = existing ?? enqueueResearchDiscordDelivery(jobId, artifactId)
    if (!existing) {
      logResearchEvent({
        jobId,
        kind: 'note',
        title: `Queued for ${config.destinationLabel}`,
        detail: `Discord delivery ${delivery.id}`
      })
    }
    kickResearchDiscordDeliveryWorker()
    return delivery
  } catch (error) {
    logResearchEvent({
      jobId,
      kind: 'warning',
      title: 'Discord delivery is not configured correctly',
      detail: safeDiscordError(error)
    })
    return null
  }
}

export function researchDiscordDeliveriesForJob(jobId: string): ResearchDiscordDelivery[] {
  return listResearchDiscordDeliveries(jobId)
}

export function retryManagedResearchDiscordDelivery(id: string): ResearchDiscordDelivery {
  const retried = retryResearchDiscordDelivery(id)
  if (!retried) throw new Error('Discord delivery is unavailable or already delivered.')
  logResearchEvent({
    jobId: retried.jobId,
    kind: 'note',
    title: 'Discord delivery queued again after review',
    detail: `Discord delivery ${retried.id}`
  })
  kickResearchDiscordDeliveryWorker()
  return retried
}

export async function testResearchDiscordDelivery(): Promise<ResearchDiscordTestResult> {
  let target: DiscordWebhookTarget
  try {
    target = requireDiscordTarget()
  } catch (error) {
    return { ok: false, error: safeDiscordError(error) }
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Discord test timed out.')), DISCORD_DELIVERY_TIMEOUT_MS)
  try {
    const response = await fetch(target.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Akorith connected successfully to **AI Workspace / # 🔬 research**.',
        username: 'Akorith Research',
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false }
      }),
      signal: controller.signal
    })
    const body = await readDiscordResponse(response)
    const disposition = classifyDiscordHttpResponse({
      status: response.status,
      retryAfterHeader: response.headers.get('retry-after'),
      rateLimitResetAfterHeader: response.headers.get('x-ratelimit-reset-after'),
      responseBody: body
    })
    if (disposition.kind !== 'delivered') return { ok: false, error: disposition.reason }
    return { ok: true, ...(messageIdFromBody(body) ? { messageId: messageIdFromBody(body) } : {}) }
  } catch (error) {
    return { ok: false, error: safeDiscordError(error) }
  } finally {
    clearTimeout(timeout)
  }
}

export function startResearchDiscordDeliveryWorker(): void {
  if (workerStarted) return
  recoverInterruptedResearchDiscordDeliveries()
  workerStarted = true
  workerTimer = setInterval(kickResearchDiscordDeliveryWorker, WORKER_INTERVAL_MS)
  workerTimer.unref()
  kickResearchDiscordDeliveryWorker()
}

export async function shutdownResearchDiscordDeliveryWorker(): Promise<void> {
  workerStarted = false
  workerQueued = false
  if (workerTimer) clearInterval(workerTimer)
  workerTimer = null
  activeRequestController?.abort(new Error('Akorith is closing during Discord delivery.'))
  const pending = workerPromise
  if (pending) await pending.catch(() => undefined)
}

export function kickResearchDiscordDeliveryWorker(): void {
  if (!workerStarted || workerQueued || workerPromise) return
  workerQueued = true
  queueMicrotask(() => {
    workerQueued = false
    if (!workerStarted || workerPromise) return
    workerPromise = drainResearchDiscordDeliveries()
      .catch(() => undefined)
      .finally(() => {
        workerPromise = null
        if (workerStarted && listDueResearchDiscordDeliveries(Date.now(), 1).length > 0) {
          kickResearchDiscordDeliveryWorker()
        }
      })
  })
}

async function drainResearchDiscordDeliveries(): Promise<void> {
  const config = getResearchDiscordConfig()
  if (!config.enabled || !config.webhookUrlCiphertext) return
  // Decrypt once before claiming. If secure storage is unavailable, keep the
  // rows pending so correcting Settings does not consume an attempt.
  requireDiscordTarget()
  for (const candidate of listDueResearchDiscordDeliveries(Date.now(), 10)) {
    if (!workerStarted) return
    const delivery = claimResearchDiscordDelivery(candidate.id)
    if (!delivery) continue
    await deliverClaimedResearchArtifact(delivery)
  }
}

async function deliverClaimedResearchArtifact(delivery: ResearchDiscordDelivery): Promise<void> {
  const job = getResearchJob(delivery.jobId)
  const artifact = getResearchArtifact(delivery.artifactId)
  if (!job || !artifact || artifact.jobId !== job.id || artifact.status !== 'ready') {
    recordPermanentFailure(delivery, 'The validated Research artifact is no longer available.')
    return
  }

  let file: Buffer
  try {
    file = readValidatedManagedArtifact(job.workspaceDir, artifact.path, artifact.byteSize, artifact.checksum)
  } catch (error) {
    recordPermanentFailure(delivery, safeDiscordError(error))
    return
  }
  if (file.byteLength > DISCORD_DEFAULT_ATTACHMENT_LIMIT_BYTES) {
    recordPermanentFailure(
      delivery,
      `The artifact is ${file.byteLength} bytes; Discord's default attachment limit is ${DISCORD_DEFAULT_ATTACHMENT_LIMIT_BYTES} bytes.`
    )
    return
  }

  const claims = listResearchClaims(job.id)
  const sources = listResearchSources(job.id)
  const payload = buildDiscordResearchPayload({
    deliveryId: delivery.id,
    job,
    artifact,
    stats: {
      sourceCount: sources.length,
      claimCount: claims.length,
      verifiedClaimCount: claims.filter((claim) => claim.status === 'verified').length,
      conflictedClaimCount: claims.filter((claim) => claim.status === 'conflicted').length
    }
  })
  const form = new FormData()
  form.append('payload_json', JSON.stringify(payload))
  form.append(
    'files[0]',
    new Blob([new Uint8Array(file)], { type: artifact.mimeType || 'application/octet-stream' }),
    payload.attachments[0].filename
  )

  let target: DiscordWebhookTarget
  try {
    target = requireDiscordTarget()
  } catch (error) {
    recordPermanentFailure(delivery, safeDiscordError(error))
    return
  }
  const controller = new AbortController()
  activeRequestController = controller
  const timeout = setTimeout(
    () => controller.abort(new Error('Discord delivery timed out after 30 seconds.')),
    DISCORD_DELIVERY_TIMEOUT_MS
  )
  try {
    const response = await fetch(target.endpoint, {
      method: 'POST',
      body: form,
      signal: controller.signal
    })
    const responseBody = await readDiscordResponse(response)
    const disposition = classifyDiscordHttpResponse({
      status: response.status,
      retryAfterHeader: response.headers.get('retry-after'),
      rateLimitResetAfterHeader: response.headers.get('x-ratelimit-reset-after'),
      responseBody
    })
    if (disposition.kind === 'delivered') {
      const messageId = messageIdFromBody(responseBody)
      markResearchDiscordDeliveryDelivered(delivery.id, messageId)
      logResearchEvent({
        jobId: job.id,
        kind: 'note',
        title: `Delivered to ${getResearchDiscordConfig().destinationLabel}`,
        detail: `${artifact.format.toUpperCase()} · ${file.byteLength} bytes${messageId ? ` · Discord message ${messageId}` : ''}`
      })
      return
    }
    if (disposition.kind === 'retry' && delivery.attemptCount < MAX_AUTOMATIC_ATTEMPTS) {
      const delay = disposition.delayMs || retryBackoffMs(delivery.attemptCount)
      const nextAttemptAt = Date.now() + delay
      markResearchDiscordDeliveryRetry(delivery.id, disposition.reason, nextAttemptAt)
      logResearchEvent({
        jobId: job.id,
        kind: 'warning',
        title: 'Discord delivery will retry automatically',
        detail: `${disposition.reason} Next attempt: ${new Date(nextAttemptAt).toISOString()}`
      })
      return
    }
    recordPermanentFailure(delivery, disposition.reason)
  } catch (error) {
    // A network failure or timeout can occur after Discord accepted the body.
    // Blind retrying would risk a duplicate, so require explicit channel review.
    const message = `${safeDiscordError(error)} Check ${getResearchDiscordConfig().destinationLabel} before retrying.`
    markResearchDiscordDeliveryNeedsReview(delivery.id, message)
    logResearchEvent({
      jobId: job.id,
      kind: 'warning',
      title: 'Discord delivery needs review',
      detail: message
    })
  } finally {
    clearTimeout(timeout)
    if (activeRequestController === controller) activeRequestController = null
  }
}

function recordPermanentFailure(delivery: ResearchDiscordDelivery, error: string): void {
  const safe = safeDiscordError(error)
  markResearchDiscordDeliveryFailed(delivery.id, safe)
  logResearchEvent({
    jobId: delivery.jobId,
    kind: 'warning',
    title: 'Discord delivery failed',
    detail: safe
  })
}

function requireDiscordTarget(): DiscordWebhookTarget {
  const config = getResearchDiscordConfig()
  if (!config.enabled) throw new Error('Automatic Discord delivery is disabled.')
  if (!config.webhookUrlCiphertext) throw new Error('The Discord webhook is not configured.')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure OS credential storage is unavailable.')
  if (!config.webhookUrlCiphertext.startsWith(CIPHERTEXT_PREFIX)) {
    throw new Error('The saved Discord webhook credential has an unsupported format.')
  }
  try {
    const encrypted = Buffer.from(config.webhookUrlCiphertext.slice(CIPHERTEXT_PREFIX.length), 'base64')
    return parseDiscordWebhookUrl(safeStorage.decryptString(encrypted))
  } catch {
    throw new Error('The saved Discord webhook credential could not be decrypted on this computer.')
  }
}

function encryptWebhookUrl(endpoint: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure OS credential storage is unavailable; the webhook was not saved.')
  }
  return `${CIPHERTEXT_PREFIX}${safeStorage.encryptString(endpoint).toString('base64')}`
}

function readValidatedManagedArtifact(
  workspaceDir: string,
  artifactPath: string,
  recordedSize: number,
  checksum?: string
): Buffer {
  const link = lstatSync(artifactPath)
  if (link.isSymbolicLink() || !link.isFile()) throw new Error('The Research artifact is not a regular file.')
  const workspaceReal = realpathSync(workspaceDir)
  const artifactReal = realpathSync(artifactPath)
  if (!isManagedResearchPath(workspaceReal, artifactReal)) {
    throw new Error('The Research artifact is outside Akorith managed storage.')
  }
  const actualSize = statSync(artifactReal).size
  if (actualSize !== recordedSize) throw new Error('The Research artifact changed after validation.')
  if (actualSize > DISCORD_DEFAULT_ATTACHMENT_LIMIT_BYTES) {
    throw new Error(`The Research artifact exceeds Discord's ${DISCORD_DEFAULT_ATTACHMENT_LIMIT_BYTES}-byte default limit.`)
  }
  const file = readFileSync(artifactReal)
  if (checksum) {
    const actualChecksum = createHash('sha256').update(file).digest('hex')
    if (actualChecksum.toLowerCase() !== checksum.toLowerCase()) {
      throw new Error('The Research artifact checksum no longer matches its validated record.')
    }
  }
  return file
}

async function readDiscordResponse(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, MAX_DISCORD_RESPONSE_BYTES)
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function messageIdFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const id = (body as Record<string, unknown>).id
  return typeof id === 'string' && /^[0-9]{5,30}$/.test(id) ? id : undefined
}

function retryBackoffMs(attemptCount: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attemptCount - 1, 0), RETRY_DELAYS_MS.length - 1)]
}
