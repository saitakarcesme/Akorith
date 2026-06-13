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
  ProviderAvailability,
  ProviderConfigEntry,
  ProviderInfo,
  SendResult
} from './types'
import { ClaudeProvider } from './claude'
import { ChatGPTProvider } from './chatgpt'
import { LocalProvider } from './local'

// The only place built-in provider classes are referenced. New built-ins are
// one line here; external providers need no code change at all — a config
// entry with a `module` path is loaded at runtime.
const BUILT_IN: Record<string, (entry: ProviderConfigEntry) => Provider> = {
  claude: (entry) => new ClaudeProvider(entry),
  chatgpt: (entry) => new ChatGPTProvider(entry),
  local: (entry) => new LocalProvider(entry)
}

const VALID_ID = /^[a-z0-9-]{1,32}$/
const VALID_MODEL = /^[\w.:/-]{1,64}$/
const MAX_PROMPT_CHARS = 200_000

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
 * messages, or usage_events. Phase 8 uses this for the optional ISAScore judge;
 * dashboard accounting remains reserved for normal chat:send exchanges.
 */
export async function sendMetaPrompt(
  providerId: string,
  model: string | undefined,
  prompt: string,
  signal?: AbortSignal
): Promise<SendResult> {
  if (!VALID_ID.test(providerId)) throw new Error('invalid provider id')
  if (model !== undefined && !VALID_MODEL.test(model)) throw new Error('invalid model')
  const provider = buildProviders().get(providerId)
  if (!provider) throw new Error(`provider "${providerId}" is not enabled`)
  return provider.send(prompt, { model, signal }, () => {})
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
}

type ChatSendResponse = { ok: true; result: SendResult } | { ok: false; error: string }

const activeRequests = new Map<string, AbortController>()

/** Convert stored rows to the pure conversation shape. */
function toConv(messages: { role: 'user' | 'assistant'; content: string }[]): ConvMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }))
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
      (args.includeDigest !== undefined && typeof args.includeDigest !== 'boolean')
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
        addMessage(sessionId, 'user', args.prompt, args.providerId, args.model)
      } catch (err) {
        console.error('[registry] failed to persist user message:', err)
      }
    }

    const sender = event.sender
    const controller = new AbortController()
    activeRequests.set(args.requestId, controller)
    try {
      // Opt-in repo context (Phase 6): a bounded digest the PROVIDER sees — the
      // stored user message and the usage event stay the clean typed prompt. A
      // digest failure never blocks the send.
      let digest: string | null = null
      try {
        if (args.includeDigest !== false && getDigestSettings().enabled) {
          digest = await buildDigest()
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

      const built = renderProviderPrompt({ priorMessages: prior, currentPrompt: args.prompt, summary, digest })
      const promptForProvider = built.prompt
      const result = await provider.send(
        promptForProvider,
        { model: args.model, signal: controller.signal },
        (token) => {
          if (!sender.isDestroyed()) {
            sender.send('chat:token', { requestId: args.requestId, token })
          }
        }
      )
      if (sessionId) {
        try {
          addMessage(sessionId, 'assistant', result.text, args.providerId, result.model)
          recordUsageEvent({
            providerId: args.providerId,
            model: result.model,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
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
