import { useCallback, useEffect, useMemo, useState } from 'react'
import './plugin-marketplace.css'

type JsonRecord = Record<string, unknown>

export type MarketplaceLifecycleState =
  | 'not-installed'
  | 'installing'
  | 'installed'
  | 'enabling'
  | 'enabled'
  | 'disabling'
  | 'disabled'
  | 'updating'
  | 'uninstalling'
  | 'error'

export interface PluginMarketplaceApi {
  list(): Promise<unknown>
  install?(id: string): Promise<unknown>
  update?(id: string): Promise<unknown>
  enable?(id: string): Promise<unknown>
  disable?(id: string): Promise<unknown>
  uninstall?(id: string): Promise<unknown>
  connect?(id: string): Promise<unknown>
  configure?(id: string): Promise<unknown>
  check?(id: string): Promise<unknown>
}

export interface PluginMarketplacePageProps {
  /** Supplying an API keeps the component independent from the Electron global in tests and previews. */
  api?: PluginMarketplaceApi
  /** Optional server-rendered or test data. Raw manifests and marketplace snapshots are both accepted. */
  initialPlugins?: readonly unknown[]
}

interface MarketplacePermissionView {
  id: string
  kind: string
  access: string
  required: boolean
  scopes: string[]
  risk: 'low' | 'medium' | 'high'
  rationale: string
}

interface MarketplacePluginView {
  id: string
  name: string
  description: string
  version: string
  installedVersion: string | null
  publisher: string
  category: string
  lifecycle: MarketplaceLifecycleState
  connection: string | null
  connectionReason: string | null
  updateAvailable: boolean
  authRequired: boolean
  authMode: string
  permissions: MarketplacePermissionView[]
  capabilities: string[]
  configFields: number
  error: string | null
}

const CATEGORY_LABELS: Record<string, string> = {
  'source-control': 'Source control',
  'project-management': 'Project management',
  knowledge: 'Knowledge',
  communication: 'Communication',
  productivity: 'Productivity',
  design: 'Design',
  delivery: 'Delivery',
  observability: 'Observability',
  analytics: 'Analytics',
  database: 'Databases',
  infrastructure: 'Infrastructure',
  cloud: 'Cloud',
  ai: 'AI & models',
  browser: 'Browser',
  'local-tools': 'Local tools',
  integration: 'Integrations',
  tool: 'Tools',
  workbench: 'Workbench',
  automation: 'Automation',
  model_provider: 'Model providers',
  memory: 'Memory',
  telemetry: 'Telemetry'
}

const BUSY_STATES = new Set<MarketplaceLifecycleState>([
  'installing',
  'enabling',
  'disabling',
  'updating',
  'uninstalling'
])

const LIFECYCLE_STATES = new Set<MarketplaceLifecycleState>([
  'not-installed',
  'installing',
  'installed',
  'enabling',
  'enabled',
  'disabling',
  'disabled',
  'updating',
  'uninstalling',
  'error'
])

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function recordValue(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

function listValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  if (Array.isArray(value.plugins)) return value.plugins
  if (Array.isArray(value.items)) return value.items
  return []
}

function normalizeLifecycle(record: JsonRecord, installation: JsonRecord): MarketplaceLifecycleState {
  const explicit = stringValue(installation.state ?? record.lifecycleState ?? record.lifecycle)
  if (LIFECYCLE_STATES.has(explicit as MarketplaceLifecycleState)) return explicit as MarketplaceLifecycleState

  if (record.enabled === false || record.effectiveStatus === 'disabled') return 'disabled'
  if (record.enabled === true) return 'enabled'
  if (record.effectiveStatus === 'error' || record.status === 'error') return 'error'
  if (record.effectiveStatus === 'built_in' || record.effectiveStatus === 'available') return 'installed'
  return 'not-installed'
}

function normalizePermissions(value: unknown): MarketplacePermissionView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry, index) => {
    if (typeof entry === 'string') {
      return [{
        id: entry,
        kind: entry.replaceAll('_', ' '),
        access: 'requested',
        required: true,
        scopes: [],
        risk: entry.includes('write') || entry.includes('secret') ? 'high' as const : 'medium' as const,
        rationale: 'Requested by this plugin.'
      }]
    }
    if (!isRecord(entry)) return []
    const rawRisk = stringValue(entry.risk, 'medium')
    const risk = rawRisk === 'low' || rawRisk === 'high' ? rawRisk : 'medium'
    return [{
      id: stringValue(entry.id, `permission-${index + 1}`),
      kind: stringValue(entry.kind, 'resource').replaceAll('-', ' '),
      access: stringValue(entry.access, 'read'),
      required: entry.required !== false,
      scopes: Array.isArray(entry.scopes) ? entry.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
      risk,
      rationale: stringValue(entry.rationale, 'Required for the declared plugin capability.')
    }]
  })
}

function normalizePlugin(input: unknown, index: number): MarketplacePluginView | null {
  if (!isRecord(input)) return null
  const manifest = isRecord(input.manifest) ? input.manifest : input
  const installation = recordValue(input.installation)
  const auth = recordValue(manifest.auth)
  const publisher = recordValue(manifest.publisher)
  const connectionRecord = recordValue(input.connection)
  const diagnostic = recordValue(input.diagnostic)
  const lifecycle = normalizeLifecycle(input, installation)
  const connection = stringValue(connectionRecord.state ?? input.connectionState) || null
  const manifestVersion = stringValue(manifest.version, '—')
  const installedVersion = stringValue(installation.installedVersion ?? input.installedVersion) || null
  const explicitUpdate = input.updateAvailable === true || input.hasUpdate === true
  const inferredUpdate = Boolean(installedVersion && manifestVersion !== '—' && installedVersion !== manifestVersion)
  const capabilities = Array.isArray(manifest.capabilities)
    ? manifest.capabilities.flatMap((capability) => {
        if (typeof capability === 'string') return capability
        return isRecord(capability) ? stringValue(capability.title ?? capability.id) : []
      }).filter(Boolean)
    : []
  const configSchema = recordValue(manifest.configSchema)
  const configFields = recordValue(configSchema.fields)
  const error = stringValue(installation.lastError ?? input.error)
    || (lifecycle === 'error' ? stringValue(diagnostic.message, 'Plugin lifecycle failed.') : '')

  return {
    id: stringValue(manifest.id, `plugin-${index + 1}`),
    name: stringValue(manifest.name, 'Unnamed plugin'),
    description: stringValue(manifest.description, 'No description was provided by the plugin manifest.'),
    version: manifestVersion,
    installedVersion,
    publisher: stringValue(publisher.name ?? manifest.publisherName, 'Unknown publisher'),
    category: stringValue(manifest.category ?? manifest.kind, 'integration'),
    lifecycle,
    connection,
    connectionReason: stringValue(connectionRecord.reason ?? diagnostic.message) || null,
    updateAvailable: explicitUpdate || inferredUpdate,
    authRequired: auth.required === true,
    authMode: stringValue(auth.mode, auth.required === true ? 'credentials' : 'none'),
    permissions: normalizePermissions(manifest.permissions),
    capabilities,
    configFields: Object.keys(configFields).length,
    error: error || null
  }
}

function normalizePlugins(input: readonly unknown[]): MarketplacePluginView[] {
  return input.flatMap((plugin, index) => normalizePlugin(plugin, index) ?? [])
}

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function statusFor(plugin: MarketplacePluginView): { label: string; tone: string; explanation?: string } {
  if (plugin.lifecycle === 'error' || plugin.connection === 'error') {
    return { label: 'Error', tone: 'danger', explanation: plugin.error ?? plugin.connectionReason ?? 'The plugin reported an error.' }
  }
  if (plugin.updateAvailable) return { label: 'Update available', tone: 'update' }
  if (BUSY_STATES.has(plugin.lifecycle)) {
    return { label: plugin.lifecycle.replace('-', ' '), tone: 'busy' }
  }
  if (plugin.lifecycle === 'enabled') {
    if (plugin.connection === 'connected') return { label: 'Connected', tone: 'success' }
    if (plugin.connection === 'degraded') return { label: 'Degraded', tone: 'warning', explanation: plugin.connectionReason ?? undefined }
    if (plugin.authRequired && (plugin.connection === 'disconnected' || plugin.connection === null)) {
      return { label: 'Auth required', tone: 'warning', explanation: plugin.connectionReason ?? 'Connect an account before using this plugin.' }
    }
    return { label: 'Enabled', tone: 'success', explanation: plugin.connectionReason ?? 'Enabled; connection has not been verified.' }
  }
  if (plugin.lifecycle === 'disabled') return { label: 'Disabled', tone: 'muted' }
  if (plugin.lifecycle === 'installed') return { label: 'Installed', tone: 'neutral' }
  return { label: 'Not installed', tone: 'muted' }
}

function resolveDefaultApi(): PluginMarketplaceApi | undefined {
  if (typeof window === 'undefined') return undefined
  const bridge = (window as unknown as { api?: { plugins?: PluginMarketplaceApi } }).api?.plugins
  return bridge
}

function PluginMark({ name }: { name: string }): JSX.Element {
  const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('')
  return <span className="plugin-marketplace-mark" aria-hidden="true">{initials || 'P'}</span>
}

export default function PluginMarketplacePage({ api: suppliedApi, initialPlugins }: PluginMarketplacePageProps): JSX.Element {
  const api = suppliedApi ?? resolveDefaultApi()
  const [plugins, setPlugins] = useState<MarketplacePluginView[]>(() => normalizePlugins(initialPlugins ?? []))
  const [loading, setLoading] = useState(initialPlugins === undefined && Boolean(api))
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [stateFilter, setStateFilter] = useState('all')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [busyPlugin, setBusyPlugin] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!api) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(null)
    try {
      const result = await api.list()
      setPlugins(normalizePlugins(listValue(result)))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'The plugin catalog could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (initialPlugins !== undefined) {
      setPlugins(normalizePlugins(initialPlugins))
      setLoading(false)
      return
    }
    void load()
  }, [initialPlugins, load])

  const categories = useMemo(
    () => [...new Set(plugins.map((plugin) => plugin.category))].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b))),
    [plugins]
  )

  const visiblePlugins = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return plugins.filter((plugin) => {
      if (category !== 'all' && plugin.category !== category) return false
      const status = statusFor(plugin)
      if (stateFilter === 'installed' && plugin.lifecycle === 'not-installed') return false
      if (stateFilter === 'enabled' && plugin.lifecycle !== 'enabled') return false
      if (stateFilter === 'needs-attention' && !['danger', 'warning', 'update'].includes(status.tone)) return false
      if (!normalizedQuery) return true
      return [plugin.name, plugin.description, plugin.publisher, categoryLabel(plugin.category), ...plugin.capabilities]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
    })
  }, [category, plugins, query, stateFilter])

  const installedCount = plugins.filter((plugin) => plugin.lifecycle !== 'not-installed').length
  const connectedCount = plugins.filter((plugin) => plugin.connection === 'connected').length

  const runAction = async (plugin: MarketplacePluginView, action: keyof PluginMarketplaceApi): Promise<void> => {
    const handler = api?.[action]
    if (typeof handler !== 'function') return
    setBusyPlugin(plugin.id)
    setActionMessage(null)
    try {
      const result = await (handler as (id: string) => Promise<unknown>)(plugin.id)
      const returned = listValue(result)
      if (returned.length) setPlugins(normalizePlugins(returned))
      else if (api) await load()
      const response = recordValue(result)
      if (response.ok === false) {
        setActionMessage(`${plugin.name}: ${stringValue(response.reason, `${String(action)} is not available.`)}`)
      } else {
        setActionMessage(`${plugin.name}: ${String(action)} completed.`)
      }
    } catch (error) {
      setActionMessage(`${plugin.name}: ${error instanceof Error ? error.message : `${String(action)} failed.`}`)
    } finally {
      setBusyPlugin(null)
    }
  }

  const toggleDetails = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <main className="plugin-marketplace-page">
      <div className="plugin-marketplace-shell">
        <header className="plugin-marketplace-hero">
          <div>
            <p className="plugin-marketplace-eyebrow">Extensions</p>
            <h1>Plugins</h1>
            <p className="plugin-marketplace-subtitle">
              Connect Akorith to the tools you already use. Every plugin declares its access before installation.
            </p>
          </div>
          <div className="plugin-marketplace-summary" aria-label="Marketplace summary">
            <span><strong>{plugins.length}</strong> available</span>
            <span><strong>{installedCount}</strong> installed</span>
            <span><strong>{connectedCount}</strong> connected</span>
          </div>
        </header>

        <section className="plugin-marketplace-toolbar" aria-label="Plugin filters">
          <label className="plugin-marketplace-search">
            <span className="sr-only">Search plugins</span>
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>
            <input
              type="search"
              value={query}
              placeholder="Search plugins and capabilities"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="plugin-marketplace-select">
            <span>Category</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="all">All categories</option>
              {categories.map((item) => <option value={item} key={item}>{categoryLabel(item)}</option>)}
            </select>
          </label>
          <label className="plugin-marketplace-select">
            <span>Status</span>
            <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
              <option value="all">All statuses</option>
              <option value="installed">Installed</option>
              <option value="enabled">Enabled</option>
              <option value="needs-attention">Needs attention</option>
            </select>
          </label>
          {api && (
            <button className="plugin-marketplace-refresh" type="button" onClick={() => void load()} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
        </section>

        <div className="plugin-marketplace-live" role="status" aria-live="polite">
          {actionMessage}
        </div>

        {loadError && (
          <div className="plugin-marketplace-alert" role="alert">
            <div><strong>Marketplace unavailable</strong><span>{loadError}</span></div>
            {api && <button type="button" onClick={() => void load()}>Try again</button>}
          </div>
        )}

        {loading && plugins.length === 0 ? (
          <div className="plugin-marketplace-loading" role="status">Loading the plugin catalog…</div>
        ) : (
          <section className="plugin-marketplace-grid" aria-label="Plugin catalog">
            {visiblePlugins.map((plugin) => {
              const status = statusFor(plugin)
              const isExpanded = expanded.has(plugin.id)
              const isBusy = busyPlugin === plugin.id || BUSY_STATES.has(plugin.lifecycle)
              const hasConnectionAction = plugin.lifecycle === 'enabled'
                && plugin.connection !== 'connected'
                && typeof api?.connect === 'function'
              return (
                <article className="plugin-marketplace-card" key={plugin.id} aria-labelledby={`plugin-${plugin.id}-title`}>
                  <div className="plugin-marketplace-card-top">
                    <PluginMark name={plugin.name} />
                    <div className="plugin-marketplace-card-heading">
                      <h2 id={`plugin-${plugin.id}-title`}>{plugin.name}</h2>
                      <p>{plugin.publisher} · {categoryLabel(plugin.category)}</p>
                    </div>
                    <span className={`plugin-marketplace-status is-${status.tone}`} title={status.explanation}>{status.label}</span>
                  </div>

                  <p className="plugin-marketplace-description">{plugin.description}</p>
                  {status.explanation && status.tone !== 'muted' && (
                    <p className={`plugin-marketplace-state-note is-${status.tone}`}>{status.explanation}</p>
                  )}
                  <div className="plugin-marketplace-meta">
                    <span>v{plugin.version}</span>
                    <span>{plugin.permissions.length} permission{plugin.permissions.length === 1 ? '' : 's'}</span>
                    <span>{plugin.capabilities.length} capabilit{plugin.capabilities.length === 1 ? 'y' : 'ies'}</span>
                  </div>

                  <div className="plugin-marketplace-actions">
                    {plugin.lifecycle === 'not-installed' && api?.install && (
                      <button className="is-primary" type="button" disabled={isBusy} onClick={() => void runAction(plugin, 'install')}>Install</button>
                    )}
                    {(plugin.lifecycle === 'installed' || plugin.lifecycle === 'disabled') && api?.enable && (
                      <button className="is-primary" type="button" disabled={isBusy} onClick={() => void runAction(plugin, 'enable')}>Enable</button>
                    )}
                    {plugin.lifecycle === 'enabled' && api?.disable && (
                      <button type="button" disabled={isBusy} onClick={() => void runAction(plugin, 'disable')}>Disable</button>
                    )}
                    {plugin.updateAvailable && api?.update && (
                      <button className="is-primary" type="button" disabled={isBusy} onClick={() => void runAction(plugin, 'update')}>Update</button>
                    )}
                    {hasConnectionAction && (
                      <button className="is-primary" type="button" disabled={isBusy} onClick={() => void runAction(plugin, 'connect')}>Connect</button>
                    )}
                    {plugin.configFields > 0 && api?.configure && plugin.lifecycle !== 'not-installed' && (
                      <button type="button" disabled={isBusy} onClick={() => void runAction(plugin, 'configure')}>Configure</button>
                    )}
                    {plugin.lifecycle !== 'not-installed' && api?.uninstall && (
                      <button className="is-danger" type="button" disabled={isBusy} onClick={() => void runAction(plugin, 'uninstall')}>Uninstall</button>
                    )}
                    {plugin.lifecycle === 'error' && api?.check && (
                      <button type="button" disabled={isBusy} onClick={() => void runAction(plugin, 'check')}>Retry check</button>
                    )}
                    <button
                      className="plugin-marketplace-details-toggle"
                      type="button"
                      aria-expanded={isExpanded}
                      aria-controls={`plugin-${plugin.id}-details`}
                      onClick={() => toggleDetails(plugin.id)}
                    >
                      {isExpanded ? 'Hide access' : 'Review access'}
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="plugin-marketplace-details" id={`plugin-${plugin.id}-details`}>
                      <div className="plugin-marketplace-detail-heading">
                        <div><strong>Permission disclosure</strong><span>Review required resources before installation.</span></div>
                        <span>{plugin.authRequired ? `${plugin.authMode} authentication` : 'No credential required'}</span>
                      </div>
                      {plugin.permissions.length ? (
                        <ul className="plugin-marketplace-permissions">
                          {plugin.permissions.map((permission) => (
                            <li key={permission.id}>
                              <span className={`plugin-marketplace-risk is-${permission.risk}`}>{permission.risk}</span>
                              <div>
                                <strong>{permission.access} {permission.kind}{permission.required ? ' · required' : ' · optional'}</strong>
                                <p>{permission.rationale}</p>
                                {permission.scopes.length > 0 && <code>{permission.scopes.join(', ')}</code>}
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="plugin-marketplace-no-access">This manifest declares no external permissions.</p>
                      )}
                      {plugin.error && <p className="plugin-marketplace-error-detail">{plugin.error}</p>}
                    </div>
                  )}
                </article>
              )
            })}
          </section>
        )}

        {!loading && !loadError && plugins.length > 0 && visiblePlugins.length === 0 && (
          <div className="plugin-marketplace-empty">
            <strong>No matching plugins</strong>
            <span>Try another search, category, or status.</span>
            <button type="button" onClick={() => { setQuery(''); setCategory('all'); setStateFilter('all') }}>Clear filters</button>
          </div>
        )}

        {!loading && !loadError && plugins.length === 0 && (Boolean(api) || initialPlugins !== undefined) && (
          <div className="plugin-marketplace-empty">
            <strong>No plugins available</strong>
            <span>The marketplace returned an empty catalog.</span>
          </div>
        )}

        {!loading && !loadError && plugins.length === 0 && !api && initialPlugins === undefined && (
          <div className="plugin-marketplace-empty">
            <strong>Plugin service unavailable</strong>
            <span>This build does not expose a marketplace API.</span>
          </div>
        )}
      </div>
    </main>
  )
}
