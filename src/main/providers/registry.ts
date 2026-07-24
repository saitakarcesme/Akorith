// Provider registry — the single source of truth for which backends exist.
// Driven entirely by loopex.config.json in the app's userData dir; the UI
// and IPC layer never assume a fixed provider set.

import { app, ipcMain } from 'electron'
import { isAbsolute, join } from 'path'
import { createRequire } from 'module'
import { loadConfig, getDigestSettings } from '../config'
import { buildDigest } from '../digest'
import {
  addMessage,
  getContextSummary,
  getSessionMessages,
  getSessionProjectContext,
  recordUsageEvent,
  sessionExists,
  setContextSummary
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
  SendResult
} from './types'
import { ClaudeProvider } from './claude'
import { ChatGPTProvider } from './chatgpt'
import { LocalProvider } from './local'
import { OpenCodeProvider } from './opencode'
import { agentSessionManager } from '../agents/session-manager'
import { safeRuntimeError } from '../agents/observation'
import type { AgentId } from '../agents/types'
import { normalizeStoredOpenCodeMessage } from '../../shared/opencode-output'
import { buildLocalExecutorPrompt, executeLocalExecutorAttempt } from '../local-executor'
import { inspectProject, renderProjectContext } from '../project-loop/context'
import { changedSince, summarizeGitChanges } from '../git-status'
import { enabledPluginContext } from '../plugins/manager'
import {
  attachmentPrompt,
  inlineTextAttachmentContext,
  storeChatAttachments,
  validChatAttachments,
  type IncomingChatAttachment,
  type StoredChatAttachment
} from '../chat-attachments'

// The only place built-in provider classes are referenced. New built-ins are
// one line here; external providers need no code change at all — a config
// entry with a `module` path is loaded at runtime.
const BUILT_IN: Record<string, (entry: ProviderConfigEntry) => Provider> = {
  claude: (entry) => new ClaudeProvider(entry),
  chatgpt: (entry) => new ChatGPTProvider(entry),
  local: (entry) => new LocalProvider(entry),
  opencode: (entry) => new OpenCodeProvider(entry)
}

const VALID_ID = /^[a-z0-9-]{1,32}$/
const VALID_MODEL = /^[\w.:/-]{1,64}$/
const MAX_PROMPT_CHARS = 200_000
const MAX_CHAT_IMAGES = 4
const MAX_CHAT_IMAGE_BASE64_CHARS = 8_000_000
const VALID_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

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
function buildProviders(): Map<string, Provider> {
  const config = loadConfig()
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
  const instruction = `You are executing one cycle of an Akorith Goal inside the selected local workspace. The Goal may be software development, research, analysis, automation, or production of files such as PDF, DOCX, Markdown, data, or media assets. Inspect the available inputs, perform the requested work, create or update the required artifacts, and run relevant checks. Finish with a concise evidence-based summary. Do not create a git commit or push; Akorith checkpoints verified work. Stay inside the workspace, never reveal secrets, and do not only describe a solution.${tools ? `\n\n${tools}` : ''}\n\nCycle objective:\n${prompt}`
  return provider.send(instruction, { model, signal, workingDirectory, onActivity }, () => {})
}

/** The available-provider snapshot, also consumed by the Phase 6 router. */
export async function describeProviders(): Promise<ProviderInfo[]> {
  const providers = buildProviders()
  return Promise.all(
    [...providers.values()].map(async (provider): Promise<ProviderInfo> => {
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
}

type ChatSendResponse = { ok: true; result: SendResult } | { ok: false; error: string }

const activeRequests = new Map<string, AbortController>()

function cleanActivity(activity: ProviderActivity): ProviderActivity {
  const clean = (value: string | undefined, max: number): string | undefined => {
    if (!value) return undefined
    const text = value.replace(/\s+/g, ' ').trim()
    return text ? text.slice(0, max) : undefined
  }
  return {
    kind: activity.kind,
    label: clean(activity.label, 180) ?? 'Working',
    detail: clean(activity.detail, 500),
    status: activity.status ?? 'running'
  }
}

async function sendWorkspaceLocal(
  provider: Provider,
  goal: string,
  model: string | undefined,
  workspaceDir: string,
  signal: AbortSignal,
  emit: (activity: ProviderActivity) => void,
  onToken: (token: string) => void
): Promise<SendResult> {
  emit({ kind: 'status', label: 'Inspecting the project', status: 'running' })
  const context = inspectProject(workspaceDir)
  emit({ kind: 'status', label: `Project context ready (${context.fileTree.length} entries)`, status: 'complete' })
  emit({ kind: 'reasoning', label: 'Planning a safe workspace patch', status: 'running' })
  const prompt = buildLocalExecutorPrompt({
    goal,
    workspaceContext: renderProjectContext(context),
    previousAttempts: '',
    validationCommands: ''
  })
  const generated = await provider.send(prompt, { model, signal }, () => {})
  emit({ kind: 'reasoning', label: 'Workspace patch planned', status: 'complete' })
  emit({ kind: 'file', label: 'Applying scoped file changes', status: 'running' })
  const attempt = await executeLocalExecutorAttempt({
    workspaceDir,
    rawOutput: generated.text,
    goal,
    signal,
    revertOnNoCommit: false
  })
  if (!attempt.action) {
    throw new Error(attempt.errors[0] ?? 'The local model did not produce a safe workspace patch.')
  }
  for (const file of attempt.changedFiles) {
    emit({ kind: 'file', label: file, detail: 'Changed', status: 'complete' })
  }
  for (const command of attempt.commandResults) {
    emit({
      kind: 'command',
      label: command.cmd,
      detail: command.passed ? 'Passed' : command.error ?? 'Failed',
      status: command.passed ? 'complete' : 'error'
    })
  }
  const validation = attempt.commandResults.length
    ? `${attempt.commandResults.filter((item) => item.passed).length}/${attempt.commandResults.length} checks passed`
    : 'No validation command was available'
  const files = attempt.changedFiles.length
    ? `\n\nChanged files:\n${attempt.changedFiles.map((file) => `- ${file}`).join('\n')}`
    : ''
  const text = `${attempt.action.summary}\n\n${validation}.${files}`.trim()
  onToken(text)
  return {
    text,
    usage: generated.usage,
    model: generated.model,
    raw: { score: attempt.score, errors: attempt.errors }
  }
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
  try {
    const prompt = buildOlderSummaryPrompt(window.older, cached.summary)
    const res = await sendMetaPrompt(providerId, model, prompt, signal)
    const summary = res.text.trim()
    if (summary) {
      setContextSummary(sessionId, summary, window.older.length)
      return summary
    }
  } catch (err) {
    console.error('[registry] older-context summary failed — using recent turns only:', err)
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
  ipcMain.handle('chat:providers', () => describeProviders())

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
    let storedAttachments: StoredChatAttachment[] = []
    if (args.attachments?.length) {
      if (!sessionId) return { ok: false, error: 'attachments require a persisted chat session' }
      try {
        storedAttachments = await storeChatAttachments(sessionId, args.requestId, args.attachments)
      } catch (err) {
        return { ok: false, error: `Could not store attachments: ${err instanceof Error ? err.message : String(err)}` }
      }
    }

    // Phase 14.2 conversation memory: load the session's PRIOR messages BEFORE
    // persisting the new one, so the provider actually receives the conversation
    // (the visible chat truly remembers prior turns). Strictly per-session — no
    // cross-chat / cross-project leakage is possible since only this session's
    // rows are read.
    let prior: ConvMessage[] = []
    if (sessionId) {
      try {
        prior = toConv(getSessionMessages(sessionId))
      } catch (err) {
        console.error('[registry] failed to load session context:', err)
      }
      try {
        addMessage(sessionId, 'user', args.prompt, args.providerId, args.model, storedAttachments)
      } catch (err) {
        console.error('[registry] failed to persist user message:', err)
      }
    }

    const sender = event.sender
    const controller = new AbortController()
    const requestStartedAt = Date.now()
    activeRequests.set(args.requestId, controller)
    try {
      // Opt-in repo context (Phase 6): a bounded digest the PROVIDER sees — the
      // stored user message and the usage event stay the clean typed prompt. A
      // digest failure never blocks the send.
      let digest: string | null = null
      try {
        const digestSettings = getDigestSettings()
        if (args.includeDigest === true && digestSettings.enabled) {
          digest = await buildDigest({
            ...digestSettings,
            workingDir: workspaceContext?.projectPath || digestSettings.workingDir
          })
        }
      } catch (err) {
        console.error('[registry] repo digest failed — sending without context:', err)
      }

      // If the session is long, compress the older turns into a cached summary
      // (a meta call — no usage_event); recent turns are sent verbatim.
      let summary: string | null = null
      if (sessionId && prior.length > 0) {
        summary = await ensureOlderSummary(sessionId, prior, args.providerId, args.model, controller.signal)
      }

      const localAttachmentContext = args.providerId === 'local'
        ? await inlineTextAttachmentContext(storedAttachments)
        : ''
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
          : `You are Akorith's project coding agent. Work directly in the current working directory. Inspect the project, make the requested file changes, and run relevant checks. Complete the task instead of only describing what should be done. Never push or expose secrets.${workspaceTools ? `\n\n${workspaceTools}` : ''}\n\n`
        : ''
      const promptForProvider = `${workspaceInstruction}${built.prompt}`
      const changesBefore = workspaceContext?.projectPath && args.intent !== 'plan'
        ? await summarizeGitChanges(workspaceContext.projectPath).catch(() => null)
        : null
      const observation = startProviderObservation(args, provider, workspaceContext?.projectPath)
      let result: SendResult
      const emitActivity = (activity: ProviderActivity): void => {
        if (!sender.isDestroyed()) {
          sender.send('chat:activity', {
            requestId: args.requestId,
            ...cleanActivity(activity),
            timestamp: Date.now()
          })
        }
      }
      try {
        emitActivity({ kind: 'status', label: 'Starting the selected model', status: 'running' })
        const onToken = (token: string): void => {
            if (!sender.isDestroyed()) {
              sender.send('chat:token', { requestId: args.requestId, token })
            }
          }
        result = workspaceContext?.projectPath && args.providerId === 'local' && args.intent !== 'plan'
          ? await sendWorkspaceLocal(
              provider,
              args.prompt,
              args.model,
              workspaceContext.projectPath,
              controller.signal,
              emitActivity,
              onToken
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
                onActivity: emitActivity
              },
              onToken
            )
        if (workspaceContext?.projectPath && args.intent !== 'plan') {
          const changesAfter = await summarizeGitChanges(workspaceContext.projectPath).catch(() => null)
          result = { ...result, changes: changedSince(changesBefore, changesAfter) }
        }
        emitActivity({ kind: 'status', label: 'Workspace task complete', status: 'complete' })
        completeProviderObservation(observation, result)
      } catch (err) {
        emitActivity({
          kind: 'warning',
          label: err instanceof Error ? err.message : 'Workspace task failed',
          status: 'error'
        })
        failProviderObservation(observation, err)
        throw err
      }
      if (sessionId) {
        try {
          addMessage(sessionId, 'assistant', result.text, args.providerId, result.model, [], {
            startedAt: requestStartedAt,
            endedAt: Date.now(),
            usage: result.usage,
            changes: result.changes
          })
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
            sessionId
          })
        } catch (err) {
          console.error('[registry] failed to persist exchange:', err)
        }
      }
      return { ok: true, result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      activeRequests.delete(args.requestId)
    }
  })

  ipcMain.on('chat:cancel', (_event, args: { requestId: string }) => {
    if (typeof args?.requestId !== 'string') return
    activeRequests.get(args.requestId)?.abort()
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
