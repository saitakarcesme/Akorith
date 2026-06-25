import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  BridgeSettings,
  DigestSettings,
  OllamaConnectionSettings,
  OllamaEndpointSuggestion,
  OllamaShareInfo,
  ProviderInfo,
  TestSettings
} from '../../../preload/index.d'
import type { AppTheme } from '../App'
import { CloseIcon } from './icons'

type SettingsTab = 'profile' | 'providers' | 'workflow' | 'test' | 'safety'

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
  const [bridgeSettings, setBridgeSettings] = useState<BridgeSettings | null>(null)
  const [digestSettings, setDigestSettings] = useState<DigestSettings | null>(null)
  const [testSettings, setTestSettings] = useState<TestSettings | null>(null)
  const [ollamaSettings, setOllamaSettings] = useState<OllamaConnectionSettings | null>(null)
  const [ollamaEndpoint, setOllamaEndpoint] = useState('http://localhost:11434')
  const [ollamaShare, setOllamaShare] = useState<OllamaShareInfo | null>(null)
  const [ollamaBusy, setOllamaBusy] = useState<'test' | 'save' | null>(null)
  const [ollamaStatus, setOllamaStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null)
  const [digestDirDraft, setDigestDirDraft] = useState('')
  const [testSourceDraft, setTestSourceDraft] = useState('')
  const [saving, setSaving] = useState<string | null>(null)

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

  const tabs: { id: SettingsTab; label: string; kicker: string }[] = [
    { id: 'profile', label: 'Profile', kicker: 'Identity and theme' },
    { id: 'providers', label: 'Providers', kicker: 'Claude, ChatGPT, Ollama' },
    { id: 'workflow', label: 'Workflow', kicker: 'Bridge and repo context' },
    { id: 'test', label: 'Test Lab', kicker: 'Defaults and reports' },
    { id: 'safety', label: 'Data', kicker: 'Storage and safety' }
  ]

  return (
    <div
      className="settings-popover settings-center"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="settings-header">
        <div>
          <div className="settings-title">Settings</div>
          <div className="settings-subtitle">Akorith workspace controls</div>
        </div>
        <button type="button" className="settings-close" onClick={onClose} aria-label="Close settings" title="Close">
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
  )
}
