// Provider registry — the single source of truth for which backends exist.
// Driven entirely by loopex.config.json in the app's userData dir; the UI
// and IPC layer never assume a fixed provider set.

import { app, ipcMain } from 'electron'
import { isAbsolute, join } from 'path'
import { createRequire } from 'module'
import { loadConfig } from '../config'
import { addMessage, recordUsageEvent, sessionExists } from '../db'
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

async function describeProviders(): Promise<ProviderInfo[]> {
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
}

type ChatSendResponse = { ok: true; result: SendResult } | { ok: false; error: string }

const activeRequests = new Map<string, AbortController>()

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
      (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !/^[\w-]{1,64}$/.test(args.sessionId)))
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
    if (sessionId) {
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
      const result = await provider.send(
        args.prompt,
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

  // TODO(phase 6): router — pick a provider by kind/cost using SendResult.usage.
}
