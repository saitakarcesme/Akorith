// Model router (Phase 6) — SUGGEST ONLY. It proposes a provider/model for a
// task's difficulty and warns when recorded subscription usage is high. It
// NEVER switches providers on its own: the renderer shows the suggestion and
// the user accepts or ignores it. Every send still goes through chat:send with
// the user's chosen selection.
//
// The difficulty classifier runs on a LOCAL Ollama model (a cheap meta-task)
// and is called DIRECTLY here — never through chat:send — so it never writes a
// user-facing usage_event and never burns subscription tokens. If no local
// model is available it falls back to a rule-based heuristic.

import { ipcMain } from 'electron'
import { loadConfig, getRouterSettings, type RouterTier } from './config'
import { recentUsageByProvider } from './db'
import { describeProviders } from './providers/registry'
import type { ProviderInfo } from './providers/types'

const MAX_PROMPT_CHARS = 200_000
const CLASSIFY_PROMPT_CHARS = 4_000 // the classifier only needs the gist
const CLASSIFY_TIMEOUT_MS = 20_000

const RANK: Record<RouterTier, string> = { Asker: 'Soldier', Albay: 'Colonel', General: 'General' }
const TIER_DESC: Record<RouterTier, string> = {
  Asker: 'trivial / mechanical',
  Albay: 'moderate',
  General: 'hard / complex / large'
}
// Degradation preference per tier when the mapped provider is unavailable.
const PREF: Record<RouterTier, string[]> = {
  Asker: ['local', 'chatgpt', 'claude'],
  Albay: ['chatgpt', 'claude', 'local'],
  General: ['claude', 'chatgpt', 'local']
}

export interface RouterSuggestion {
  tier: RouterTier
  rank: string
  classifiedBy: 'model' | 'heuristic'
  classifierModel?: string
  providerId: string
  providerLabel: string
  model?: string
  available: boolean
  degraded: boolean
  reason: string
  /** Usage-based limit warning (never an official plan limit). */
  warning?: string
}

type SuggestResponse = { ok: true; suggestion: RouterSuggestion } | { ok: false; error: string }

function localBaseUrl(): string {
  return loadConfig().providers.local?.baseUrl?.replace(/\/+$/, '') ?? 'http://localhost:11434'
}

function pickClassifierModel(configured: string | undefined, installed: string[]): string | undefined {
  if (configured && installed.includes(configured)) return configured
  return installed[0]
}

const CLASSIFY_SYSTEM = `You classify a software task's difficulty into EXACTLY one tier:
- Asker: trivial or mechanical (rename, typo, one-liner, a simple question).
- Albay: moderate (a single function/file feature, ordinary debugging).
- General: hard, complex, or large (multi-file refactor, architecture, tricky bug, big feature).
Reply with ONLY one word: Asker, Albay, or General.`

function parseTier(text: string): RouterTier | null {
  const m = text.match(/\b(asker|albay|general)\b/i)
  if (!m) return null
  const t = m[1].toLowerCase()
  return t === 'asker' ? 'Asker' : t === 'albay' ? 'Albay' : 'General'
}

/** Classify on a local Ollama model. Throws on any failure (caller falls back). */
async function classifyWithOllama(baseUrl: string, model: string, prompt: string): Promise<RouterTier> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: CLASSIFY_SYSTEM },
        { role: 'user', content: prompt.slice(0, CLASSIFY_PROMPT_CHARS) }
      ],
      stream: false,
      options: { temperature: 0 }
    }),
    signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`classifier HTTP ${res.status}`)
  const body = (await res.json()) as { message?: { content?: string } }
  const tier = parseTier(body.message?.content ?? '')
  if (!tier) throw new Error('classifier returned no recognizable tier')
  return tier
}

/** Rule-based fallback: length + keywords + file mentions + code fences. */
function heuristicTier(prompt: string): RouterTier {
  const text = prompt.toLowerCase()
  let score = 0
  if (prompt.length > 600) score += 2
  else if (prompt.length > 200) score += 1

  const fileMentions = (prompt.match(/[\w./-]+\.(ts|tsx|js|jsx|py|json|md|css|html|go|rs|java|c|cpp|h|sql)\b/g) ?? [])
    .length
  if (fileMentions >= 2) score += 2
  else if (fileMentions === 1) score += 1

  if (/refactor|architect|redesign|migrat|across|end-to-end|entire|whole codebase|multiple files|rewrite/.test(text))
    score += 2
  if (/\bbug\b|\bdebug\b|implement|add a|create a|build a|optimiz/.test(text)) score += 1
  if (/```/.test(prompt)) score += 1

  if (score >= 4) return 'General'
  if (score >= 2) return 'Albay'
  return 'Asker'
}

function labelOf(id: string, infos: ProviderInfo[]): string {
  return infos.find((i) => i.id === id)?.label ?? id
}

function pickAvailable(tier: RouterTier, available: ProviderInfo[]): ProviderInfo | undefined {
  for (const id of PREF[tier]) {
    const hit = available.find((i) => i.id === id)
    if (hit) return hit
  }
  return available[0]
}

function exceeds(
  recent: { events: number; tokens: number; costUsd: number },
  t: { costUsd?: number; events?: number; tokens?: number }
): boolean {
  return (
    (t.costUsd !== undefined && recent.costUsd >= t.costUsd) ||
    (t.events !== undefined && recent.events >= t.events) ||
    (t.tokens !== undefined && recent.tokens >= t.tokens)
  )
}

export async function suggest(prompt: string): Promise<RouterSuggestion> {
  const router = getRouterSettings()
  const infos = await describeProviders()
  const available = infos.filter((i) => i.available.ok)
  const availableIds = new Set(available.map((i) => i.id))

  // 1. Classify difficulty (local meta-task; never a usage_event).
  const localInfo = available.find((i) => i.id === 'local')
  let tier: RouterTier
  let classifiedBy: 'model' | 'heuristic' = 'heuristic'
  let classifierModel: string | undefined
  const chosen = localInfo ? pickClassifierModel(router.classifierModel, localInfo.models) : undefined
  if (localInfo && chosen) {
    try {
      tier = await classifyWithOllama(localBaseUrl(), chosen, prompt)
      classifiedBy = 'model'
      classifierModel = chosen
    } catch {
      tier = heuristicTier(prompt)
    }
  } else {
    tier = heuristicTier(prompt)
  }

  // 2. Map tier → provider/model (config-driven), degrade to best available.
  const mapped = router.tierMap[tier] ?? { providerId: '' }
  let providerId = mapped.providerId
  let model = mapped.model
  let degraded = false
  const notes: string[] = []

  if (!availableIds.has(providerId)) {
    const fallback = pickAvailable(tier, available)
    if (fallback) {
      notes.push(`${labelOf(providerId, infos)} unavailable → ${fallback.label}`)
      providerId = fallback.id
      model = undefined
      degraded = true
    } else {
      notes.push('no providers available')
    }
  }

  // 3. Limit awareness — WARN ONLY, based on Akorith's own recorded usage.
  let warning: string | undefined
  const isSubscription = providerId !== 'local'
  if (isSubscription) {
    const since = Date.now() - router.warnThresholds.windowHours * 3_600_000
    const recent = recentUsageByProvider(since)[providerId]
    if (recent && exceeds(recent, router.warnThresholds)) {
      warning =
        `High recent ${labelOf(providerId, infos)} usage in the last ${router.warnThresholds.windowHours}h ` +
        `(${recent.events} sends, ${recent.tokens} tok, $${recent.costUsd.toFixed(2)}). ` +
        `Based on usage recorded in Akorith, not your official plan limit.`
      // Nudge (not switch) Asker/Albay toward local to spare the subscription.
      if (tier !== 'General' && availableIds.has('local')) {
        notes.push('nudged to Local to spare subscription usage')
        providerId = 'local'
        model = router.tierMap.Asker?.model
        degraded = true
      }
    }
  }

  const finalInfo = infos.find((i) => i.id === providerId)
  const reason = `${TIER_DESC[tier]} task${notes.length ? ' — ' + notes.join('; ') : ''}`
  return {
    tier,
    rank: RANK[tier],
    classifiedBy,
    classifierModel,
    providerId,
    providerLabel: finalInfo?.label ?? providerId,
    model: model ?? finalInfo?.models[0],
    available: availableIds.has(providerId),
    degraded,
    reason,
    warning
  }
}

export function registerRouterIpc(): void {
  ipcMain.handle('router:suggest', async (_event, args: { prompt: string }): Promise<SuggestResponse> => {
    if (typeof args?.prompt !== 'string' || args.prompt.length === 0 || args.prompt.length > MAX_PROMPT_CHARS) {
      return { ok: false, error: 'invalid router:suggest payload' }
    }
    try {
      return { ok: true, suggestion: await suggest(args.prompt) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
