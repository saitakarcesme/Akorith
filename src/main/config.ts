// loopex.config.json — single home for reading/writing user config.
// Lives in Electron's userData dir; created with defaults on first run.

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ProviderConfigEntry } from './providers/types'

export interface BridgeSettings {
  /** Append Enter after a bridged send so the CLI executes immediately.
   *  Default OFF — text lands at the prompt and waits. */
  autoEnter: boolean
}

/** Phase 33.13: a saved remote Ollama endpoint. Akorith stores only this
 *  connection config — never secrets. Reaching a remote PC across networks is
 *  the user's responsibility (Tailscale/VPN/LAN/SSH tunnel); we just remember
 *  the endpoints to try and their last health result. */
export interface OllamaRemoteProfile {
  id: string
  name: string
  baseUrl: string
  /** Lower runs first during auto-connect. */
  priority: number
  enabled: boolean
  /** Optional free-text hint, e.g. "Tailscale" or "home LAN". */
  networkHint?: string
  lastStatus?: 'ok' | 'error' | 'unknown'
  lastError?: string
  lastModelCount?: number
  lastConnectedAt?: number
  lastCheckedAt?: number
}

export interface LocalProviderSettings {
  enabled: boolean
  baseUrl: string
  autoStart: boolean
  exposeLan: boolean
  lanDiscovery: boolean
  ollamaHost?: string
  /** Phase 33.13: saved remote endpoints tried (by priority) on auto-connect. */
  remoteProfiles?: OllamaRemoteProfile[]
  /** Phase 33.14: last endpoint that answered, cached to try first next time. */
  lastSuccessfulBaseUrl?: string
}

/** UI color theme (Phase 15). Mirrored here so the main-process splash window
 *  can paint the matching background before the renderer (and its localStorage)
 *  exists. Default 'dark'. */
export type AppTheme = 'dark' | 'light'

/** Difficulty tiers for the suggest-only router (Phase 6). */
export type RouterTier = 'Asker' | 'Albay' | 'General'

export interface TierMapEntry {
  providerId: string
  /** Optional model override; omitted = the provider's default. */
  model?: string
}

export interface RouterWarnThresholds {
  /** Rolling window over which recorded usage is summed. */
  windowHours: number
  costUsd?: number
  events?: number
  tokens?: number
}

export interface RouterSettings {
  /** Ollama model used for classification. Empty/missing → first installed. */
  classifierModel?: string
  /** tier → provider/model. Edited freely; never hardcoded in router logic. */
  tierMap: Record<RouterTier, TierMapEntry>
  /** Warn (never switch) when recorded subscription usage exceeds these. */
  warnThresholds: RouterWarnThresholds
}

export interface DigestSettings {
  /** "Include repo context" toggle, persisted. Default OFF. */
  enabled: boolean
  /** Repo to digest. Empty/missing → the app's cwd. */
  workingDir?: string
  /** Hard cap on the embedded `git diff` body. */
  maxDiffBytes: number
  /** Hard cap on the whole digest block. */
  maxTotalBytes: number
  /** Depth limit for the file tree. */
  treeDepth: number
}

export interface TestLabSettings {
  /** Source repo to test. Empty → fall back to digest.workingDir, then app cwd. */
  sourceRepo?: string
  /** Install deps in the sandbox before running (when a lockfile is present). */
  installDeps: boolean
  /** Per-phase (install, test) timeout; the whole process tree is killed on hit. */
  timeoutMs: number
  /** Ephemeral sandboxes to retain for debugging; older ones are pruned. */
  keepLastN: number
  /** Default provider for the test page's chat (a local model is the intent). */
  defaultProviderId: string
}

export interface IsaScoreWeights {
  tests: number
  speed: number
  tokens: number
  quality: number
}

export interface IsaScoreSettings {
  /** Dimensional score weights; active dimensions are re-normalized at scoring time. */
  weights: IsaScoreWeights
}

/** Phase 35: optional local controller HTTP API. Disabled by default,
 *  loopback-only, token-protected, read-only. Stored in local config (not an OS
 *  keychain) — documented in docs/controller-api.md. */
export interface ControllerSettings {
  enabled: boolean
  host: string
  port: number
  /** Bearer token; empty means "generate on first start". Never logged. */
  token: string
  /** Must be explicitly true to bind a non-loopback host. */
  allowLan: boolean
  /** Phase 35 keeps the API read-only; kept for forward config compatibility. */
  readOnly: boolean
  sseEnabled: boolean
  allowedOrigins?: string[]
  lastStartedAt?: number
  lastError?: string
}

/** Phase 35: plugin foundation enable/disable state (config-only; never executes). */
export interface PluginSettings {
  /** Plugin ids the user has explicitly disabled. Built-ins default enabled. */
  disabled: string[]
  /** Optional Chroma memory endpoint placeholder (no ingestion in Phase 35). */
  chromaEndpoint?: string
}

/** Phase 36: a remote Akorith Controller used as a GPU/runtime telemetry source —
 *  e.g. the PC running Ollama, reachable over Tailscale/VPN/LAN. Token required and
 *  stored in local config (not an OS keychain). Never logged. */
export interface RemoteTelemetryProfile {
  id: string
  name: string
  baseUrl: string
  token: string
  enabled: boolean
  priority: number
  lastStatus?: 'ok' | 'error'
  lastError?: string
  lastCheckedAt?: number
}

export interface TelemetrySettings {
  profiles: RemoteTelemetryProfile[]
}

/** Phase 39: user-entered subscription limit labels (NOT live remaining values —
 *  Akorith has no access to those). Plain strings the user fills in to compare
 *  against Akorith's own recorded in-app usage. No secrets. */
export interface UsageLimitConfig {
  claude5h?: string
  claudeWeekly?: string
  codex5h?: string
  codexWeekly?: string
  notes?: string
}

export interface LoopexConfig {
  providers: Record<string, ProviderConfigEntry>
  bridge?: Partial<BridgeSettings>
  router?: Partial<RouterSettings>
  digest?: Partial<DigestSettings>
  test?: Partial<TestLabSettings>
  isascore?: Partial<IsaScoreSettings>
  controller?: Partial<ControllerSettings>
  plugins?: Partial<PluginSettings>
  telemetry?: Partial<TelemetrySettings>
  usageLimits?: Partial<UsageLimitConfig>
  /** Last theme selected in the renderer; read by the splash at startup. */
  theme?: AppTheme
}

export const DEFAULT_TEST: TestLabSettings = {
  sourceRepo: '',
  installDeps: true,
  timeoutMs: 120_000,
  keepLastN: 3,
  defaultProviderId: 'local'
}

export const DEFAULT_ISASCORE: IsaScoreSettings = {
  weights: {
    tests: 0.55,
    speed: 0.15,
    tokens: 0.15,
    quality: 0.15
  }
}

export const DEFAULT_ROUTER: RouterSettings = {
  classifierModel: '',
  tierMap: {
    Asker: { providerId: 'local' },
    Albay: { providerId: 'chatgpt' },
    General: { providerId: 'claude' }
  },
  warnThresholds: { windowHours: 24, costUsd: 5, events: 50 }
}

export const DEFAULT_DIGEST: DigestSettings = {
  enabled: false,
  workingDir: '',
  maxDiffBytes: 12_000,
  maxTotalBytes: 24_000,
  treeDepth: 3
}

export const DEFAULT_LOCAL_PROVIDER: LocalProviderSettings = {
  enabled: true,
  baseUrl: 'http://localhost:11434',
  autoStart: true,
  exposeLan: true,
  lanDiscovery: true
}

export const DEFAULT_CONTROLLER: ControllerSettings = {
  enabled: false,
  host: '127.0.0.1',
  port: 47832,
  token: '',
  allowLan: false,
  readOnly: true,
  sseEnabled: true
}

export const DEFAULT_PLUGINS: PluginSettings = {
  disabled: []
}

export const DEFAULT_TELEMETRY: TelemetrySettings = {
  profiles: []
}

export const DEFAULT_CONFIG: LoopexConfig = {
  providers: {
    claude: { enabled: true },
    chatgpt: { enabled: true },
    local: DEFAULT_LOCAL_PROVIDER
  },
  bridge: { autoEnter: false },
  router: DEFAULT_ROUTER,
  digest: DEFAULT_DIGEST,
  test: DEFAULT_TEST,
  isascore: DEFAULT_ISASCORE,
  controller: DEFAULT_CONTROLLER,
  plugins: DEFAULT_PLUGINS,
  telemetry: DEFAULT_TELEMETRY
}

export function normalizeBaseUrl(value: unknown, fallback = DEFAULT_LOCAL_PROVIDER.baseUrl): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed || trimmed.length > 300 || /[\0\r\n]/.test(trimmed)) return fallback
  try {
    const url = new URL(trimmed)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return fallback
    return trimmed
  } catch {
    return fallback
  }
}

function normalizeOllamaHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 200 || /[\0\r\n]/.test(trimmed)) return undefined
  return /^[a-z0-9_.:[\]-]+$/i.test(trimmed) ? trimmed : undefined
}

function safeString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max || /[\0\r\n]/.test(trimmed)) return undefined
  return trimmed
}

/** Validate/normalize an array of remote Ollama profiles read from disk or sent
 *  by the renderer. Drops anything without a valid http(s) baseUrl. Caps the
 *  list so a malformed config can't balloon. */
export function sanitizeRemoteProfiles(value: unknown): OllamaRemoteProfile[] {
  if (!Array.isArray(value)) return []
  const out: OllamaRemoteProfile[] = []
  for (const raw of value.slice(0, 24)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const baseUrl = normalizeBaseUrl(entry.baseUrl, '')
    if (!baseUrl) continue
    const id = safeString(entry.id, 64) ?? `rp-${out.length}-${baseUrl.length}`
    const status = entry.lastStatus === 'ok' || entry.lastStatus === 'error' ? entry.lastStatus : undefined
    out.push({
      id,
      name: safeString(entry.name, 80) ?? 'Remote Ollama',
      baseUrl,
      priority: Number.isFinite(entry.priority) ? Math.max(0, Math.trunc(entry.priority as number)) : out.length,
      enabled: entry.enabled !== false,
      ...(safeString(entry.networkHint, 80) ? { networkHint: safeString(entry.networkHint, 80) } : {}),
      ...(status ? { lastStatus: status } : {}),
      ...(safeString(entry.lastError, 400) ? { lastError: safeString(entry.lastError, 400) } : {}),
      ...(Number.isFinite(entry.lastModelCount) ? { lastModelCount: Math.max(0, Math.trunc(entry.lastModelCount as number)) } : {}),
      ...(Number.isFinite(entry.lastConnectedAt) ? { lastConnectedAt: entry.lastConnectedAt as number } : {}),
      ...(Number.isFinite(entry.lastCheckedAt) ? { lastCheckedAt: entry.lastCheckedAt as number } : {})
    })
  }
  return out
}

export function configPath(): string {
  return join(app.getPath('userData'), 'loopex.config.json')
}

export function loadConfig(): LoopexConfig {
  const file = configPath()
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8')
    return DEFAULT_CONFIG
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as LoopexConfig
    if (!parsed || typeof parsed.providers !== 'object' || parsed.providers === null) {
      throw new Error('missing "providers" object')
    }
    return parsed
  } catch (err) {
    console.error(`[config] invalid ${file} — falling back to defaults:`, err)
    return DEFAULT_CONFIG
  }
}

export function getBridgeSettings(): BridgeSettings {
  return { autoEnter: loadConfig().bridge?.autoEnter ?? false }
}

// ---- Phase 35: controller API + plugin settings ----

function safePort(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : fallback
}

function safeHost(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CONTROLLER.host
  const trimmed = value.trim()
  // hostnames, IPv4, or bracketless IPv6 — no spaces/control chars/paths.
  if (!trimmed || trimmed.length > 120 || /[\s/\\\0]/.test(trimmed)) return DEFAULT_CONTROLLER.host
  return trimmed
}

export function getControllerSettings(): ControllerSettings {
  const c = loadConfig().controller ?? {}
  const origins = Array.isArray(c.allowedOrigins)
    ? c.allowedOrigins.filter((o): o is string => typeof o === 'string').slice(0, 16)
    : undefined
  return {
    enabled: c.enabled === true,
    host: safeHost(c.host),
    port: safePort(c.port, DEFAULT_CONTROLLER.port),
    token: typeof c.token === 'string' ? c.token : '',
    allowLan: c.allowLan === true,
    readOnly: c.readOnly !== false, // read-only unless explicitly false (Phase 35 keeps true)
    sseEnabled: c.sseEnabled !== false,
    ...(origins && origins.length ? { allowedOrigins: origins } : {}),
    ...(typeof c.lastStartedAt === 'number' ? { lastStartedAt: c.lastStartedAt } : {}),
    ...(typeof c.lastError === 'string' ? { lastError: c.lastError } : {})
  }
}

export function setControllerSettings(patch: Partial<ControllerSettings>): ControllerSettings {
  const config = loadConfig()
  const current = getControllerSettings()
  const next: ControllerSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    host: patch.host === undefined ? current.host : safeHost(patch.host),
    port: patch.port === undefined ? current.port : safePort(patch.port, current.port),
    token: typeof patch.token === 'string' ? patch.token : current.token,
    allowLan: typeof patch.allowLan === 'boolean' ? patch.allowLan : current.allowLan,
    readOnly: typeof patch.readOnly === 'boolean' ? patch.readOnly : current.readOnly,
    sseEnabled: typeof patch.sseEnabled === 'boolean' ? patch.sseEnabled : current.sseEnabled,
    ...(patch.allowedOrigins !== undefined
      ? { allowedOrigins: patch.allowedOrigins }
      : current.allowedOrigins
        ? { allowedOrigins: current.allowedOrigins }
        : {}),
    ...(patch.lastStartedAt !== undefined
      ? { lastStartedAt: patch.lastStartedAt }
      : current.lastStartedAt
        ? { lastStartedAt: current.lastStartedAt }
        : {}),
    ...(patch.lastError !== undefined
      ? patch.lastError
        ? { lastError: patch.lastError }
        : {}
      : current.lastError
        ? { lastError: current.lastError }
        : {})
  }
  config.controller = next
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
  return next
}

export function getPluginSettings(): PluginSettings {
  const p = loadConfig().plugins ?? {}
  const disabled = Array.isArray(p.disabled)
    ? p.disabled.filter((id): id is string => typeof id === 'string').slice(0, 128)
    : []
  const chromaEndpoint = typeof p.chromaEndpoint === 'string' ? p.chromaEndpoint.trim() : undefined
  return { disabled, ...(chromaEndpoint ? { chromaEndpoint } : {}) }
}

export function setPluginSettings(patch: Partial<PluginSettings>): PluginSettings {
  const config = loadConfig()
  const current = getPluginSettings()
  const next: PluginSettings = {
    disabled: Array.isArray(patch.disabled)
      ? [...new Set(patch.disabled.filter((id) => typeof id === 'string'))].slice(0, 128)
      : current.disabled,
    ...(patch.chromaEndpoint !== undefined
      ? patch.chromaEndpoint
        ? { chromaEndpoint: patch.chromaEndpoint.trim() }
        : {}
      : current.chromaEndpoint
        ? { chromaEndpoint: current.chromaEndpoint }
        : {})
  }
  config.plugins = next
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
  return next
}

// ---- Phase 36: remote telemetry profiles (GPU/runtime via remote controller) ----

export function sanitizeTelemetryProfiles(value: unknown): RemoteTelemetryProfile[] {
  if (!Array.isArray(value)) return []
  const out: RemoteTelemetryProfile[] = []
  for (const raw of value.slice(0, 24)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const baseUrl = normalizeBaseUrl(entry.baseUrl, '')
    if (!baseUrl) continue
    const status = entry.lastStatus === 'ok' || entry.lastStatus === 'error' ? entry.lastStatus : undefined
    out.push({
      id: safeString(entry.id, 64) ?? `rt-${out.length}-${baseUrl.length}`,
      name: safeString(entry.name, 80) ?? 'Remote runtime',
      baseUrl,
      token: typeof entry.token === 'string' ? entry.token : '',
      enabled: entry.enabled !== false,
      priority: Number.isFinite(entry.priority) ? Math.max(0, Math.trunc(entry.priority as number)) : out.length,
      ...(status ? { lastStatus: status } : {}),
      ...(safeString(entry.lastError, 400) ? { lastError: safeString(entry.lastError, 400) } : {}),
      ...(Number.isFinite(entry.lastCheckedAt) ? { lastCheckedAt: entry.lastCheckedAt as number } : {})
    })
  }
  return out
}

export function getTelemetrySettings(): TelemetrySettings {
  return { profiles: sanitizeTelemetryProfiles(loadConfig().telemetry?.profiles) }
}

export function setTelemetrySettings(patch: Partial<TelemetrySettings>): TelemetrySettings {
  const config = loadConfig()
  const current = getTelemetrySettings()
  const profiles = patch.profiles === undefined ? current.profiles : sanitizeTelemetryProfiles(patch.profiles)
  config.telemetry = { profiles }
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
  return { profiles }
}

// ---- Phase 39: usage-limit labels (user-entered; no secrets) ----

function safeLimitLabel(value: unknown): string | undefined {
  return safeString(value, 80)
}

export function getUsageLimitConfig(): UsageLimitConfig {
  const u = loadConfig().usageLimits ?? {}
  return {
    ...(safeLimitLabel(u.claude5h) ? { claude5h: safeLimitLabel(u.claude5h) } : {}),
    ...(safeLimitLabel(u.claudeWeekly) ? { claudeWeekly: safeLimitLabel(u.claudeWeekly) } : {}),
    ...(safeLimitLabel(u.codex5h) ? { codex5h: safeLimitLabel(u.codex5h) } : {}),
    ...(safeLimitLabel(u.codexWeekly) ? { codexWeekly: safeLimitLabel(u.codexWeekly) } : {}),
    ...(safeString(u.notes, 400) ? { notes: safeString(u.notes, 400) } : {})
  }
}

export function setUsageLimitConfig(patch: Partial<UsageLimitConfig>): UsageLimitConfig {
  const config = loadConfig()
  const current = getUsageLimitConfig()
  const pick = (key: keyof UsageLimitConfig, max = 80): string | undefined => {
    if (patch[key] === undefined) return current[key]
    const v = safeString(patch[key], max)
    return v || undefined
  }
  const next: UsageLimitConfig = {
    ...(pick('claude5h') ? { claude5h: pick('claude5h') } : {}),
    ...(pick('claudeWeekly') ? { claudeWeekly: pick('claudeWeekly') } : {}),
    ...(pick('codex5h') ? { codex5h: pick('codex5h') } : {}),
    ...(pick('codexWeekly') ? { codexWeekly: pick('codexWeekly') } : {}),
    ...(pick('notes', 400) ? { notes: pick('notes', 400) } : {})
  }
  config.usageLimits = next
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
  return next
}

export function setBridgeAutoEnter(autoEnter: boolean): BridgeSettings {
  const config = loadConfig()
  config.bridge = { ...config.bridge, autoEnter }
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
  return { autoEnter }
}

export function getLocalProviderSettings(): LocalProviderSettings {
  const entry = loadConfig().providers.local ?? DEFAULT_LOCAL_PROVIDER
  const ollamaHost = normalizeOllamaHost(entry.ollamaHost)
  const remoteProfiles = sanitizeRemoteProfiles(entry.remoteProfiles)
  const lastSuccessfulBaseUrl = normalizeBaseUrl(entry.lastSuccessfulBaseUrl, '')
  return {
    enabled: entry.enabled !== false,
    baseUrl: normalizeBaseUrl(entry.baseUrl),
    autoStart: entry.autoStart !== false,
    exposeLan: entry.exposeLan !== false,
    lanDiscovery: entry.lanDiscovery !== false,
    ...(ollamaHost ? { ollamaHost } : {}),
    ...(remoteProfiles.length ? { remoteProfiles } : {}),
    ...(lastSuccessfulBaseUrl ? { lastSuccessfulBaseUrl } : {})
  }
}

export function setLocalProviderSettings(patch: Partial<LocalProviderSettings>): LocalProviderSettings {
  const config = loadConfig()
  const current = getLocalProviderSettings()
  const ollamaHost = patch.ollamaHost === undefined ? current.ollamaHost : normalizeOllamaHost(patch.ollamaHost)
  const remoteProfiles =
    patch.remoteProfiles === undefined ? current.remoteProfiles : sanitizeRemoteProfiles(patch.remoteProfiles)
  const lastSuccessfulBaseUrl =
    patch.lastSuccessfulBaseUrl === undefined
      ? current.lastSuccessfulBaseUrl
      : normalizeBaseUrl(patch.lastSuccessfulBaseUrl, '') || undefined
  const next: LocalProviderSettings = {
    ...current,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    baseUrl: patch.baseUrl === undefined ? current.baseUrl : normalizeBaseUrl(patch.baseUrl, current.baseUrl),
    autoStart: typeof patch.autoStart === 'boolean' ? patch.autoStart : current.autoStart,
    exposeLan: typeof patch.exposeLan === 'boolean' ? patch.exposeLan : current.exposeLan,
    lanDiscovery: typeof patch.lanDiscovery === 'boolean' ? patch.lanDiscovery : current.lanDiscovery,
    ...(ollamaHost ? { ollamaHost } : {}),
    ...(remoteProfiles && remoteProfiles.length ? { remoteProfiles } : {}),
    ...(lastSuccessfulBaseUrl ? { lastSuccessfulBaseUrl } : {})
  }
  config.providers = {
    ...config.providers,
    local: next
  }
  if (!ollamaHost) delete config.providers.local.ollamaHost
  if (!remoteProfiles || !remoteProfiles.length) delete config.providers.local.remoteProfiles
  if (!lastSuccessfulBaseUrl) delete config.providers.local.lastSuccessfulBaseUrl
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
  return next
}

// ---- theme (Phase 15; mirrored for the startup splash) ----

export function getTheme(): AppTheme {
  return loadConfig().theme === 'light' ? 'light' : 'dark'
}

export function setTheme(theme: AppTheme): AppTheme {
  const next: AppTheme = theme === 'light' ? 'light' : 'dark'
  const config = loadConfig()
  config.theme = next
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
  return next
}

// ---- router + digest settings (Phase 6) ----
// Getters merge defaults so config files written before Phase 6 still work.

export function getRouterSettings(): RouterSettings {
  const r = loadConfig().router ?? {}
  return {
    classifierModel: r.classifierModel ?? DEFAULT_ROUTER.classifierModel,
    tierMap: { ...DEFAULT_ROUTER.tierMap, ...(r.tierMap ?? {}) },
    warnThresholds: { ...DEFAULT_ROUTER.warnThresholds, ...(r.warnThresholds ?? {}) }
  }
}

export function getDigestSettings(): DigestSettings {
  const d = loadConfig().digest ?? {}
  return {
    enabled: d.enabled ?? DEFAULT_DIGEST.enabled,
    workingDir: d.workingDir ?? DEFAULT_DIGEST.workingDir,
    maxDiffBytes: d.maxDiffBytes ?? DEFAULT_DIGEST.maxDiffBytes,
    maxTotalBytes: d.maxTotalBytes ?? DEFAULT_DIGEST.maxTotalBytes,
    treeDepth: d.treeDepth ?? DEFAULT_DIGEST.treeDepth
  }
}

function writeDigest(patch: Partial<DigestSettings>): DigestSettings {
  const config = loadConfig()
  config.digest = { ...config.digest, ...patch }
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
  return getDigestSettings()
}

export function setDigestEnabled(enabled: boolean): DigestSettings {
  return writeDigest({ enabled })
}

export function setDigestWorkingDir(workingDir: string): DigestSettings {
  return writeDigest({ workingDir })
}

// ---- test page settings (Phase 7) ----

export function getTestSettings(): TestLabSettings {
  const config = loadConfig()
  const t = config.test ?? {}
  // Source repo defaults to the Phase 6 digest repo when the user hasn't set one.
  const sourceRepo = t.sourceRepo && t.sourceRepo.trim() ? t.sourceRepo : (config.digest?.workingDir ?? '')
  return {
    sourceRepo,
    installDeps: t.installDeps ?? DEFAULT_TEST.installDeps,
    timeoutMs: t.timeoutMs ?? DEFAULT_TEST.timeoutMs,
    keepLastN: t.keepLastN ?? DEFAULT_TEST.keepLastN,
    defaultProviderId: t.defaultProviderId ?? DEFAULT_TEST.defaultProviderId
  }
}

// ---- ISAScore settings (Phase 8) ----

export function getIsaScoreSettings(): IsaScoreSettings {
  const s = loadConfig().isascore ?? {}
  return {
    weights: {
      ...DEFAULT_ISASCORE.weights,
      ...(s.weights ?? {})
    }
  }
}

export function setTestSourceRepo(sourceRepo: string): TestLabSettings {
  const config = loadConfig()
  config.test = { ...config.test, sourceRepo }
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
  return getTestSettings()
}

export function setTestSettings(patch: Partial<TestLabSettings>): TestLabSettings {
  const config = loadConfig()
  const current = getTestSettings()
  const next: TestLabSettings = {
    sourceRepo: typeof patch.sourceRepo === 'string' ? patch.sourceRepo.slice(0, 1_000) : current.sourceRepo,
    installDeps: typeof patch.installDeps === 'boolean' ? patch.installDeps : current.installDeps,
    timeoutMs:
      typeof patch.timeoutMs === 'number' && Number.isFinite(patch.timeoutMs)
        ? Math.min(Math.max(Math.round(patch.timeoutMs), 1_000), 1_800_000)
        : current.timeoutMs,
    keepLastN:
      typeof patch.keepLastN === 'number' && Number.isFinite(patch.keepLastN)
        ? Math.min(Math.max(Math.round(patch.keepLastN), 0), 20)
        : current.keepLastN,
    defaultProviderId:
      typeof patch.defaultProviderId === 'string' && patch.defaultProviderId.trim()
        ? patch.defaultProviderId.trim().slice(0, 80)
        : current.defaultProviderId
  }
  config.test = next
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
  return getTestSettings()
}
