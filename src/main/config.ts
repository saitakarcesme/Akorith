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

export interface LocalProviderSettings {
  enabled: boolean
  baseUrl: string
  autoStart: boolean
  exposeLan: boolean
  lanDiscovery: boolean
  ollamaHost?: string
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

export interface LoopexConfig {
  providers: Record<string, ProviderConfigEntry>
  bridge?: Partial<BridgeSettings>
  router?: Partial<RouterSettings>
  digest?: Partial<DigestSettings>
  test?: Partial<TestLabSettings>
  isascore?: Partial<IsaScoreSettings>
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
  isascore: DEFAULT_ISASCORE
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

export function setBridgeAutoEnter(autoEnter: boolean): BridgeSettings {
  const config = loadConfig()
  config.bridge = { ...config.bridge, autoEnter }
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
  return { autoEnter }
}

export function getLocalProviderSettings(): LocalProviderSettings {
  const entry = loadConfig().providers.local ?? DEFAULT_LOCAL_PROVIDER
  const ollamaHost = normalizeOllamaHost(entry.ollamaHost)
  return {
    enabled: entry.enabled !== false,
    baseUrl: normalizeBaseUrl(entry.baseUrl),
    autoStart: entry.autoStart !== false,
    exposeLan: entry.exposeLan !== false,
    lanDiscovery: entry.lanDiscovery !== false,
    ...(ollamaHost ? { ollamaHost } : {})
  }
}

export function setLocalProviderSettings(patch: Partial<LocalProviderSettings>): LocalProviderSettings {
  const config = loadConfig()
  const current = getLocalProviderSettings()
  const ollamaHost = patch.ollamaHost === undefined ? current.ollamaHost : normalizeOllamaHost(patch.ollamaHost)
  const next: LocalProviderSettings = {
    ...current,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    baseUrl: patch.baseUrl === undefined ? current.baseUrl : normalizeBaseUrl(patch.baseUrl, current.baseUrl),
    autoStart: typeof patch.autoStart === 'boolean' ? patch.autoStart : current.autoStart,
    exposeLan: typeof patch.exposeLan === 'boolean' ? patch.exposeLan : current.exposeLan,
    lanDiscovery: typeof patch.lanDiscovery === 'boolean' ? patch.lanDiscovery : current.lanDiscovery,
    ...(ollamaHost ? { ollamaHost } : {})
  }
  config.providers = {
    ...config.providers,
    local: next
  }
  if (!ollamaHost) delete config.providers.local.ollamaHost
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
