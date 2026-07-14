import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentAdapterInfo,
  AgentDetectionResult,
  AgentId,
  AgentRuntimeAttachment,
  AgentRuntimeSnapshot,
  AgentSession,
  AgentSessionMode,
  AgentStatus,
  BridgeSettings,
  DigestSettings,
  ControllerConfigView,
  ControllerDocs,
  ControllerStatus,
  RemoteTelemetryProfileView,
  TailscaleStatus,
  UsageLimitConfig,
  OllamaConnectionSettings,
  OllamaEndpointSuggestion,
  OllamaRemoteProfile,
  OllamaShareInfo,
  ProviderInfo,
  TestSettings
} from '../../../preload/index.d'
import type { AppTheme } from '../App'
import { CloseIcon } from './icons'
import MissionCenter from './MissionCenter'
import UpdatePanel from './UpdatePanel'

type SettingsTab = 'profile' | 'providers' | 'agents' | 'missions' | 'api' | 'update' | 'workflow' | 'test' | 'safety'

interface SettingsCenterProps {
  theme: AppTheme
  displayName: string
  providers: ProviderInfo[]
  onThemeChange: (theme: AppTheme) => void
  onDisplayNameChange: (name: string) => void
  onRefreshProviders: () => void
  onClose: () => void
}

const LOOP_REMOTE = 'https://github.com/saitakarcesme/AkorithLoop.git'
const LOOP_FOLDER = '~/Documents/AkorithLoop'

function shortEndpointLabel(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`
  } catch {
    return value
  }
}

function providerTone(id: string): string {
  const normalized = id.toLowerCase()
  if (normalized.includes('claude')) return 'tone-claude'
  if (normalized.includes('chatgpt') || normalized.includes('codex')) return 'tone-codex'
  if (normalized.includes('local') || normalized.includes('ollama')) return 'tone-local'
  return 'tone-neutral'
}

function providerShortLabel(id: string, label: string): string {
  if (id.includes('claude')) return 'Cl'
  if (id.includes('chatgpt') || id.includes('codex')) return 'Cx'
  if (id.includes('local') || id.includes('ollama')) return 'Lo'
  return label.slice(0, 2)
}

function secondsLabel(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return `${minutes}m`
}

function capabilityLabel(value: string): string {
  return value
    .split('_')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function agentStatusClass(status: AgentStatus): string {
  if (status === 'available') return 'is-ok'
  if (status === 'unknown') return 'is-info'
  if (status === 'disabled') return 'is-warning'
  return 'is-error'
}

function integrationStageLabel(value: string): string {
  return value
    .split('-')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function runtimeSummary(agent: AgentAdapterInfo): string {
  const runtime = agent.runtimeCapabilities
  const bits: string[] = []
  if (runtime.canUseExistingProvider) bits.push('existing provider active')
  if (runtime.canUseExistingTerminal) bits.push('existing terminal active')
  if (runtime.canStream) bits.push('streaming available in current runtime')
  if (runtime.canExecute) bits.push('exec available in current runtime')
  if (runtime.isPlaceholder) bits.push('AgentSession runtime is placeholder only')
  return bits.join(' / ') || 'metadata only'
}

function relativeTime(ts?: number): string {
  if (!ts) return 'not checked'
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

function dateTimeLabel(ts?: number): string {
  if (!ts) return 'n/a'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(ts))
}

function shortId(value?: string, size = 8): string {
  if (!value) return 'n/a'
  return value.length <= size + 3 ? value : `${value.slice(0, size)}...`
}

function sourceLabel(value?: string): string {
  if (!value) return 'n/a'
  const normalized = value.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts.slice(-2).join('/')
}

function placeholderModeForAgent(agent: AgentAdapterInfo): AgentSessionMode {
  if (agent.id === 'memory') return 'memory'
  if (agent.id === 'ollama') return 'chat'
  if (agent.id === 'codex') return 'exec'
  return 'terminal'
}

function observedRuntimeState(agent: AgentAdapterInfo, snapshot: AgentRuntimeSnapshot | null): string {
  if (!snapshot) return 'not checked'
  if (snapshot.activeProviderCalls.some((attachment) => attachment.agentId === agent.id)) return 'active provider call'
  if (snapshot.activePtySessions.some((attachment) => attachment.agentId === agent.id)) return 'active terminal'
  if (agent.id === 'ollama' && snapshot.ollamaStatus?.status === 'observed') return 'local runtime available'
  if (agent.id === 'opencode') return 'metadata / detection only'
  if (agent.id === 'memory') return 'future memory / skills'
  return 'idle'
}

function runtimeStateTone(state: string): string {
  if (state.includes('active') || state.includes('available')) return 'is-ok'
  if (state.includes('future') || state.includes('metadata')) return 'is-info'
  return 'is-muted'
}

function safeMetadataSummary(metadata?: Record<string, unknown>): string {
  if (!metadata) return 'no metadata'
  const blocked = /(prompt|content|text|output|secret|token|password|env|command)/i
  const parts = Object.entries(metadata)
    .filter(([key]) => !blocked.test(key))
    .slice(0, 6)
    .map(([key, value]) => {
      const rendered =
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : value === null
            ? 'null'
            : Array.isArray(value)
              ? `${value.length} item${value.length === 1 ? '' : 's'}`
              : 'object'
      return `${key}: ${rendered.slice(0, 80)}`
    })
  return parts.length ? parts.join(' / ') : 'metadata hidden by safety filter'
}

function attachmentsForSession(session: AgentSession, attachments: AgentRuntimeAttachment[]): AgentRuntimeAttachment[] {
  return attachments.filter((attachment) => attachment.sessionId === session.id)
}

export default function SettingsCenter({
  theme,
  displayName,
  providers,
  onThemeChange,
  onDisplayNameChange,
  onRefreshProviders,
  onClose
}: SettingsCenterProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile')
  // Phase 39: user-configured usage-limit labels (no secrets).
  const [limits, setLimits] = useState<UsageLimitConfig>({})
  const [limitsBusy, setLimitsBusy] = useState(false)
  const [limitsSaved, setLimitsSaved] = useState(false)
  useEffect(() => {
    void window.api.usageLimits
      .get()
      .then((view) => setLimits(view.config))
      .catch(() => setLimits({}))
  }, [])
  const saveLimits = async (): Promise<void> => {
    setLimitsBusy(true)
    try {
      const saved = await window.api.usageLimits.setConfig(limits)
      setLimits(saved)
      setLimitsSaved(true)
      setTimeout(() => setLimitsSaved(false), 2000)
    } finally {
      setLimitsBusy(false)
    }
  }
  // Phase 35: controller API state.
  const [ctrlConfig, setCtrlConfig] = useState<ControllerConfigView | null>(null)
  const [ctrlStatus, setCtrlStatus] = useState<ControllerStatus | null>(null)
  const [ctrlDocs, setCtrlDocs] = useState<ControllerDocs | null>(null)
  const [ctrlBusy, setCtrlBusy] = useState(false)
  const [ctrlToken, setCtrlToken] = useState<string | null>(null)
  const [ctrlPortDraft, setCtrlPortDraft] = useState('')
  const [ctrlNotice, setCtrlNotice] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null)
  // Phase 36: remote telemetry profiles (point at a remote controller / the PC).
  const [telProfiles, setTelProfiles] = useState<RemoteTelemetryProfileView[]>([])
  const [telTokenDrafts, setTelTokenDrafts] = useState<Record<string, string>>({})
  const [telBusy, setTelBusy] = useState(false)
  const [telNotice, setTelNotice] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null)
  const [bridgeSettings, setBridgeSettings] = useState<BridgeSettings | null>(null)
  const [digestSettings, setDigestSettings] = useState<DigestSettings | null>(null)
  const [testSettings, setTestSettings] = useState<TestSettings | null>(null)
  const [ollamaSettings, setOllamaSettings] = useState<OllamaConnectionSettings | null>(null)
  const [ollamaEndpoint, setOllamaEndpoint] = useState('http://localhost:11434')
  const [ollamaShare, setOllamaShare] = useState<OllamaShareInfo | null>(null)
  const [ollamaBusy, setOllamaBusy] = useState<'test' | 'save' | null>(null)
  const [ollamaStatus, setOllamaStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null)
  // Phase 33.14: auto-connect (configured → last → remote profiles by priority).
  const [autoConnectBusy, setAutoConnectBusy] = useState(false)
  const [autoConnectInfo, setAutoConnectInfo] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null)
  // Phase 42 (Remote Ollama): Tailscale status for away-from-home setup guidance.
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null)
  const [tsBusy, setTsBusy] = useState(false)
  const refreshTailscale = useCallback(async (): Promise<void> => {
    setTsBusy(true)
    try {
      setTailscale(await window.api.ollama.tailscaleStatus())
    } catch {
      setTailscale(null)
    } finally {
      setTsBusy(false)
    }
  }, [])
  const [digestDirDraft, setDigestDirDraft] = useState('')
  const [testSourceDraft, setTestSourceDraft] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [agentAdapters, setAgentAdapters] = useState<AgentAdapterInfo[]>([])
  const [agentDetections, setAgentDetections] = useState<Partial<Record<AgentId, AgentDetectionResult>>>({})
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([])
  const [runtimeAttachments, setRuntimeAttachments] = useState<AgentRuntimeAttachment[]>([])
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<AgentRuntimeSnapshot | null>(null)
  const [expandedAgentSessionId, setExpandedAgentSessionId] = useState<string | null>(null)
  const [agentBusy, setAgentBusy] = useState<string | null>(null)

  const loadSettings = useCallback(() => {
    void window.api.bridge.getSettings().then(setBridgeSettings).catch(() => setBridgeSettings({ autoEnter: false }))
    void window.api.digest.getSettings().then((settings) => {
      setDigestSettings(settings)
      setDigestDirDraft(settings.workingDir ?? '')
    }).catch(() => {
      setDigestSettings(null)
      setDigestDirDraft('')
    })
    void window.api.test.getSettings().then((settings) => {
      setTestSettings(settings)
      setTestSourceDraft(settings.sourceRepo ?? '')
    }).catch(() => {
      setTestSettings(null)
      setTestSourceDraft('')
    })
    void window.api.ollama.getSettings().then((settings) => {
      setOllamaSettings(settings)
      setOllamaEndpoint(settings.baseUrl)
    }).catch(() => {
      setOllamaSettings(null)
      setOllamaEndpoint('http://localhost:11434')
    })
    void window.api.ollama.getShareInfo().then(setOllamaShare).catch(() => setOllamaShare(null))
    void window.api.agent.list().then(setAgentAdapters).catch(() => setAgentAdapters([]))
    void window.api.agent.listSessions().then(setAgentSessions).catch(() => setAgentSessions([]))
    void window.api.agent.listRuntimeAttachments().then(setRuntimeAttachments).catch(() => setRuntimeAttachments([]))
    void window.api.agent.getRuntimeSnapshot().then(setRuntimeSnapshot).catch(() => setRuntimeSnapshot(null))
  }, [])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const localProvider = providers.find((provider) => provider.id === 'local')
  const shareEndpoints = ollamaShare?.endpoints ?? []
  const remoteEndpoint = shareEndpoints.find((endpoint) => endpoint.kind === 'vpn')
  const reachableEndpoint = remoteEndpoint ?? shareEndpoints.find((endpoint) => endpoint.kind === 'lan')
  const remoteReady = Boolean(reachableEndpoint)
  const remoteMessage = remoteReady
    ? `${reachableEndpoint?.label ?? 'Network endpoint'} can be used from another Akorith instance when Ollama is running on this machine.`
    : 'Start Ollama with LAN exposure or connect through VPN/Tailscale to share local models.'

  const availableProviders = useMemo(
    () => providers.filter((provider) => provider.available.ok).length,
    [providers]
  )

  const updateOllamaSetting = <K extends keyof OllamaConnectionSettings>(key: K, value: OllamaConnectionSettings[K]): void => {
    setOllamaSettings((settings) => (settings ? { ...settings, [key]: value } : settings))
  }

  const testOllamaEndpoint = async (): Promise<void> => {
    const endpoint = ollamaEndpoint.trim()
    if (!endpoint) {
      setOllamaStatus({ kind: 'error', text: 'Enter an Ollama endpoint.' })
      return
    }
    setOllamaBusy('test')
    setOllamaStatus(null)
    try {
      const result = await window.api.ollama.testEndpoint(endpoint)
      if (result.ok) {
        setOllamaEndpoint(result.baseUrl)
        setOllamaStatus({
          kind: 'ok',
          text: `Connected to ${shortEndpointLabel(result.baseUrl)} - ${result.modelCount} model${result.modelCount === 1 ? '' : 's'}`
        })
      } else {
        setOllamaStatus({ kind: 'error', text: result.error })
      }
    } catch (err) {
      setOllamaStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setOllamaBusy(null)
    }
  }

  const saveOllamaSettings = async (): Promise<void> => {
    const endpoint = ollamaEndpoint.trim()
    if (!endpoint || !ollamaSettings) return
    setOllamaBusy('save')
    setOllamaStatus(null)
    try {
      const response = await window.api.ollama.setSettings({ ...ollamaSettings, baseUrl: endpoint })
      setOllamaSettings(response.settings)
      setOllamaEndpoint(response.settings.baseUrl)
      if (response.ok) {
        setOllamaStatus({ kind: 'ok', text: `Saved ${shortEndpointLabel(response.settings.baseUrl)}` })
        onRefreshProviders()
      } else {
        setOllamaStatus({ kind: 'error', text: response.error })
      }
    } catch (err) {
      setOllamaStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setOllamaBusy(null)
    }
  }

  const useOllamaEndpoint = (endpoint: OllamaEndpointSuggestion): void => {
    setOllamaEndpoint(endpoint.baseUrl)
    setOllamaStatus({ kind: 'info', text: `Selected ${shortEndpointLabel(endpoint.baseUrl)}` })
  }

  const copyOllamaEndpoint = async (endpoint: OllamaEndpointSuggestion): Promise<void> => {
    setOllamaEndpoint(endpoint.baseUrl)
    try {
      await navigator.clipboard.writeText(endpoint.baseUrl)
      setOllamaStatus({ kind: 'ok', text: `Copied ${shortEndpointLabel(endpoint.baseUrl)}` })
    } catch {
      setOllamaStatus({ kind: 'info', text: `Selected ${shortEndpointLabel(endpoint.baseUrl)}` })
    }
  }

  // ---- Phase 33.13/33.14: remote Ollama profiles + auto-connect ----
  const remoteProfiles = ollamaSettings?.remoteProfiles ?? []

  const setRemoteProfiles = (profiles: OllamaRemoteProfile[]): void => updateOllamaSetting('remoteProfiles', profiles)

  const addRemoteProfile = (name = 'PC Ollama', baseUrl = 'http://100.0.0.0:11434', networkHint = 'Tailscale / VPN'): void => {
    // Avoid duplicate endpoints (e.g. re-adding the same Tailscale peer).
    if (remoteProfiles.some((p) => p.baseUrl === baseUrl)) return
    setRemoteProfiles([
      ...remoteProfiles,
      {
        id: `rp-${Date.now()}-${remoteProfiles.length}`,
        name,
        baseUrl,
        priority: remoteProfiles.length,
        enabled: true,
        networkHint
      }
    ])
  }

  const updateRemoteProfile = (id: string, patch: Partial<OllamaRemoteProfile>): void =>
    setRemoteProfiles(remoteProfiles.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile)))

  const removeRemoteProfile = (id: string): void => setRemoteProfiles(remoteProfiles.filter((profile) => profile.id !== id))

  const saveRemoteProfiles = async (): Promise<void> => {
    setOllamaBusy('save')
    setOllamaStatus(null)
    try {
      const response = await window.api.ollama.setSettings({ remoteProfiles })
      setOllamaSettings(response.settings)
      setOllamaStatus(
        response.ok
          ? { kind: 'ok', text: 'Saved remote endpoints' }
          : { kind: 'error', text: response.error }
      )
    } catch (err) {
      setOllamaStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setOllamaBusy(null)
    }
  }

  const runAutoConnect = async (): Promise<void> => {
    setAutoConnectBusy(true)
    setAutoConnectInfo(null)
    try {
      const result = await window.api.ollama.autoConnect()
      if (result.ok) {
        setAutoConnectInfo({
          kind: 'ok',
          text: `Connected via ${result.active.label} — ${shortEndpointLabel(result.active.baseUrl)} · ${result.modelCount} model${result.modelCount === 1 ? '' : 's'}${result.switched ? ' · active endpoint switched' : ''}`
        })
        try {
          localStorage.setItem('akorith.ollamaActive', JSON.stringify({ label: result.active.label, baseUrl: result.active.baseUrl }))
        } catch {
          /* ignore */
        }
        const refreshed = await window.api.ollama.getSettings()
        setOllamaSettings(refreshed)
        setOllamaEndpoint(refreshed.baseUrl)
        onRefreshProviders()
      } else {
        setAutoConnectInfo({
          kind: 'error',
          text: `${result.error}${result.lastSuccessfulBaseUrl ? ` (last working: ${shortEndpointLabel(result.lastSuccessfulBaseUrl)})` : ''}`
        })
        const refreshed = await window.api.ollama.getSettings()
        setOllamaSettings(refreshed)
      }
    } catch (err) {
      setAutoConnectInfo({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setAutoConnectBusy(false)
    }
  }

  // ---- Phase 35: controller API ----
  const refreshController = useCallback(async (): Promise<void> => {
    try {
      const [config, status] = await Promise.all([window.api.controller.getConfig(), window.api.controller.getStatus()])
      setCtrlConfig(config)
      setCtrlStatus(status)
      setCtrlPortDraft(String(config.port))
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    if (activeTab !== 'api') return
    void refreshController()
    if (!ctrlDocs) void window.api.controller.getDocs().then(setCtrlDocs).catch(() => setCtrlDocs(null))
    void window.api.telemetry.getProfiles().then(setTelProfiles).catch(() => setTelProfiles([]))
  }, [activeTab, refreshController, ctrlDocs])

  // ---- Phase 36: remote telemetry profiles ----
  const telToInput = (profile: RemoteTelemetryProfileView): import('../../../preload/index.d').TelemetryProfileInput => ({
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    token: telTokenDrafts[profile.id] ?? '',
    enabled: profile.enabled,
    priority: profile.priority
  })

  const updateTelProfile = (id: string, patch: Partial<RemoteTelemetryProfileView>): void =>
    setTelProfiles((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)))

  const addTelProfile = (): void =>
    setTelProfiles((list) => [
      ...list,
      {
        id: `rt-${Date.now()}-${list.length}`,
        name: 'PC runtime',
        baseUrl: 'http://100.0.0.0:47832',
        enabled: true,
        priority: list.length,
        hasToken: false,
        tokenMasked: ''
      }
    ])

  const removeTelProfile = (id: string): void => setTelProfiles((list) => list.filter((p) => p.id !== id))

  const saveTelProfiles = async (): Promise<void> => {
    setTelBusy(true)
    setTelNotice(null)
    try {
      const saved = await window.api.telemetry.saveProfiles(telProfiles.map(telToInput))
      setTelProfiles(saved)
      setTelTokenDrafts({})
      setTelNotice({ kind: 'ok', text: 'Saved remote telemetry profiles' })
    } catch (err) {
      setTelNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setTelBusy(false)
    }
  }

  const testTelProfile = async (profile: RemoteTelemetryProfileView): Promise<void> => {
    setTelBusy(true)
    setTelNotice(null)
    try {
      const res = await window.api.telemetry.testProfile(telToInput(profile))
      setTelNotice({ kind: res.ok ? 'ok' : 'error', text: `${profile.name}: ${res.message}` })
    } catch (err) {
      setTelNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setTelBusy(false)
    }
  }

  const controllerAction = async (action: () => Promise<ControllerStatus>, okText?: string): Promise<void> => {
    setCtrlBusy(true)
    setCtrlNotice(null)
    try {
      const status = await action()
      setCtrlStatus(status)
      await refreshController()
      if (status.lastError) setCtrlNotice({ kind: 'error', text: status.lastError })
      else if (okText) setCtrlNotice({ kind: 'ok', text: okText })
    } catch (err) {
      setCtrlNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setCtrlBusy(false)
    }
  }

  const toggleController = (enabled: boolean): Promise<void> =>
    controllerAction(
      () => window.api.controller.updateConfig({ enabled }),
      enabled ? 'Controller starting…' : 'Controller stopped'
    )

  const saveControllerPort = (): Promise<void> => {
    const port = Number(ctrlPortDraft)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setCtrlNotice({ kind: 'error', text: 'Enter a port between 1024 and 65535.' })
      return Promise.resolve()
    }
    return controllerAction(() => window.api.controller.updateConfig({ port }), 'Port saved')
  }

  const toggleControllerLan = (allowLan: boolean): Promise<void> =>
    controllerAction(() => window.api.controller.updateConfig({ allowLan }), allowLan ? 'LAN access allowed' : 'Loopback only')

  const regenerateControllerToken = (): Promise<void> =>
    controllerAction(() => window.api.controller.regenerateToken(), 'New token generated')

  const revealControllerToken = async (): Promise<void> => {
    try {
      const token = await window.api.controller.revealToken()
      setCtrlToken(token)
    } catch {
      /* ignore */
    }
  }

  const copyText = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCtrlNotice({ kind: 'ok', text: `Copied ${label}` })
    } catch {
      setCtrlNotice({ kind: 'info', text: `Copy failed — select manually.` })
    }
  }

  const toggleAutoEnter = async (): Promise<void> => {
    const next = !(bridgeSettings?.autoEnter ?? false)
    setSaving('bridge')
    try {
      setBridgeSettings(await window.api.bridge.setAutoEnter(next))
    } finally {
      setSaving(null)
    }
  }

  const toggleDigest = async (): Promise<void> => {
    const next = !(digestSettings?.enabled ?? false)
    setSaving('digest-enabled')
    try {
      const saved = await window.api.digest.setEnabled(next)
      setDigestSettings(saved)
      setDigestDirDraft(saved.workingDir ?? '')
    } finally {
      setSaving(null)
    }
  }

  const saveDigestDir = async (value = digestDirDraft): Promise<void> => {
    setSaving('digest-dir')
    try {
      const saved = await window.api.digest.setWorkingDir(value.trim())
      setDigestSettings(saved)
      setDigestDirDraft(saved.workingDir ?? '')
    } finally {
      setSaving(null)
    }
  }

  const chooseDigestDir = async (): Promise<void> => {
    const res = await window.api.projects.pickDirectory()
    if (!res.ok) return
    setDigestDirDraft(res.path)
    await saveDigestDir(res.path)
  }

  const saveTest = async (patch: Partial<TestSettings>): Promise<void> => {
    setSaving('test')
    try {
      const saved = await window.api.test.setSettings(patch)
      setTestSettings(saved)
      setTestSourceDraft(saved.sourceRepo ?? '')
    } finally {
      setSaving(null)
    }
  }

  const saveTestSource = async (value = testSourceDraft): Promise<void> => {
    await saveTest({ sourceRepo: value.trim() })
  }

  const chooseTestSource = async (): Promise<void> => {
    const res = await window.api.projects.pickDirectory()
    if (!res.ok) return
    setTestSourceDraft(res.path)
    await saveTestSource(res.path)
  }

  const detectAgent = async (id: AgentId): Promise<void> => {
    setAgentBusy(id)
    try {
      const result = await window.api.agent.detect(id)
      setAgentDetections((current) => ({ ...current, [id]: result }))
    } finally {
      setAgentBusy(null)
    }
  }

  const detectAllAgents = async (): Promise<void> => {
    setAgentBusy('all')
    try {
      const results = await window.api.agent.detectAll()
      const next: Partial<Record<AgentId, AgentDetectionResult>> = {}
      for (const result of results) next[result.id] = result
      setAgentDetections((current) => ({ ...current, ...next }))
    } finally {
      setAgentBusy(null)
    }
  }

  const createPlaceholderSession = async (agent: AgentAdapterInfo): Promise<void> => {
    setAgentBusy(`session:${agent.id}`)
    try {
      await window.api.agent.createPlaceholderSession({
        agentId: agent.id,
        mode: placeholderModeForAgent(agent),
        origin: 'agent_hub',
        title: `${agent.displayName} placeholder`,
        metadata: { integrationStage: agent.integrationStage }
      })
      setAgentSessions(await window.api.agent.listSessions())
      setRuntimeAttachments(await window.api.agent.listRuntimeAttachments())
      setRuntimeSnapshot(await window.api.agent.getRuntimeSnapshot())
    } finally {
      setAgentBusy(null)
    }
  }

  const refreshRuntimeSnapshot = async (): Promise<void> => {
    setAgentBusy('runtime')
    try {
      setRuntimeSnapshot(await window.api.agent.refreshRuntimeSnapshot())
      setRuntimeAttachments(await window.api.agent.listRuntimeAttachments())
      setAgentSessions(await window.api.agent.listSessions())
    } finally {
      setAgentBusy(null)
    }
  }

  const tabs: { id: SettingsTab; label: string; kicker: string }[] = [
    { id: 'profile', label: 'Profile', kicker: 'Identity and theme' },
    { id: 'providers', label: 'Providers', kicker: 'Claude, ChatGPT, Ollama' },
    { id: 'agents', label: 'Agents', kicker: 'Agent OS foundation' },
    { id: 'missions', label: 'Missions', kicker: 'Preview engine' },
    { id: 'api', label: 'API', kicker: 'Controller (optional)' },
    { id: 'update', label: 'Update', kicker: 'Install the latest Akorith' },
    { id: 'workflow', label: 'Workflow', kicker: 'Bridge and repo context' },
    { id: 'test', label: 'Test Lab', kicker: 'Defaults and reports' },
    { id: 'safety', label: 'Data', kicker: 'Storage and safety' }
  ]

  const observedSessions = useMemo(() => {
    const byId = new Map<string, AgentSession>()
    for (const session of runtimeSnapshot?.observedSessions ?? []) byId.set(session.id, session)
    for (const session of agentSessions) {
      if (session.metadata?.observed === true) byId.set(session.id, session)
    }
    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [agentSessions, runtimeSnapshot])

  const activeProviderCalls = runtimeSnapshot?.activeProviderCalls.length ?? 0
  const activePtySessions = runtimeSnapshot?.activePtySessions.length ?? 0
  const hasRuntimeActivity = observedSessions.length > 0 || activeProviderCalls > 0 || activePtySessions > 0

  return (
    <div
      className="settings-popover settings-center settings-page"
      role="region"
      aria-label="Settings"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="settings-page-inner">
      <div className="settings-header">
        <div>
          <div className="settings-title">Settings</div>
          <div className="settings-subtitle">Akorith workspace controls</div>
        </div>
        <button type="button" className="settings-close" onClick={onClose} aria-label="Close settings" title="Back to workspace">
          <CloseIcon size={16} />
        </button>
      </div>

      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="Settings sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`settings-tab ${activeTab === tab.id ? 'is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span>{tab.label}</span>
              <em>{tab.kicker}</em>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {activeTab === 'profile' && (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h2>Profile</h2>
                  <p>Local display and app appearance.</p>
                </div>
              </div>
              <label>
                <span>Display name</span>
                <input value={displayName} onChange={(event) => onDisplayNameChange(event.target.value)} />
              </label>
              <div className="settings-field">
                <span>Theme</span>
                <div className="theme-toggle" role="group" aria-label="Theme">
                  <button type="button" className={theme === 'light' ? 'is-active' : ''} onClick={() => onThemeChange('light')}>
                    Light
                  </button>
                  <button type="button" className={theme === 'dark' ? 'is-active' : ''} onClick={() => onThemeChange('dark')}>
                    Dark
                  </button>
                </div>
              </div>
              <div className="settings-summary-grid">
                <div className="settings-summary-item">
                  <span>Available providers</span>
                  <strong>{availableProviders}/{providers.length || 0}</strong>
                </div>
                <div className="settings-summary-item">
                  <span>Auto-Enter</span>
                  <strong>{bridgeSettings?.autoEnter ? 'On' : 'Off'}</strong>
                </div>
                <div className="settings-summary-item">
                  <span>Repo context</span>
                  <strong>{digestSettings?.enabled ? 'On' : 'Off'}</strong>
                </div>
              </div>

              {/* Phase 39: usage-limit labels (shown on the Dashboard). No secrets. */}
              <div className="settings-divider" />
              <div className="settings-field is-stacked">
                <span>Usage limits (Claude / Codex)</span>
                <p className="settings-hint">
                  Akorith can&apos;t read your remaining subscription limits (the CLIs don&apos;t expose them), so enter your
                  own known limits here to compare against Akorith&apos;s recorded in-app usage on the Dashboard. No secrets.
                </p>
                <div className="limits-grid">
                  <label className="limits-field">
                    <span>Claude 5-hour limit</span>
                    <input value={limits.claude5h ?? ''} placeholder="e.g. 45 messages" onChange={(e) => setLimits((l) => ({ ...l, claude5h: e.target.value }))} />
                  </label>
                  <label className="limits-field">
                    <span>Claude weekly limit</span>
                    <input value={limits.claudeWeekly ?? ''} placeholder="e.g. plan tier" onChange={(e) => setLimits((l) => ({ ...l, claudeWeekly: e.target.value }))} />
                  </label>
                  <label className="limits-field">
                    <span>Codex 5-hour limit</span>
                    <input value={limits.codex5h ?? ''} placeholder="e.g. 150 messages" onChange={(e) => setLimits((l) => ({ ...l, codex5h: e.target.value }))} />
                  </label>
                  <label className="limits-field">
                    <span>Codex weekly limit</span>
                    <input value={limits.codexWeekly ?? ''} placeholder="e.g. plan tier" onChange={(e) => setLimits((l) => ({ ...l, codexWeekly: e.target.value }))} />
                  </label>
                </div>
                <div className="settings-action-row">
                  <button type="button" className="is-primary" disabled={limitsBusy} onClick={() => void saveLimits()}>
                    {limitsBusy ? 'Saving…' : limitsSaved ? 'Saved' : 'Save usage limits'}
                  </button>
                </div>
              </div>
            </section>
          )}

          {activeTab === 'providers' && (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h2>Providers</h2>
                  <p>Availability, local endpoint, and Ollama sharing.</p>
                </div>
                <button type="button" onClick={onRefreshProviders}>Refresh</button>
              </div>
              <div className="provider-status-list">
                {providers.map((provider) => (
                  <div className="provider-status-row" key={provider.id}>
                    <span className={`provider-badge ${providerTone(provider.id)}`}>
                      {providerShortLabel(provider.id, provider.label)}
                    </span>
                    <div>
                      <strong>{provider.label}</strong>
                      <em>{provider.models.length ? `${provider.models.length} model${provider.models.length === 1 ? '' : 's'}` : 'No models listed'}</em>
                    </div>
                    <span className={`settings-chip ${provider.available.ok ? 'is-ok' : 'is-error'}`}>
                      {provider.available.ok ? 'Available' : 'Unavailable'}
                    </span>
                    {!provider.available.ok && <p>{provider.available.reason ?? 'Provider is unavailable.'}</p>}
                  </div>
                ))}
              </div>

              <div className="settings-divider" />
              <div className="settings-field is-stacked">
                <span>Ollama endpoint</span>
                <div className="settings-path-row">
                  <input
                    value={ollamaEndpoint}
                    spellCheck={false}
                    placeholder="http://localhost:11434"
                    onChange={(event) => setOllamaEndpoint(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void testOllamaEndpoint()
                    }}
                  />
                  <button type="button" onClick={() => setOllamaEndpoint('http://localhost:11434')}>
                    Localhost
                  </button>
                </div>
                <div className="settings-action-row">
                  <button type="button" disabled={ollamaBusy !== null} onClick={() => void testOllamaEndpoint()}>
                    {ollamaBusy === 'test' ? 'Testing...' : 'Test endpoint'}
                  </button>
                  <button type="button" className="is-primary" disabled={ollamaBusy !== null || !ollamaSettings} onClick={() => void saveOllamaSettings()}>
                    {ollamaBusy === 'save' ? 'Saving...' : 'Save Ollama'}
                  </button>
                </div>
                {ollamaStatus && <div className={`ollama-status is-${ollamaStatus.kind}`}>{ollamaStatus.text}</div>}
                {localProvider && !localProvider.available.ok && <div className="ollama-status is-error">{localProvider.available.reason}</div>}
              </div>

              {shareEndpoints.length > 0 && (
                <div className="ollama-share-box">
                  <div className="ollama-share-title">
                    <span>This machine</span>
                    {ollamaShare?.hostName && <em>{ollamaShare.hostName}</em>}
                  </div>
                  {ollamaShare && (
                    <div className={`ollama-remote-status ${remoteReady ? 'is-ready' : 'is-waiting'}`}>
                      <strong>{remoteReady ? 'Remote access ready' : 'Remote access needs VPN'}</strong>
                      <span>{remoteMessage}</span>
                      {remoteEndpoint && (
                        <button type="button" onClick={() => useOllamaEndpoint(remoteEndpoint)}>
                          Use remote endpoint
                        </button>
                      )}
                    </div>
                  )}
                  <div className="ollama-endpoint-list">
                    {shareEndpoints.map((endpoint) => (
                      <div className={`ollama-endpoint-card is-${endpoint.kind}`} key={endpoint.baseUrl}>
                        <button type="button" className="ollama-endpoint-main" onClick={() => useOllamaEndpoint(endpoint)}>
                          <span>{endpoint.label}</span>
                          <em>{endpoint.baseUrl}</em>
                        </button>
                        <button type="button" className="ollama-copy-btn" onClick={() => void copyOllamaEndpoint(endpoint)}>
                          Copy
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {ollamaSettings && (
                <div className="settings-checks">
                  <label>
                    <input
                      type="checkbox"
                      checked={ollamaSettings.autoStart}
                      onChange={(event) => updateOllamaSetting('autoStart', event.target.checked)}
                    />
                    <span>Auto-start local Ollama</span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={ollamaSettings.exposeLan}
                      onChange={(event) => updateOllamaSetting('exposeLan', event.target.checked)}
                    />
                    <span>Expose local Ollama on LAN</span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={ollamaSettings.lanDiscovery}
                      onChange={(event) => updateOllamaSetting('lanDiscovery', event.target.checked)}
                    />
                    <span>Discover LAN Ollama hosts</span>
                  </label>
                </div>
              )}

              {/* Phase 33.13/33.14: remote endpoints + auto-connect */}
              <div className="settings-divider" />
              <div className="settings-field is-stacked">
                <div className="ollama-remote-head">
                  <span>Remote Ollama endpoints</span>
                  <div className="settings-action-row">
                    <button type="button" disabled={autoConnectBusy} onClick={() => void runAutoConnect()}>
                      {autoConnectBusy ? 'Connecting…' : 'Auto-connect'}
                    </button>
                    <button type="button" onClick={() => addRemoteProfile()}>
                      Add endpoint
                    </button>
                  </div>
                </div>
                <p className="settings-hint">
                  Akorith tries your local Ollama first, then the last endpoint that answered, then these
                  remote endpoints by priority (lowest first), and uses the first that responds.
                </p>
                {autoConnectInfo && <div className={`ollama-status is-${autoConnectInfo.kind}`}>{autoConnectInfo.text}</div>}

                {/* Phase 42 (Remote Ollama): Tailscale away-from-home helper + guidance. */}
                <div className="ollama-tailscale">
                  <div className="ollama-remote-head">
                    <span>Find PC over Tailscale</span>
                    <button type="button" disabled={tsBusy} onClick={() => void refreshTailscale()}>
                      {tsBusy ? 'Checking…' : tailscale ? 'Re-check' : 'Check Tailscale'}
                    </button>
                  </div>
                  {tailscale && (
                    <>
                      {!tailscale.installed && (
                        <div className="ollama-status is-info">
                          Tailscale isn&apos;t installed. To use the PC&apos;s models from another network: install Tailscale on
                          both machines, sign into the same account, keep the PC on with Ollama running
                          (<code>OLLAMA_HOST=0.0.0.0</code>), then click Auto-connect. Akorith never installs Tailscale or
                          exposes Ollama publicly.
                        </div>
                      )}
                      {tailscale.installed && !tailscale.running && (
                        <div className="ollama-status is-info">
                          Tailscale is installed but not connected. Open Tailscale and sign in on both machines, then re-check.
                        </div>
                      )}
                      {tailscale.running && (
                        <div className="ollama-tailscale-peers">
                          {tailscale.peers.filter((p) => !p.isSelf).length === 0 ? (
                            <div className="ollama-status is-info">Connected, but no peer devices found. Sign the PC into the same tailnet.</div>
                          ) : (
                            tailscale.peers
                              .filter((p) => !p.isSelf)
                              .map((p) => (
                                <div className="ollama-tailscale-peer" key={p.ip}>
                                  <span className={p.online ? 'is-online' : 'is-offline'}>●</span>
                                  <strong>{p.hostName}</strong>
                                  <code>http://{p.ip}:11434</code>
                                  <button
                                    type="button"
                                    onClick={() => addRemoteProfile(`${p.hostName} (Tailscale)`, `http://${p.ip}:11434`, 'Tailscale')}
                                  >
                                    Add as endpoint
                                  </button>
                                </div>
                              ))
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>

                {remoteProfiles.length === 0 ? (
                  <div className="ollama-remote-empty">
                    No remote endpoints yet. Add your PC&apos;s Tailscale/VPN address (e.g. http://100.x.x.x:11434)
                    so its models are reachable when you&apos;re on another network.
                  </div>
                ) : (
                  <div className="ollama-remote-list">
                    {remoteProfiles.map((profile) => (
                      <div className={`ollama-remote-card ${profile.lastStatus ? `is-${profile.lastStatus}` : ''}`} key={profile.id}>
                        <div className="ollama-remote-row">
                          <input
                            className="ollama-remote-name"
                            value={profile.name}
                            placeholder="Name"
                            onChange={(event) => updateRemoteProfile(profile.id, { name: event.target.value })}
                          />
                          <label className="ollama-remote-enabled" title="Include in auto-connect">
                            <input
                              type="checkbox"
                              checked={profile.enabled}
                              onChange={(event) => updateRemoteProfile(profile.id, { enabled: event.target.checked })}
                            />
                            <span>Enabled</span>
                          </label>
                          <button type="button" className="ollama-remote-remove" onClick={() => removeRemoteProfile(profile.id)}>
                            Remove
                          </button>
                        </div>
                        <div className="ollama-remote-row">
                          <input
                            className="ollama-remote-url"
                            value={profile.baseUrl}
                            spellCheck={false}
                            placeholder="http://100.x.x.x:11434"
                            onChange={(event) => updateRemoteProfile(profile.id, { baseUrl: event.target.value })}
                          />
                          <input
                            className="ollama-remote-priority"
                            type="number"
                            min={0}
                            value={profile.priority}
                            title="Priority (lower runs first)"
                            onChange={(event) => updateRemoteProfile(profile.id, { priority: Number(event.target.value) || 0 })}
                          />
                        </div>
                        <div className="ollama-remote-row">
                          <input
                            className="ollama-remote-hint"
                            value={profile.networkHint ?? ''}
                            placeholder="Network hint (Tailscale, home LAN, …)"
                            onChange={(event) => updateRemoteProfile(profile.id, { networkHint: event.target.value })}
                          />
                          <span className="ollama-remote-meta">
                            {profile.lastStatus === 'ok'
                              ? `✓ reachable${profile.lastModelCount !== undefined ? ` · ${profile.lastModelCount} models` : ''}`
                              : profile.lastStatus === 'error'
                                ? '✕ unreachable'
                                : 'not checked'}
                          </span>
                        </div>
                        {profile.lastStatus === 'error' && profile.lastError && (
                          <div className="ollama-remote-error">{profile.lastError}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {remoteProfiles.length > 0 && (
                  <div className="settings-action-row">
                    <button type="button" className="is-primary" disabled={ollamaBusy !== null} onClick={() => void saveRemoteProfiles()}>
                      {ollamaBusy === 'save' ? 'Saving…' : 'Save remote endpoints'}
                    </button>
                  </div>
                )}

                <div className="settings-note ollama-remote-note">
                  For a different network, use a private route — Tailscale, a VPN, or an SSH tunnel — and point the
                  endpoint at that address. Do not expose Ollama directly to the public internet without
                  authentication and a firewall. Akorith stores only endpoint config here, never secrets.
                </div>
              </div>
            </section>
          )}

          {activeTab === 'agents' && (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h2>Agent Hub</h2>
                  <p>Read-only Agent OS foundation for current and future adapters.</p>
                </div>
                <button type="button" disabled={agentBusy !== null} onClick={() => void detectAllAgents()}>
                  {agentBusy === 'all' ? 'Detecting...' : 'Detect all'}
                </button>
              </div>
              <div className="agent-hub-list">
                {agentAdapters.map((agent) => {
                  const detection = agentDetections[agent.id]
                  const status = detection?.status ?? agent.status
                  const runtimeState = observedRuntimeState(agent, runtimeSnapshot)
                  return (
                    <div className="agent-hub-row" key={agent.id}>
                      <div className="agent-hub-main">
                        <div className="agent-hub-title">
                          <strong>{agent.displayName}</strong>
                          <span className={`settings-chip ${agentStatusClass(status)}`}>{status}</span>
                        </div>
                        <div className="agent-hub-stage">
                          <span>{integrationStageLabel(agent.integrationStage)}</span>
                          <em>{runtimeSummary(agent)}</em>
                        </div>
                        <div className="agent-runtime-state">
                          <span className={`settings-chip ${runtimeStateTone(runtimeState)}`}>{runtimeState}</span>
                          <em>current observed runtime state</em>
                        </div>
                        <p>{agent.description}</p>
                        <div className="agent-capability-list">
                          {agent.capabilities.map((capability) => (
                            <span key={capability}>{capabilityLabel(capability)}</span>
                          ))}
                        </div>
                        <div className="agent-note">{agent.currentIntegrationNotes[0]}</div>
                        <div className="agent-note is-future">{agent.futureIntegrationNotes[0]}</div>
                        {detection?.message && <div className="agent-note is-detection">{detection.message}</div>}
                      </div>
                      <div className="agent-hub-actions">
                        <button
                          type="button"
                          className="agent-detect-btn"
                          disabled={agentBusy !== null}
                          onClick={() => void detectAgent(agent.id)}
                        >
                          {agentBusy === agent.id ? 'Checking...' : 'Detect'}
                        </button>
                        <button
                          type="button"
                          className="agent-detect-btn"
                          disabled={agentBusy !== null}
                          onClick={() => void createPlaceholderSession(agent)}
                        >
                          {agentBusy === `session:${agent.id}` ? 'Creating...' : 'Placeholder'}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="settings-divider" />
              <div className="agent-runtime-panel">
                <div className="agent-runtime-head">
                  <div>
                    <strong>Runtime Observation</strong>
                    <span>Checked {relativeTime(runtimeSnapshot?.checkedAt)}</span>
                  </div>
                  <button type="button" disabled={agentBusy !== null} onClick={() => void refreshRuntimeSnapshot()}>
                    {agentBusy === 'runtime' ? 'Checking...' : 'Refresh'}
                  </button>
                </div>
                <div className="agent-runtime-grid">
                  <div>
                    <span>Observed sessions</span>
                    <strong>{observedSessions.length}</strong>
                  </div>
                  <div>
                    <span>Provider calls</span>
                    <strong>{activeProviderCalls}</strong>
                  </div>
                  <div>
                    <span>PTY sessions</span>
                    <strong>{activePtySessions}</strong>
                  </div>
                  <div>
                    <span>Ollama</span>
                    <strong>{runtimeSnapshot?.ollamaStatus?.status ?? 'unknown'}</strong>
                  </div>
                </div>
                {!hasRuntimeActivity && (
                  <div className="agent-empty-state">
                    <strong>No active runtime observed yet.</strong>
                    <span>Run a chat provider call or open a terminal to see read-only runtime activity here.</span>
                  </div>
                )}
                {runtimeSnapshot?.activeProviderCalls.slice(0, 3).map((attachment) => (
                  <div className="agent-runtime-row" key={attachment.id}>
                    <span>{attachment.title ?? attachment.kind}</span>
                    <em>{attachment.status} - {attachment.agentId ?? 'system'} - {relativeTime(attachment.lastActivityAt ?? attachment.updatedAt)}</em>
                  </div>
                ))}
                {runtimeSnapshot?.activePtySessions.slice(0, 4).map((attachment) => (
                  <div className="agent-runtime-row" key={attachment.id}>
                    <span>{attachment.title ?? attachment.externalId ?? attachment.kind}</span>
                    <em>{attachment.status} - {attachment.agentId ?? 'system'} - {relativeTime(attachment.lastActivityAt ?? attachment.updatedAt)}</em>
                  </div>
                ))}
                {runtimeSnapshot?.notes?.map((note) => <div className="agent-note" key={note}>{note}</div>)}
              </div>
              <div className="settings-divider" />
              <div className="agent-session-panel">
                <div>
                  <strong>Observed session inspector</strong>
                  <span>{observedSessions.length ? `${observedSessions.length} observed` : 'No observed sessions'}</span>
                </div>
                {observedSessions.length === 0 ? (
                  <div className="agent-empty-state">
                    <strong>No runtime session history yet.</strong>
                    <span>Observation only - existing providers and terminals remain the active runtime.</span>
                  </div>
                ) : (
                  observedSessions.map((session) => {
                    const relatedAttachments = attachmentsForSession(session, runtimeAttachments)
                    const expanded = expandedAgentSessionId === session.id
                    return (
                      <div className="agent-session-item" key={session.id}>
                        <button
                          type="button"
                          className={`agent-session-row is-clickable ${expanded ? 'is-active' : ''}`}
                          onClick={() => setExpandedAgentSessionId((current) => (current === session.id ? null : session.id))}
                        >
                          <span>{session.title ?? `${session.agentId} session`}</span>
                          <em>{shortId(session.id)} - {session.mode} - {session.status} - {relatedAttachments.length} attachment{relatedAttachments.length === 1 ? '' : 's'}</em>
                        </button>
                        {expanded && (
                          <div className="agent-session-detail">
                            <div className="agent-session-fields">
                              <div><span>Session id</span><strong>{shortId(session.id, 12)}</strong></div>
                              <div><span>Agent</span><strong>{session.agentId}</strong></div>
                              <div><span>Mode</span><strong>{session.mode}</strong></div>
                              <div><span>Origin</span><strong>{session.origin}</strong></div>
                              <div><span>Status</span><strong>{session.status}</strong></div>
                              <div><span>Created</span><strong>{dateTimeLabel(session.createdAt)}</strong></div>
                              <div><span>Updated</span><strong>{dateTimeLabel(session.updatedAt)}</strong></div>
                              <div><span>Activity</span><strong>{dateTimeLabel(session.lastActivityAt)}</strong></div>
                            </div>
                            {session.projectPath && <div className="agent-safe-path" title={session.projectPath}>Project: {session.projectPath}</div>}
                            {session.error && <div className="agent-note is-error">{session.error}</div>}
                            <div className="agent-attachment-list">
                              {relatedAttachments.length === 0 ? (
                                <div className="agent-note">No runtime attachments are linked to this observed session.</div>
                              ) : (
                                relatedAttachments.map((attachment) => (
                                  <div className="agent-attachment-row" key={attachment.id}>
                                    <div>
                                      <strong>{attachment.kind}</strong>
                                      <span>{attachment.status} - {attachment.agentId ?? 'system'} - {sourceLabel(attachment.sourceFile)}</span>
                                    </div>
                                    <div>
                                      <span>External</span>
                                      <strong>{shortId(attachment.externalId, 10)}</strong>
                                    </div>
                                    <div>
                                      <span>Updated</span>
                                      <strong>{dateTimeLabel(attachment.updatedAt)}</strong>
                                    </div>
                                    {attachment.projectPath && <p title={attachment.projectPath}>Project: {attachment.projectPath}</p>}
                                    <p>Metadata: {safeMetadataSummary(attachment.metadata)}</p>
                                    {attachment.error && <p className="is-error">Error: {attachment.error}</p>}
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
              {agentSessions.some((session) => session.metadata?.placeholder === true) && (
                <div className="agent-placeholder-strip">
                  <strong>Placeholder sessions</strong>
                  <span>{agentSessions.filter((session) => session.metadata?.placeholder === true).length} in memory for adapter plumbing only.</span>
                </div>
              )}
              <div className="settings-note">
                Runtime observation intentionally avoids storing full prompts, terminal output, secrets, command contents, or hidden IPC payloads. This layer is read-only in Phase 31.
              </div>
            </section>
          )}

          {activeTab === 'missions' && (
            <section className="settings-section">
              <MissionCenter />
            </section>
          )}

          {activeTab === 'update' && <UpdatePanel />}

          {activeTab === 'api' && (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h2>Controller API</h2>
                  <p>
                    Optional local HTTP API for scripts, CLIs, and plugins. Disabled by default, loopback-only,
                    token-protected, and read-only in this phase.
                  </p>
                </div>
                {ctrlStatus && (
                  <span className={`ctrl-pill ${ctrlStatus.running ? 'is-running' : 'is-stopped'}`}>
                    {ctrlStatus.running ? 'Running' : 'Stopped'}
                  </span>
                )}
              </div>

              {ctrlConfig && ctrlStatus ? (
                <>
                  <div className="settings-toggle-row">
                    <label className="ctrl-switch">
                      <input
                        type="checkbox"
                        checked={ctrlConfig.enabled}
                        disabled={ctrlBusy}
                        onChange={(event) => void toggleController(event.target.checked)}
                      />
                      <span>Enable controller API</span>
                    </label>
                    <span className="ctrl-readonly">Read-only · {ctrlStatus.sseEnabled ? 'SSE on' : 'SSE off'}</span>
                  </div>

                  <div className="ctrl-grid">
                    <div className="ctrl-field">
                      <span>Host</span>
                      <code>{ctrlConfig.host}</code>
                    </div>
                    <div className="ctrl-field">
                      <span>Port</span>
                      <div className="settings-path-row">
                        <input
                          value={ctrlPortDraft}
                          inputMode="numeric"
                          onChange={(event) => setCtrlPortDraft(event.target.value.replace(/[^0-9]/g, ''))}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveControllerPort()
                          }}
                        />
                        <button type="button" disabled={ctrlBusy} onClick={() => void saveControllerPort()}>
                          Save
                        </button>
                      </div>
                    </div>
                    <div className="ctrl-field">
                      <span>Base URL</span>
                      <div className="settings-path-row">
                        <code>{ctrlStatus.baseUrl}</code>
                        <button type="button" onClick={() => void copyText(ctrlStatus.baseUrl, 'base URL')}>
                          Copy
                        </button>
                      </div>
                    </div>
                    <div className="ctrl-field">
                      <span>Token</span>
                      <div className="settings-path-row">
                        <code>{ctrlToken ?? (ctrlConfig.hasToken ? ctrlConfig.tokenMasked : 'none yet')}</code>
                        <button type="button" onClick={() => void revealControllerToken()}>
                          {ctrlToken ? 'Shown' : 'Reveal'}
                        </button>
                        {ctrlToken && (
                          <button type="button" onClick={() => void copyText(ctrlToken, 'token')}>
                            Copy
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="settings-checks">
                    <label>
                      <input
                        type="checkbox"
                        checked={ctrlConfig.allowLan}
                        disabled={ctrlBusy}
                        onChange={(event) => void toggleControllerLan(event.target.checked)}
                      />
                      <span>Allow LAN access (binds a non-loopback host — trusted private networks only)</span>
                    </label>
                  </div>
                  {ctrlConfig.allowLan && (
                    <div className="ollama-status is-error">
                      Warning: LAN access is enabled. Only use this on a trusted private network (e.g. Tailscale/VPN).
                      Never expose the controller to the public internet.
                    </div>
                  )}

                  <div className="settings-action-row">
                    <button type="button" disabled={ctrlBusy} onClick={() => void controllerAction(() => window.api.controller.restart(), 'Controller restarted')}>
                      Restart
                    </button>
                    <button type="button" disabled={ctrlBusy} onClick={() => void regenerateControllerToken()}>
                      Regenerate token
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyText(`curl -H "Authorization: Bearer <token>" ${ctrlStatus.baseUrl}/health`, 'example curl')}
                    >
                      Copy example curl
                    </button>
                  </div>

                  {ctrlNotice && <div className={`ollama-status is-${ctrlNotice.kind}`}>{ctrlNotice.text}</div>}
                  {ctrlStatus.lastStartedAt && (
                    <div className="settings-hint">Last started {new Date(ctrlStatus.lastStartedAt).toLocaleString()}</div>
                  )}

                  {ctrlDocs && (
                    <>
                      <div className="settings-divider" />
                      <div className="settings-field is-stacked">
                        <span>Endpoints ({ctrlDocs.endpoints.length})</span>
                        <div className="ctrl-endpoints">
                          {ctrlDocs.endpoints.map((endpoint) => (
                            <div className="ctrl-endpoint" key={`${endpoint.method}-${endpoint.path}`}>
                              <span className="ctrl-method">{endpoint.method}</span>
                              <code>{endpoint.path}</code>
                              <em>{endpoint.summary}</em>
                              {!endpoint.auth && <span className="ctrl-open">no auth</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}

                  <div className="settings-note">
                    The token is stored in local config (loopex.config.json), not an OS keychain. It is never logged.
                    Phase 35 exposes read-only endpoints only — no command, terminal, file, git, prompt-send, or mission
                    execution.
                  </div>

                  {/* Phase 36: remote telemetry profiles (read the PC's GPU on the Mac) */}
                  <div className="settings-divider" />
                  <div className="settings-field is-stacked">
                    <div className="ollama-remote-head">
                      <span>Remote telemetry profiles</span>
                      <button type="button" onClick={addTelProfile}>
                        Add remote runtime
                      </button>
                    </div>
                    <p className="settings-hint">
                      Point at another Akorith Controller (e.g. the PC running Ollama, with the Controller API enabled and
                      Allow-LAN on over Tailscale/VPN). The Dashboard then shows that machine&apos;s GPU. Read-only; token
                      required.
                    </p>
                    {telNotice && <div className={`ollama-status is-${telNotice.kind}`}>{telNotice.text}</div>}

                    {telProfiles.length === 0 ? (
                      <div className="ollama-remote-empty">
                        No remote telemetry yet. Add the PC controller&apos;s base URL (e.g. http://100.x.x.x:47832) and its
                        token to show the PC&apos;s GPU on this Mac.
                      </div>
                    ) : (
                      <div className="ollama-remote-list">
                        {telProfiles.map((profile) => (
                          <div className={`ollama-remote-card ${profile.lastStatus ? `is-${profile.lastStatus}` : ''}`} key={profile.id}>
                            <div className="ollama-remote-row">
                              <input
                                className="ollama-remote-name"
                                value={profile.name}
                                placeholder="Name"
                                onChange={(event) => updateTelProfile(profile.id, { name: event.target.value })}
                              />
                              <label className="ollama-remote-enabled">
                                <input
                                  type="checkbox"
                                  checked={profile.enabled}
                                  onChange={(event) => updateTelProfile(profile.id, { enabled: event.target.checked })}
                                />
                                <span>Enabled</span>
                              </label>
                              <button type="button" className="ollama-remote-remove" onClick={() => removeTelProfile(profile.id)}>
                                Remove
                              </button>
                            </div>
                            <div className="ollama-remote-row">
                              <input
                                className="ollama-remote-url"
                                value={profile.baseUrl}
                                spellCheck={false}
                                placeholder="http://100.x.x.x:47832"
                                onChange={(event) => updateTelProfile(profile.id, { baseUrl: event.target.value })}
                              />
                              <input
                                className="ollama-remote-priority"
                                type="number"
                                min={0}
                                value={profile.priority}
                                title="Priority (lower runs first)"
                                onChange={(event) => updateTelProfile(profile.id, { priority: Number(event.target.value) || 0 })}
                              />
                            </div>
                            <div className="ollama-remote-row">
                              <input
                                className="ollama-remote-url"
                                type="password"
                                value={telTokenDrafts[profile.id] ?? ''}
                                placeholder={profile.hasToken ? `token saved (${profile.tokenMasked}) — leave blank to keep` : 'controller token (required)'}
                                onChange={(event) => setTelTokenDrafts((d) => ({ ...d, [profile.id]: event.target.value }))}
                              />
                              <button type="button" disabled={telBusy} onClick={() => void testTelProfile(profile)}>
                                Test
                              </button>
                            </div>
                            {profile.lastStatus === 'error' && profile.lastError && (
                              <div className="ollama-remote-error">{profile.lastError}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {telProfiles.length > 0 && (
                      <div className="settings-action-row">
                        <button type="button" className="is-primary" disabled={telBusy} onClick={() => void saveTelProfiles()}>
                          {telBusy ? 'Saving…' : 'Save telemetry profiles'}
                        </button>
                      </div>
                    )}

                    <div className="settings-note">
                      On the PC: enable the Controller API, turn on Allow-LAN only on a trusted private network (Tailscale/
                      VPN/LAN), and copy its base URL + token. On this Mac: add a profile with that URL and token. Never
                      expose the controller publicly.
                    </div>
                  </div>
                </>
              ) : (
                <div className="settings-hint">Loading controller status…</div>
              )}
            </section>
          )}

          {activeTab === 'workflow' && (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h2>Workflow</h2>
                  <p>Terminal bridge, repo context, and Loop sync defaults.</p>
                </div>
              </div>
              <div className="settings-toggle-row">
                <div>
                  <strong>Auto-Enter for bridge sends</strong>
                  <span>{bridgeSettings?.autoEnter ? 'Messages execute immediately in the target agent.' : 'Messages land at the prompt and wait.'}</span>
                </div>
                <button type="button" className={bridgeSettings?.autoEnter ? 'is-active' : ''} disabled={saving === 'bridge'} onClick={() => void toggleAutoEnter()}>
                  {bridgeSettings?.autoEnter ? 'On' : 'Off'}
                </button>
              </div>
              <div className="settings-toggle-row">
                <div>
                  <strong>Repo context</strong>
                  <span>{digestSettings?.enabled ? 'Planning chat includes the bounded repo digest.' : 'Planning chat sends only the typed prompt.'}</span>
                </div>
                <button type="button" className={digestSettings?.enabled ? 'is-active' : ''} disabled={saving === 'digest-enabled'} onClick={() => void toggleDigest()}>
                  {digestSettings?.enabled ? 'On' : 'Off'}
                </button>
              </div>
              <div className="settings-field is-stacked">
                <span>Repo context folder</span>
                <div className="settings-path-row">
                  <input value={digestDirDraft} spellCheck={false} placeholder="Use active project" onChange={(event) => setDigestDirDraft(event.target.value)} />
                  <button type="button" onClick={() => void chooseDigestDir()}>Choose</button>
                  <button type="button" disabled={saving === 'digest-dir'} onClick={() => void saveDigestDir()}>
                    Save
                  </button>
                </div>
              </div>
              <div className="settings-readonly-grid">
                <div>
                  <span>Loop repository</span>
                  <strong>{LOOP_REMOTE}</strong>
                </div>
                <div>
                  <span>Loop folder</span>
                  <strong>{LOOP_FOLDER}</strong>
                </div>
              </div>
            </section>
          )}

          {activeTab === 'test' && (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h2>Test Lab</h2>
                  <p>Defaults for the guided test and PDF flow.</p>
                </div>
              </div>
              <div className="settings-field is-stacked">
                <span>Default source</span>
                <div className="settings-path-row">
                  <input value={testSourceDraft} spellCheck={false} placeholder="Folder path or GitHub URL" onChange={(event) => setTestSourceDraft(event.target.value)} />
                  <button type="button" onClick={() => void chooseTestSource()}>Choose</button>
                  <button type="button" disabled={saving === 'test'} onClick={() => void saveTestSource()}>
                    Save
                  </button>
                </div>
              </div>
              <div className="settings-toggle-row">
                <div>
                  <strong>Install dependencies in sandbox</strong>
                  <span>{testSettings?.installDeps ? 'Enabled when a lockfile is present.' : 'Skipped unless a run overrides it.'}</span>
                </div>
                <button
                  type="button"
                  className={testSettings?.installDeps ? 'is-active' : ''}
                  disabled={!testSettings || saving === 'test'}
                  onClick={() => void saveTest({ installDeps: !(testSettings?.installDeps ?? true) })}
                >
                  {testSettings?.installDeps ? 'On' : 'Off'}
                </button>
              </div>
              <div className="settings-two-col">
                <label>
                  <span>Run timeout</span>
                  <select
                    className="settings-select"
                    value={testSettings?.timeoutMs ?? 120_000}
                    disabled={!testSettings || saving === 'test'}
                    onChange={(event) => void saveTest({ timeoutMs: Number(event.target.value) })}
                  >
                    {[60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000].map((value) => (
                      <option key={value} value={value}>{secondsLabel(value)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Retained sandboxes</span>
                  <select
                    className="settings-select"
                    value={testSettings?.keepLastN ?? 3}
                    disabled={!testSettings || saving === 'test'}
                    onChange={(event) => void saveTest({ keepLastN: Number(event.target.value) })}
                  >
                    {[0, 1, 3, 5, 10, 20].map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="settings-readonly-grid">
                <div>
                  <span>Test writer</span>
                  <strong>Local / Ollama</strong>
                </div>
                <div>
                  <span>Report</span>
                  <strong>Akorith Test Report PDF</strong>
                </div>
              </div>
            </section>
          )}

          {activeTab === 'safety' && (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h2>Data</h2>
                  <p>Local-first storage and execution boundaries.</p>
                </div>
              </div>
              <div className="settings-readonly-grid is-stacked">
                <div>
                  <span>Chat and usage history</span>
                  <strong>SQLite in the Akorith userData folder</strong>
                </div>
                <div>
                  <span>Test execution</span>
                  <strong>Temporary sandbox; source repositories stay read-only</strong>
                </div>
                <div>
                  <span>Loop output</span>
                  <strong>One folder per loop under AkorithLoop</strong>
                </div>
                <div>
                  <span>Secrets</span>
                  <strong>No API keys are required by Akorith providers</strong>
                </div>
              </div>
              <div className="settings-note">Packaged app changes appear after rebuilding and launching the new build.</div>
            </section>
          )}
        </div>
      </div>
      </div>
    </div>
  )
}
