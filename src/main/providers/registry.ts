// Provider registry — the single source of truth for which backends exist.
// Driven entirely by loopex.config.json in the app's userData dir; the UI
// and IPC layer never assume a fixed provider set.

import { app, ipcMain } from 'electron'
import { isAbsolute, join } from 'path'
import { createRequire } from 'module'
import { loadConfig, getDigestSettings } from '../config'
import { buildDigest } from '../digest'
import {
  beginChatTurn,
  getContextSummary,
  getRunningWorkspaceGoalForPath,
  getSessionMessages,
  getSessionProjectContext,
  recordUsageEvent,
  sessionExists,
  setContextSummary,
  updateChatTurnAssistant,
  type StoredMessageActivity
} from '../db'
import {
  buildOlderSummaryPrompt,
  describeContext,
  DEFAULT_CONTEXT_POLICY,
  renderProviderPrompt,
  selectContextWindow,
  type ConvMessage
} from '../conversation'
import type {
  Provider,
  ProviderActivity,
  ProviderAvailability,
  ProviderConfigEntry,
  ProviderInfo,
  ProviderGenerationOptions,
  ProviderUsageSource,
  SendResult
} from './types'
import { ChatGPTProvider } from './chatgpt'
import { LocalProvider } from './local'
import { agentSessionManager } from '../agents/session-manager'
import { safeRuntimeError } from '../agents/observation'
import type { AgentId } from '../agents/types'
import { normalizeStoredOpenCodeMessage } from '../../shared/opencode-output'
import { inspectProject, renderProjectContext } from '../project-loop/context'
import { changedSince, summarizeGitChanges } from '../git-status'
import { enabledPluginContext } from '../plugins/manager'
import { openWorkspacePreview } from '../project-preview'
import {
  detectWorkspaceBrowserAction,
  runWorkspaceBrowserAction,
  WORKSPACE_BROWSER_ACTION_INSTRUCTION
} from '../workspace-actions'
import {
  acquireWorkspaceWriterLease,
  type WorkspaceWriterLease
} from '../workspace-writer-lease'
import {
  attachmentPrompt,
  inlineTextAttachmentContext,
  storeChatAttachments,
  validChatAttachments,
  type IncomingChatAttachment,
  type StoredChatAttachment
} from '../chat-attachments'
import type { ChatLifecycleState } from '../../shared/chat-lifecycle'
import { isCliTimeoutError, redactCliText } from './util'

// The only place built-in provider classes are referenced. New built-ins are
// one line here; external providers need no code change at all — a config
// entry with a `module` path is loaded at runtime.
function lazyBuiltIn(
  id: string,
  label: string,
  load: () => Promise<Provider>
): Provider {
  let loaded: Promise<Provider> | null = null
  const get = (): Promise<Provider> => {
    loaded ??= load()
    return loaded
  }
  return {
    id,
    label,
    kind: ['chat', 'executor'],
    isAvailable: async () => (await get()).isAvailable(),
    listModels: async () => (await get()).listModels(),
    discover: async (force) => {
      const provider = await get()
      return provider.discover
        ? provider.discover(force)
        : {
            available: await provider.isAvailable(),
            models: await provider.listModels()
          }
    },
    send: async (prompt, options, onToken) => (await get()).send(prompt, options, onToken)
  }
}

const BUILT_IN: Record<string, (entry: ProviderConfigEntry) => Provider> = {
  claude: (entry) => lazyBuiltIn(
    'claude',
    'Claude',
    () => import('./claude').then(({ ClaudeProvider }) => new ClaudeProvider(entry))
  ),
  chatgpt: (entry) => new ChatGPTProvider(entry),
  local: (entry) => new LocalProvider(entry),
  opencode: (entry) => lazyBuiltIn(
    'opencode',
    'OpenCode',
    () => import('./opencode').then(({ OpenCodeProvider }) => new OpenCodeProvider(entry))
  )
}

const VALID_ID = /^[a-z0-9-]{1,32}$/
const VALID_MODEL = /^[\w.:/-]{1,64}$/
const VALID_USAGE_SOURCE_ID = /^[\w:.-]{1,128}$/
const MAX_PROMPT_CHARS = 200_000
const MAX_STORED_ACTIVITIES = 200
const CONTEXT_SUMMARY_TIMEOUT_MS = 30_000
const PENDING_CANCEL_TTL_MS = 60_000

function validGenerationOptions(value: unknown): value is ProviderGenerationOptions {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const generation = value as Record<string, unknown>
  const keys = Object.keys(generation)
  if (keys.some((key) => !['maxTokens', 'temperature', 'timeoutMs'].includes(key))) return false
  if (
    generation.maxTokens !== undefined &&
    (typeof generation.maxTokens !== 'number' ||
      !Number.isInteger(generation.maxTokens) ||
      generation.maxTokens < 1 ||
      generation.maxTokens > 1_000_000)
  ) {
    return false
  }
  if (
    generation.temperature !== undefined &&
    (typeof generation.temperature !== 'number' ||
      !Number.isFinite(generation.temperature) ||
      generation.temperature < 0 ||
      generation.temperature > 2)
  ) {
    return false
  }
  if (
    generation.timeoutMs !== undefined &&
    (typeof generation.timeoutMs !== 'number' ||
      !Number.isInteger(generation.timeoutMs) ||
      generation.timeoutMs < 1_000 ||
      generation.timeoutMs > 1_800_000)
  ) {
    return false
  }
  return true
}

function validUsageSource(value: unknown): value is ProviderUsageSource {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return (
    Object.keys(source).every((key) => key === 'kind' || key === 'id') &&
    source.kind === 'benchmark' &&
    typeof source.id === 'string' &&
    VALID_USAGE_SOURCE_ID.test(source.id)
  )
}
const MAX_CHAT_IMAGES = 4
const MAX_CHAT_IMAGE_BASE64_CHARS = 8_000_000
const VALID_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const PROVIDER_SNAPSHOT_CACHE_MS = 60_000
const TOKEN_IPC_BATCH_MS = 16
const HEADLESS_WORKSPACE_GUIDANCE = process.platform === 'win32'
  ? 'On Windows, prefer direct file-edit tools such as apply_patch instead of shell commands that write files. Use only one inspection or validation command per shell tool call; do not chain commands with semicolons, pipes, redirection, or &&. If one command is rejected by policy, that does not mean the workspace is read-only: continue with direct file tools or a simpler allowed command.'
  : 'Prefer direct file-edit tools for project changes. Keep each shell tool call to one inspection or validation command. If one command is rejected by policy, continue with direct file tools or a simpler allowed command instead of treating the whole workspace as read-only.'

let providerSnapshotCache: {
  configSignature: string
  capturedAt: number
  value: ProviderInfo[]
} | null = null
let providerSnapshotInFlight: {
  configSignature: string
  request: Promise<ProviderInfo[]>
} | null = null
let providerInstanceCache: {
  configSignature: string
  value: Map<string, Provider>
} | null = null

function loadExternalProvider(id: string, entry: ProviderConfigEntry): Provider {
  const modulePath = isAbsolute(entry.module!) ? entry.module! : join(app.getPath('userData'), entry.module!)
  // Runtime require so user-dropped provider files need no rebuild.
  const require = createRequire(__filename)
  const mod = require(modulePath) as {
    default?: new (e: ProviderConfigEntry) => Provider
    createProvider?: (e: ProviderConfigEntry) => Provider
  }
  if (typeof mod.createProvider === 'function') return mod.createProvider(entry)
  if (typeof mod.default === 'function') return new mod.default(entry)
  throw new Error(`${modulePath} exports neither createProvider() nor a default class`)
}

/** Build provider instances from the current config. Failures skip the
 *  provider (logged) — a bad entry must never take the app down. */
function buildProviders(config: ReturnType<typeof loadConfig> = loadConfig()): Map<string, Provider> {
  const configSignature = JSON.stringify(config.providers)
  if (providerInstanceCache?.configSignature === configSignature) {
    return providerInstanceCache.value
  }
  const providers = new Map<string, Provider>()
  for (const [id, entry] of Object.entries(config.providers)) {
    if (!entry?.enabled || !VALID_ID.test(id)) continue
    try {
      const provider = entry.module ? loadExternalProvider(id, entry) : BUILT_IN[id]?.(entry)
      if (!provider) {
        console.error(`[registry] "${id}" is not a built-in provider and has no "module" path — skipped`)
        continue
      }
      providers.set(id, provider)
    } catch (err) {
      console.error(`[registry] failed to load provider "${id}":`, err)
    }
  }
  providerInstanceCache = { configSignature, value: providers }
  return providers
}

/**
 * Meta/evaluation sends call providers directly without sessions, repo digest,
 * messages, or implicit usage_events. Callers that represent user-visible work
 * (such as Research) persist their returned usage with a stable logical turn ID;
 * internal judges and summarizers intentionally leave the dashboard untouched.
 */
export async function sendMetaPrompt(
  providerId: string,
  model: string | undefined,
  prompt: string,
  signal?: AbortSignal,
  options: { workingDirectory?: string; background?: boolean } = {}
): Promise<SendResult> {
  if (!VALID_ID.test(providerId)) throw new Error('invalid provider id')
  if (model !== undefined && !VALID_MODEL.test(model)) throw new Error('invalid model')
  const provider = buildProviders().get(providerId)
  if (!provider) throw new Error(`provider "${providerId}" is not enabled`)
  return provider.send(
    prompt,
    {
      model,
      signal,
      background: options.background,
      workingDirectory: options.workingDirectory,
      // Meta prompts may inspect their managed workspace, but must never edit
      // it. Passing an explicit directory also prevents reusable CLI daemons
      // from inheriting Akorith's own source checkout as their tool boundary.
      intent: options.workingDirectory ? 'plan' : undefined
    },
    () => {}
  )
}

/** Headless Goal execution. Uses the selected installed CLI in the trusted workspace. */
export async function sendWorkspacePrompt(
  providerId: string,
  model: string | undefined,
  prompt: string,
  workingDirectory: string,
  signal?: AbortSignal,
  onActivity?: (activity: ProviderActivity) => void
): Promise<SendResult> {
  if (!VALID_ID.test(providerId)) throw new Error('invalid provider id')
  if (model !== undefined && !VALID_MODEL.test(model)) throw new Error('invalid model')
  const provider = buildProviders().get(providerId)
  if (!provider || !provider.kind.includes('executor')) throw new Error(`provider "${providerId}" cannot edit a workspace`)
  const tools = enabledPluginContext()
  const instruction = `You are executing one cycle of an Akorith Goal inside the selected local workspace. The Goal may be software development, research, analysis, automation, or production of files such as PDF, DOCX, Markdown, data, or media assets. Inspect the available inputs, perform the requested work, create or update the required artifacts, and run relevant checks. Finish with a concise evidence-based summary. Do not create a git commit or push; Akorith checkpoints verified work. Stay inside the workspace, never reveal secrets, and do not only describe a solution.\n\n${HEADLESS_WORKSPACE_GUIDANCE}\n\n${WORKSPACE_BROWSER_ACTION_INSTRUCTION}${tools ? `\n\n${tools}` : ''}\n\nCycle objective:\n${prompt}`
  const result = await provider.send(
    instruction,
    { model, signal, workingDirectory, onActivity, intent: 'execute' },
    () => {}
  )
  return completeWorkspaceBrowserAction({
    prompt,
    intent: 'execute',
    workspacePath: workingDirectory,
    result,
    emit: onActivity
  })
}

/** The available-provider snapshot, also consumed by the Phase 6 router. */
async function describeProvidersFresh(
  config: ReturnType<typeof loadConfig>,
  force: boolean
): Promise<ProviderInfo[]> {
  const providers = buildProviders(config)
  return Promise.all(
    [...providers.values()].map(async (provider): Promise<ProviderInfo> => {
      if (provider.discover) {
        try {
          const discovered = await provider.discover(force)
          return {
            id: provider.id,
            label: provider.label,
            kind: provider.kind,
            available: discovered.available,
            models: discovered.available.ok ? discovered.models : []
          }
        } catch (err) {
          return {
            id: provider.id,
            label: provider.label,
            kind: provider.kind,
            available: { ok: false, reason: err instanceof Error ? err.message : String(err) },
            models: []
          }
        }
      }
      let available: ProviderAvailability = { ok: false, reason: 'availability check failed' }
      try {
        available = await provider.isAvailable()
      } catch (err) {
        available = { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
      let models: string[] = []
      if (available.ok) {
        try {
          models = await provider.listModels()
        } catch {
          models = []
        }
      }
      return { id: provider.id, label: provider.label, kind: provider.kind, available, models }
    })
  )
}

export async function describeProviders(force = false): Promise<ProviderInfo[]> {
  // Config changes remain immediately visible while duplicate startup callers
  // share one expensive CLI/Ollama discovery pass.
  const config = loadConfig()
  const configSignature = JSON.stringify(config.providers)
  const cached = providerSnapshotCache
  if (
    !force &&
    cached &&
    cached.configSignature === configSignature &&
    Date.now() - cached.capturedAt < PROVIDER_SNAPSHOT_CACHE_MS
  ) {
    return cached.value
  }
  if (providerSnapshotInFlight?.configSignature === configSignature) {
    return providerSnapshotInFlight.request
  }

  const request = describeProvidersFresh(config, force)
  providerSnapshotInFlight = { configSignature, request }
  try {
    const value = await request
    providerSnapshotCache = { configSignature, capturedAt: Date.now(), value }
    return value
  } finally {
    if (providerSnapshotInFlight?.request === request) providerSnapshotInFlight = null
  }
}

interface ChatSendArgs {
  requestId: string
  providerId: string
  model?: string
  prompt: string
  /** When set (and the session exists), the exchange + usage are persisted. */
  sessionId?: string
  /** False for General Chat so repo context cannot leak out of project workspaces. */
  includeDigest?: boolean
  /** Renderer hint for project chats; main derives trusted context from the session's stored project. */
  workspaceContext?: { projectName: string; projectPath: string }
  images?: { name: string; mimeType: string; dataBase64: string }[]
  attachments?: IncomingChatAttachment[]
  intent?: 'execute' | 'plan'
  generation?: ProviderGenerationOptions
  usageSource?: ProviderUsageSource
}

type ChatSendResponse = { ok: true; result: SendResult } | { ok: false; error: string }

const activeRequests = new Map<string, AbortController>()
const pendingCancellations = new Map<string, number>()

type CleanProviderActivity = ProviderActivity & {
  status: NonNullable<ProviderActivity['status']>
  timestamp: number
}

function cleanActivity(activity: ProviderActivity): CleanProviderActivity {
  const clean = (value: string | undefined, max: number): string | undefined => {
    if (!value) return undefined
    const text = value.replace(/\s+/g, ' ').trim()
    return text ? text.slice(0, max) : undefined
  }
  const cleanPublic = (value: string | undefined, max: number): string | undefined => {
    const text = clean(value, max)
    return text ? redactCliText(text) : undefined
  }
  const finiteTimestamp = (value: number | undefined): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : undefined
  return {
    id: clean(activity.id, 160),
    kind: activity.kind,
    label: cleanPublic(activity.label, 180) ?? 'Working',
    detail: cleanPublic(activity.detail, 500),
    status: activity.status ?? 'running',
    surface: activity.surface ??
      (activity.kind === 'file' ? 'files' : activity.kind === 'command' ? 'terminal' : undefined),
    timestamp: finiteTimestamp(activity.timestamp) ?? Date.now(),
    startedAt: finiteTimestamp(activity.startedAt),
    endedAt: finiteTimestamp(activity.endedAt)
  }
}

function publicChatFailure(error: unknown): string {
  return redactCliText(safeRuntimeError(error, 240))
}

function readableTimeout(timeoutMs?: number): string {
  if (!timeoutMs) return ''
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000))
  return seconds >= 60 && seconds % 60 === 0
    ? `${seconds / 60} ${seconds === 60 ? 'minute' : 'minutes'}`
    : `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
}

function durableFailureText(
  state: Extract<ChatLifecycleState, 'error' | 'cancelled' | 'timed_out'>,
  error: unknown,
  workspace: boolean,
  timeoutMs?: number
): string {
  const projectNote = workspace
    ? ' Any project changes produced before it stopped remain available in Review and Files.'
    : ''
  if (state === 'cancelled') {
    return `This request was stopped before Akorith could save a final response.${projectNote}`
  }
  if (state === 'timed_out') {
    const duration = readableTimeout(timeoutMs)
    return `This request timed out${duration ? ` after ${duration}` : ''} before Akorith could save a final response.${projectNote}`
  }
  return `Akorith could not complete this request: ${publicChatFailure(error)}.${projectNote}`
}

async function completeWorkspaceBrowserAction(input: {
  prompt: string
  intent: 'execute' | 'plan' | undefined
  workspacePath: string
  result: SendResult
  emit?: (activity: ProviderActivity) => void
}): Promise<SendResult> {
  const requested = detectWorkspaceBrowserAction(input.prompt, input.intent)
  if (!requested) return input.result

  const browserLabel = requested.browser === 'chrome' ? 'Chrome' : 'the default browser'
  input.emit?.({
    kind: 'tool',
    label: `Opening the project preview in ${browserLabel}`,
    status: 'running',
    surface: 'browser'
  })
  const outcome = await runWorkspaceBrowserAction({
    prompt: input.prompt,
    intent: input.intent,
    workspacePath: input.workspacePath
  }, {
    opener: async (request) => {
      const opened = await openWorkspacePreview(request)
      return { url: opened.url }
    }
  })
  if (!outcome) return input.result

  if ('error' in outcome) {
    input.emit?.({
      kind: 'warning',
      label: outcome.label,
      detail: outcome.error,
      status: 'error'
    })
    const text = input.result.text.trim()
    const receipt = `${outcome.label}: ${outcome.error}`
    return { ...input.result, text: text ? `${text}\n\n${receipt}` : receipt }
  }

  input.emit?.({
    kind: 'tool',
    label: outcome.label,
    detail: outcome.url,
    status: 'complete',
    surface: 'browser'
  })
  const text = input.result.text.trim()
  const receipt = `${outcome.label}: ${outcome.url}`
  return { ...input.result, text: text ? `${text}\n\n${receipt}` : receipt }
}

interface ProviderObservation {
  sessionId: string
  attachmentId: string
}

function agentIdForProvider(providerId: string): AgentId | null {
  if (providerId === 'claude') return 'claude'
  if (providerId === 'chatgpt' || providerId === 'codex') return 'codex'
  if (providerId === 'opencode') return 'opencode'
  if (providerId === 'local' || providerId === 'ollama') return 'ollama'
  return null
}

function startProviderObservation(args: ChatSendArgs, provider: Provider, projectPath?: string): ProviderObservation | null {
  const agentId = agentIdForProvider(args.providerId)
  if (!agentId) return null
  try {
    const observed = agentSessionManager.createObservedSession({
      agentId,
      mode: 'chat',
      origin: 'chat',
      status: 'busy',
      projectPath,
      title: `${provider.label} provider call`,
      metadata: {
        providerId: args.providerId,
        model: args.model ?? null,
        hasImages: Boolean(args.images?.length || args.attachments?.some((item) => item.kind === 'image')),
        hasAttachments: Boolean(args.attachments?.length),
        intent: args.intent ?? 'execute',
        includeDigest: args.includeDigest === true,
        persistedChatSession: Boolean(args.sessionId),
        sourceFile: 'src/main/providers/registry.ts'
      }
    })
    const attachment = agentSessionManager.attachRuntime(observed.id, {
      kind: 'provider_call',
      agentId,
      externalId: args.requestId,
      status: 'active',
      sourceFile: 'src/main/providers/registry.ts',
      projectPath,
      title: `${provider.label} provider call`,
      startedAt: observed.createdAt,
      metadata: {
        providerId: args.providerId,
        model: args.model ?? null,
        streamingTokens: provider.id === 'claude' || provider.id === 'local'
      }
    })
    return attachment ? { sessionId: observed.id, attachmentId: attachment.id } : null
  } catch {
    return null
  }
}

function completeProviderObservation(observation: ProviderObservation | null, result: SendResult): void {
  if (!observation) return
  try {
    agentSessionManager.updateRuntimeAttachment(observation.attachmentId, {
      status: 'completed',
      metadata: { model: result.model }
    })
    agentSessionManager.markObservedSessionCompleted(observation.sessionId, {
      metadata: {
        observed: true,
        runtime: 'phase-30-runtime-observation',
        completedProviderModel: result.model
      }
    })
  } catch {
    // Observation must never affect provider behavior.
  }
}

function failProviderObservation(observation: ProviderObservation | null, err: unknown): void {
  if (!observation) return
  const message = safeRuntimeError(err)
  try {
    agentSessionManager.updateRuntimeAttachment(observation.attachmentId, {
      status: 'failed',
      error: message
    })
    agentSessionManager.markObservedSessionFailed(observation.sessionId, message)
  } catch {
    // Observation must never affect provider behavior.
  }
}

/** Convert stored rows to the pure conversation shape. */
function toConv(messages: { role: 'user' | 'assistant'; content: string; providerId: string; attachments?: { name: string }[] }[]): ConvMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: `${message.role === 'assistant' && message.providerId === 'opencode'
        ? normalizeStoredOpenCodeMessage(message.content)
        : message.content}${message.attachments?.length ? `\n\nAttached files: ${message.attachments.map((item) => item.name).join(', ')}` : ''}`
  }))
}

/**
 * Ensure the session has a cached summary covering the current older (non-verbatim)
 * window, regenerating only when the older set grew. Uses a META call
 * (sendMetaPrompt → NO usage_event). Returns the summary text to fold into the
 * prompt, or null when no summary is needed / generation failed (recent turns
 * still carry the conversation).
 */
async function ensureOlderSummary(
  sessionId: string,
  prior: ConvMessage[],
  providerId: string,
  model: string | undefined,
  signal: AbortSignal
): Promise<string | null> {
  const window = selectContextWindow(prior, DEFAULT_CONTEXT_POLICY)
  if (window.older.length === 0) return null // everything fits verbatim
  const cached = getContextSummary(sessionId)
  // Reuse the cached summary while it still covers the whole older window.
  if (cached.summary && cached.count >= window.older.length) return cached.summary
  const summaryController = new AbortController()
  const forwardAbort = (): void => summaryController.abort()
  const timeout = setTimeout(() => summaryController.abort(), CONTEXT_SUMMARY_TIMEOUT_MS)
  if (signal.aborted) summaryController.abort()
  else signal.addEventListener('abort', forwardAbort, { once: true })
  try {
    const prompt = buildOlderSummaryPrompt(window.older, cached.summary)
    const res = await sendMetaPrompt(providerId, model, prompt, summaryController.signal)
    const summary = res.text.trim()
    if (summary) {
      setContextSummary(sessionId, summary, window.older.length)
      return summary
    }
  } catch (err) {
    console.error('[registry] older-context summary failed — using recent turns only:', err)
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', forwardAbort)
  }
  return cached.summary // fall back to a stale summary if we have one
}

function validImages(images: unknown): images is NonNullable<ChatSendArgs['images']> {
  if (images === undefined) return true
  if (!Array.isArray(images) || images.length > MAX_CHAT_IMAGES) return false
  return images.every((image) =>
    image &&
    typeof image === 'object' &&
    typeof image.name === 'string' &&
    image.name.length > 0 &&
    image.name.length <= 200 &&
    typeof image.mimeType === 'string' &&
    VALID_IMAGE_MIME.has(image.mimeType) &&
    typeof image.dataBase64 === 'string' &&
    image.dataBase64.length > 0 &&
    image.dataBase64.length <= MAX_CHAT_IMAGE_BASE64_CHARS &&
    /^[A-Za-z0-9+/=]+$/.test(image.dataBase64)
  )
}

export function registerChatIpc(): void {
  ipcMain.handle('chat:providers', (_event, args: unknown) => {
    const force = Boolean(args && typeof args === 'object' && (args as { force?: unknown }).force === true)
    return describeProviders(force)
  })

  ipcMain.handle('chat:send', async (event, args: ChatSendArgs): Promise<ChatSendResponse> => {
    if (
      typeof args?.requestId !== 'string' ||
      !/^[\w-]{1,64}$/.test(args.requestId) ||
      typeof args.providerId !== 'string' ||
      !VALID_ID.test(args.providerId) ||
      typeof args.prompt !== 'string' ||
      args.prompt.length === 0 ||
      args.prompt.length > MAX_PROMPT_CHARS ||
      (args.model !== undefined && (typeof args.model !== 'string' || !VALID_MODEL.test(args.model))) ||
      (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !/^[\w-]{1,64}$/.test(args.sessionId))) ||
      (args.includeDigest !== undefined && typeof args.includeDigest !== 'boolean') ||
      (args.workspaceContext !== undefined &&
        (!args.workspaceContext ||
          typeof args.workspaceContext !== 'object' ||
          typeof args.workspaceContext.projectName !== 'string' ||
          args.workspaceContext.projectName.length > 200 ||
          typeof args.workspaceContext.projectPath !== 'string' ||
          args.workspaceContext.projectPath.length > 1_000)) ||
      !validImages(args.images)
      || !validChatAttachments(args.attachments)
      || (args.intent !== undefined && args.intent !== 'execute' && args.intent !== 'plan')
      || !validGenerationOptions(args.generation)
      || !validUsageSource(args.usageSource)
    ) {
      return { ok: false, error: 'invalid chat:send payload' }
    }

    const provider = buildProviders().get(args.providerId)
    if (!provider) {
      return { ok: false, error: `provider "${args.providerId}" is not enabled` }
    }

    // Persistence happens here — the single choke point for every send — so a
    // usage_event can never be skipped by a UI path. DB trouble must not block
    // the chat itself.
    const sessionId = args.sessionId && sessionExists(args.sessionId) ? args.sessionId : undefined
    // Project scope is independent from the optional repository digest. It is
    // derived from the persisted session (never trusted from renderer input),
    // and also becomes the CLI working directory below.
    const workspaceContext = sessionId ? getSessionProjectContext(sessionId) : null
    if (workspaceContext?.projectPath && args.intent !== 'plan') {
      const activeGoal = getRunningWorkspaceGoalForPath(workspaceContext.projectPath)
      if (activeGoal) {
        return {
          ok: false,
          error: `A /loop goal is already editing this project. Pause it before starting another Workspace task: ${activeGoal.goal
            .replace(/\s+/g, ' ')
            .slice(0, 120)}`
        }
      }
    }
    let workspaceWriterLease: WorkspaceWriterLease | null = null
    const releaseWorkspaceWriterLease = (): void => {
      workspaceWriterLease?.release()
      workspaceWriterLease = null
    }
    if (workspaceContext?.projectPath && args.intent !== 'plan') {
      try {
        workspaceWriterLease = acquireWorkspaceWriterLease(workspaceContext.projectPath, {
          kind: 'workspace-chat',
          id: args.requestId,
          label: `Workspace request ${args.requestId}`
        })
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    let storedAttachments: StoredChatAttachment[] = []
    if (args.attachments?.length) {
      if (!sessionId) {
        releaseWorkspaceWriterLease()
        return { ok: false, error: 'attachments require a persisted chat session' }
      }
      try {
        storedAttachments = await storeChatAttachments(sessionId, args.requestId, args.attachments)
      } catch (err) {
        releaseWorkspaceWriterLease()
        return { ok: false, error: `Could not store attachments: ${err instanceof Error ? err.message : String(err)}` }
      }
    }

    // Phase 14.2 conversation memory: load the session's PRIOR messages BEFORE
    // persisting the new one, so the provider actually receives the conversation
    // (the visible chat truly remembers prior turns). Strictly per-session — no
    // cross-chat / cross-project leakage is possible since only this session's
    // rows are read.
    let prior: ConvMessage[] = []
    const requestStartedAt = Date.now()
    const requestActivities: StoredMessageActivity[] = []
    let activitySequence = 0
    let assistantMessageId: string | undefined
    if (sessionId) {
      try {
        prior = toConv(getSessionMessages(sessionId))
      } catch (err) {
        console.error('[registry] failed to load session context:', err)
      }
      try {
        assistantMessageId = beginChatTurn({
          sessionId,
          prompt: args.prompt,
          providerId: args.providerId,
          model: args.model,
          requestId: args.requestId,
          startedAt: requestStartedAt,
          attachments: storedAttachments
        }).assistantMessageId
      } catch (err) {
        console.error('[registry] failed to persist durable chat turn:', err)
        releaseWorkspaceWriterLease()
        return { ok: false, error: 'Could not save this conversation turn. No model work was started.' }
      }
    }

    const sender = event.sender
    const controller = new AbortController()
    const emitActivity = (activity: ProviderActivity): void => {
      const clean = cleanActivity(activity)
      const normalized: StoredMessageActivity = {
        ...clean,
        id: clean.id ?? `registry:event-${++activitySequence}`
      }
      requestActivities.push(normalized)
      if (requestActivities.length > MAX_STORED_ACTIVITIES) requestActivities.shift()
      if (!sender.isDestroyed()) {
        sender.send('chat:activity', {
          requestId: args.requestId,
          ...normalized
        })
      }
    }
    const requestTimeoutMs = args.generation?.timeoutMs
    let requestTimedOut = false
    const requestTimeout = requestTimeoutMs
      ? setTimeout(() => {
          requestTimedOut = true
          controller.abort()
        }, requestTimeoutMs)
      : null
    activeRequests.set(args.requestId, controller)
    const pendingCancelAt = pendingCancellations.get(args.requestId)
    pendingCancellations.delete(args.requestId)
    if (pendingCancelAt && Date.now() - pendingCancelAt <= PENDING_CANCEL_TTL_MS) controller.abort()
    const onSenderDestroyed = (): void => controller.abort()
    sender.once('destroyed', onSenderDestroyed)
    try {
      const contextStartedAt = Date.now()
      emitActivity({
        id: 'registry:project-context',
        kind: 'status',
        label: 'Preparing the project context',
        detail: 'Akorith is loading the conversation, attachments, repository context, and current file-change snapshot before the model starts.',
        status: 'running',
        timestamp: contextStartedAt,
        startedAt: contextStartedAt
      })
      if (controller.signal.aborted) throw new Error('cancelled')
      // Opt-in repo context (Phase 6): a bounded digest the PROVIDER sees — the
      // stored user message and the usage event stay the clean typed prompt. A
      // digest failure never blocks the send.
      const digestPromise = (async (): Promise<string | null> => {
        try {
          const digestSettings = getDigestSettings()
          if (args.includeDigest !== true || !digestSettings.enabled) return null
          return await buildDigest({
            ...digestSettings,
            workingDir: workspaceContext?.projectPath || digestSettings.workingDir
          })
        } catch (err) {
          console.error('[registry] repo digest failed — sending without context:', err)
          return null
        }
      })()
      // Context summarization, digest construction, attachment reads, and the
      // pre-edit Git snapshot are independent. Start them together so CLI
      // launch is not delayed by a main-process waterfall.
      const summaryPromise = sessionId && prior.length > 0
        ? ensureOlderSummary(sessionId, prior, args.providerId, args.model, controller.signal)
        : Promise.resolve<string | null>(null)
      const localAttachmentPromise = args.providerId === 'local'
        ? inlineTextAttachmentContext(storedAttachments)
        : Promise.resolve('')
      const changesBeforePromise = workspaceContext?.projectPath && args.intent !== 'plan'
        ? summarizeGitChanges(workspaceContext.projectPath).catch(() => null)
        : Promise.resolve(null)
      const [digest, summary, localAttachmentContext, changesBefore] = await Promise.all([
        digestPromise,
        summaryPromise,
        localAttachmentPromise,
        changesBeforePromise
      ])
      const contextEndedAt = Date.now()
      emitActivity({
        id: 'registry:project-context',
        kind: 'status',
        label: 'Project context is ready',
        detail: 'The selected model now has the bounded project and conversation context needed for this request.',
        status: 'complete',
        timestamp: contextEndedAt,
        endedAt: contextEndedAt
      })
      if (controller.signal.aborted) throw new Error('cancelled')
      const localPlanContext = args.providerId === 'local' && args.intent === 'plan' && workspaceContext?.projectPath
        ? `\n\nProject snapshot:\n${renderProjectContext(inspectProject(workspaceContext.projectPath))}`
        : ''
      const built = renderProviderPrompt({
        priorMessages: prior,
        currentPrompt: `${args.prompt}${attachmentPrompt(storedAttachments)}${args.images?.length
          ? `\n\nAttached images: ${args.images.map((image) => image.name).join(', ')}`
          : ''}${localAttachmentContext}${localPlanContext}`,
        summary,
        digest,
        workspace: workspaceContext
      })
      const workspaceTools = workspaceContext ? enabledPluginContext() : ''
      const workspaceInstruction = workspaceContext
        ? args.intent === 'plan'
          ? `You are Akorith's project planning agent. Inspect the current working directory and produce a concrete, ordered implementation plan with risks and validation steps. Do not edit files, install packages, commit, or run destructive commands in this turn.${workspaceTools ? `\n\n${workspaceTools}` : ''}\n\n`
          : `You are Akorith's project coding agent. Work directly in the current working directory. Treat the user's explicit request as the concrete task: inspect the project, make the requested file changes, and run relevant checks. If the selected directory is empty, scaffold or create the requested project there instead of claiming no task was provided. Make reasonable, safe implementation assumptions and continue; ask a question only when a genuinely missing decision would materially change the result. Complete the task instead of only describing what should be done. Never push or expose secrets.\n\n${HEADLESS_WORKSPACE_GUIDANCE}\n\n${WORKSPACE_BROWSER_ACTION_INSTRUCTION}${workspaceTools ? `\n\n${workspaceTools}` : ''}\n\n`
        : ''
      const promptForProvider = `${workspaceInstruction}${built.prompt}`
      const observation = startProviderObservation(args, provider, workspaceContext?.projectPath)
      let result: SendResult
      try {
        const modelStartedAt = Date.now()
        emitActivity({
          id: 'registry:model-start',
          kind: 'status',
          label: 'Starting the selected model',
          detail: `${provider.label} is connected to the trusted project boundary and is beginning the requested work.`,
          status: 'running',
          timestamp: modelStartedAt,
          startedAt: modelStartedAt
        })
        let pendingToken = ''
        let tokenTimer: ReturnType<typeof setTimeout> | null = null
        const flushPendingToken = (): void => {
          if (tokenTimer) clearTimeout(tokenTimer)
          tokenTimer = null
          if (!pendingToken) return
          const token = pendingToken
          pendingToken = ''
          if (!sender.isDestroyed()) {
            sender.send('chat:token', { requestId: args.requestId, token })
          }
        }
        const onToken = (token: string): void => {
          pendingToken += token
          if (!tokenTimer) tokenTimer = setTimeout(flushPendingToken, TOKEN_IPC_BATCH_MS)
        }
        try {
          result = workspaceContext?.projectPath && args.providerId === 'local' && args.intent !== 'plan'
            ? await (await import('./local-workspace')).sendWorkspaceLocal(
                provider,
                args.prompt,
                args.model,
                workspaceContext.projectPath,
                controller.signal,
                emitActivity,
                onToken,
                args.generation,
                args.usageSource
              )
            : await provider.send(
                promptForProvider,
                {
                  model: args.model,
                  signal: controller.signal,
                  workingDirectory: workspaceContext?.projectPath,
                  images: args.images ?? storedAttachments.filter((item) => item.kind === 'image' && item.dataBase64).map((item) => ({
                    name: item.name,
                    mimeType: item.mimeType,
                    dataBase64: item.dataBase64!
                  })),
                  attachments: storedAttachments,
                  intent: args.intent ?? 'execute',
                  generation: args.generation,
                  usageSource: args.usageSource,
                  onActivity: emitActivity
                },
                onToken
              )
        } finally {
          flushPendingToken()
        }
        if (workspaceContext?.projectPath && args.intent !== 'plan') {
          const changesAfter = await summarizeGitChanges(workspaceContext.projectPath).catch(() => null)
          result = { ...result, changes: changedSince(changesBefore, changesAfter) }
          result = await completeWorkspaceBrowserAction({
            prompt: args.prompt,
            intent: args.intent ?? 'execute',
            workspacePath: workspaceContext.projectPath,
            result,
            emit: emitActivity
          })
        }
        const modelEndedAt = Date.now()
        emitActivity({
          id: 'registry:model-start',
          kind: 'status',
          label: 'Workspace task complete',
          detail: 'The provider finished its work; Akorith is saving the response, activity history, usage, and file-change evidence.',
          status: 'complete',
          timestamp: modelEndedAt,
          endedAt: modelEndedAt
        })
        completeProviderObservation(observation, result)
      } catch (err) {
        const failedAt = Date.now()
        const providerTimedOut = requestTimedOut || isCliTimeoutError(err)
        emitActivity({
          id: 'registry:model-start',
          kind: 'warning',
          label: providerTimedOut
            ? 'Workspace task timed out'
            : controller.signal.aborted
              ? 'Workspace task stopped'
              : 'Workspace task failed',
          detail: publicChatFailure(err),
          status: 'error',
          timestamp: failedAt,
          endedAt: failedAt
        })
        failProviderObservation(observation, err)
        throw err
      }
      if (assistantMessageId) {
        try {
          updateChatTurnAssistant(assistantMessageId, result.text, args.providerId, result.model, {
            startedAt: requestStartedAt,
            endedAt: Date.now(),
            chatLifecycle: {
              requestId: args.requestId,
              state: 'completed'
            },
            usage: result.usage,
            changes: result.changes,
            activities: requestActivities
          })
        } catch (err) {
          console.error('[registry] failed to persist assistant message:', err)
        }
      }
      if (sessionId || args.usageSource) {
        try {
          recordUsageEvent({
            providerId: args.providerId,
            model: result.model,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            cacheReadTokens: result.usage.cacheReadTokens,
            cacheWriteTokens: result.usage.cacheWriteTokens,
            reasoningTokens: result.usage.reasoningTokens,
            totalTokens: result.usage.totalTokens,
            costUsd: result.usage.costUsd,
            estimated: result.usage.estimated,
            sessionId,
            sourceKind: args.usageSource?.kind,
            sourceId: args.usageSource?.id
          })
        } catch (err) {
          console.error('[registry] failed to persist usage:', err)
        }
      }
      return { ok: true, result }
    } catch (err) {
      const providerTimedOut = isCliTimeoutError(err)
      const state: Extract<ChatLifecycleState, 'error' | 'cancelled' | 'timed_out'> = requestTimedOut || providerTimedOut
        ? 'timed_out'
        : controller.signal.aborted
          ? 'cancelled'
          : 'error'
      const error = durableFailureText(
        state,
        err,
        Boolean(workspaceContext?.projectPath),
        requestTimedOut ? requestTimeoutMs : providerTimedOut ? err.thresholdMs : undefined
      )
      if (assistantMessageId) {
        try {
          updateChatTurnAssistant(
            assistantMessageId,
            error,
            args.providerId,
            args.model,
            {
              startedAt: requestStartedAt,
              endedAt: Date.now(),
              chatLifecycle: {
                requestId: args.requestId,
                state
              },
              activities: requestActivities
            }
          )
        } catch (persistError) {
          console.error('[registry] failed to persist assistant failure:', persistError)
        }
      }
      return { ok: false, error }
    } finally {
      if (requestTimeout) clearTimeout(requestTimeout)
      sender.removeListener('destroyed', onSenderDestroyed)
      activeRequests.delete(args.requestId)
      releaseWorkspaceWriterLease()
    }
  })

  ipcMain.on('chat:cancel', (_event, args: { requestId: string }) => {
    if (typeof args?.requestId !== 'string' || !/^[\w-]{1,64}$/.test(args.requestId)) return
    const active = activeRequests.get(args.requestId)
    if (active) {
      active.abort()
      return
    }
    const now = Date.now()
    for (const [requestId, timestamp] of pendingCancellations) {
      if (now - timestamp > PENDING_CANCEL_TTL_MS) pendingCancellations.delete(requestId)
    }
    if (pendingCancellations.size >= 256) {
      const oldest = pendingCancellations.keys().next().value
      if (typeof oldest === 'string') pendingCancellations.delete(oldest)
    }
    pendingCancellations.set(args.requestId, now)
  })

  // Phase 14.2: read-only report of what conversation context WOULD be sent for a
  // session — the data behind the composer's memory indicator. Calls no model.
  ipcMain.handle('chat:contextInfo', (_event, args: { sessionId: string }) => {
    if (typeof args?.sessionId !== 'string' || !/^[\w-]{1,64}$/.test(args.sessionId) || !sessionExists(args.sessionId)) {
      return { totalMessages: 0, includedVerbatim: 0, summarizedCount: 0, hasSummary: false, approxChars: 0, approxTokens: 0 }
    }
    const prior = toConv(getSessionMessages(args.sessionId))
    const covers = getContextSummary(args.sessionId).count
    return describeContext(prior, covers)
  })

  // Phase 6: the suggest-only router lives in ../router.ts (it reads this
  // registry's describeProviders() + usage_events). It only suggests — every
  // send still arrives here with the user's own selection.
}
