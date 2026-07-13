import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PluginInfo, PluginKind, PluginPermission, PluginStatus } from '../../../preload/index.d'

// The page reads the live plugin registry + diagnostics from the plugin manager.
// Enable/disable is config-only; nothing executes from this surface.

const KIND_LABEL: Record<PluginKind, string> = {
  agent: 'Agents',
  tool: 'Tools',
  workbench: 'Workbench Panels',
  automation: 'Automations',
  model_provider: 'Model Providers',
  integration: 'Integrations',
  memory: 'Memory',
  browser: 'Browser',
  telemetry: 'Telemetry'
}

const STATUS_LABEL: Record<PluginStatus, string> = {
  built_in: 'Built-in',
  available: 'Available',
  unavailable: 'Unavailable',
  disabled: 'Disabled',
  planned: 'Planned',
  error: 'Error'
}

const PERMISSION_LABEL: Record<PluginPermission, string> = {
  filesystem_read: 'Read files',
  filesystem_write: 'Write files',
  terminal_read: 'Read terminal',
  terminal_write: 'Send to terminal',
  network: 'Network',
  git_read: 'Read git',
  git_write: 'Modify git',
  browser: 'Control browser',
  memory_read: 'Read memory',
  memory_write: 'Write memory',
  model_runtime: 'Model runtime',
  controller_api: 'Controller API',
  secrets: 'Secrets'
}

const SENSITIVE = new Set<PluginPermission>([
  'filesystem_write',
  'terminal_write',
  'git_write',
  'browser',
  'memory_write',
  'secrets'
])

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

export default function Plugins(): JSX.Element {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [scope, setScope] = useState<'all' | 'enabled'>('all')
  const [kind, setKind] = useState<'all' | PluginKind>('all')
  const [query, setQuery] = useState('')
  const [checking, setChecking] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [chromaEndpoint, setChromaEndpoint] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      setPlugins(await window.api.plugins.list())
    } catch {
      setPlugins([])
    }
  }, [])

  const runChecks = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      setPlugins(await window.api.plugins.checkAll())
    } catch {
      /* keep current */
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void load().then(() => runChecks())
    void window.api.plugins
      .getSettings()
      .then((settings) => setChromaEndpoint(settings.chromaEndpoint ?? ''))
      .catch(() => setChromaEndpoint(''))
  }, [load, runChecks])

  const saveChromaEndpoint = async (): Promise<void> => {
    try {
      const settings = await window.api.plugins.setChromaEndpoint(chromaEndpoint.trim())
      setChromaEndpoint(settings.chromaEndpoint ?? '')
    } catch {
      /* keep current */
    }
  }

  const toggle = async (plugin: PluginInfo): Promise<void> => {
    try {
      const next = plugin.enabled ? await window.api.plugins.disable(plugin.id) : await window.api.plugins.enable(plugin.id)
      setPlugins(next)
    } catch {
      /* keep current */
    }
  }

  const checkOne = async (plugin: PluginInfo): Promise<void> => {
    try {
      await window.api.plugins.check(plugin.id)
      await load()
    } catch {
      /* keep current */
    }
  }

  const kinds = useMemo(() => [...new Set((plugins ?? []).map((plugin) => plugin.kind))], [plugins])
  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return (plugins ?? []).filter((plugin) => {
      if (scope === 'enabled' && !plugin.enabled) return false
      if (kind !== 'all' && plugin.kind !== kind) return false
      if (!normalizedQuery) return true
      return `${plugin.name} ${plugin.description} ${KIND_LABEL[plugin.kind]}`.toLowerCase().includes(normalizedQuery)
    })
  }, [plugins, scope, kind, query])
  const groupedPlugins = useMemo(() => {
    const featured: PluginInfo[] = []
    const more: PluginInfo[] = []
    for (const plugin of visible) {
      if (plugin.effectiveStatus === 'available' || plugin.effectiveStatus === 'built_in') featured.push(plugin)
      else more.push(plugin)
    }
    return [
      { id: 'featured', label: 'Featured', plugins: featured },
      { id: 'more', label: 'More plugins', plugins: more }
    ].filter((group) => group.plugins.length > 0)
  }, [visible])
  const availableCount = (plugins ?? []).filter(
    (plugin) => plugin.effectiveStatus === 'available' || plugin.effectiveStatus === 'built_in'
  ).length

  const revealPlugin = (id: string): void => {
    setQuery('')
    setScope('all')
    setKind('all')
    setExpanded(id)
  }

  return (
    <main className="plugins-page">
      <div className="plugins-inner">
        <header className="plugins-header">
          <div>
            <h1>Plugins</h1>
            <p>Work with Akorith across your agents, tools, memory, and local runtimes.</p>
          </div>
        </header>

        <label className="plugins-search">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.25" />
            <path d="m12.4 12.4 4 4" />
          </svg>
          <input
            type="search"
            value={query}
            placeholder="Search plugins"
            aria-label="Search plugins"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <section className="plugins-installed" aria-labelledby="plugins-installed-title">
          <div className="plugins-section-head">
            <h2 id="plugins-installed-title">Installed</h2>
            <div className="plugins-header-actions">
              <span className="plugins-tag">{plugins ? `${availableCount}/${plugins.length} ready` : 'Loading...'}</span>
              <button type="button" className="plugins-recheck" disabled={checking} onClick={() => void runChecks()}>
                {checking ? 'Checking...' : 'Re-check all'}
              </button>
            </div>
          </div>
          <div className="plugins-installed-strip">
            {(plugins ?? []).map((plugin) => (
              <button
                key={plugin.id}
                type="button"
                className={`plugin-installed-mark status-${plugin.effectiveStatus}`}
                title={`${plugin.name} - ${STATUS_LABEL[plugin.effectiveStatus]}`}
                aria-label={`Show ${plugin.name} details`}
                onClick={() => revealPlugin(plugin.id)}
              >
                {initialsFor(plugin.name)}
              </button>
            ))}
            {plugins && plugins.length === 0 && <span className="plugins-empty-inline">No plugins registered</span>}
          </div>
        </section>

        <div className="plugins-browser-toolbar">
          <div className="plugins-filters" role="group" aria-label="Plugin visibility">
            <button
              type="button"
              className={`plugins-filter ${scope === 'all' ? 'is-active' : ''}`}
              aria-pressed={scope === 'all'}
              onClick={() => setScope('all')}
            >
              All
            </button>
            <button
              type="button"
              className={`plugins-filter ${scope === 'enabled' ? 'is-active' : ''}`}
              aria-pressed={scope === 'enabled'}
              onClick={() => setScope('enabled')}
            >
              Enabled
            </button>
          </div>
          <label className="plugins-kind-filter">
            <span>Category</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as 'all' | PluginKind)}>
              <option value="all">All categories</option>
              {kinds.map((pluginKind) => (
                <option key={pluginKind} value={pluginKind}>
                  {KIND_LABEL[pluginKind]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="plugins-groups">
          {groupedPlugins.map((group) => (
            <section className="plugin-group" key={group.id} aria-labelledby={`plugin-group-${group.id}`}>
              <div className="plugin-group-head">
                <h2 id={`plugin-group-${group.id}`}>{group.label}</h2>
                <span>{group.plugins.length}</span>
              </div>
              <div className="plugins-list">
                {group.plugins.map((plugin) => {
                  const isOpen = expanded === plugin.id
                  return (
                    <article className={`plugin-card status-${plugin.effectiveStatus} ${isOpen ? 'is-open' : ''}`} key={plugin.id}>
                      <div className="plugin-card-summary">
                        <span className="plugin-card-mark" aria-hidden="true">
                          {initialsFor(plugin.name)}
                        </span>
                        <div className="plugin-card-copy">
                          <div className="plugin-card-head">
                            <span className="plugin-card-name">{plugin.name}</span>
                            <span className="plugin-card-version">v{plugin.version}</span>
                          </div>
                          <p className="plugin-card-desc">{plugin.description}</p>
                        </div>
                        <span className={`plugin-status status-${plugin.effectiveStatus}`}>
                          {STATUS_LABEL[plugin.effectiveStatus]}
                        </span>
                        <button
                          type="button"
                          className="plugin-more-button"
                          aria-label={`${isOpen ? 'Hide' : 'Show'} ${plugin.name} details`}
                          aria-expanded={isOpen}
                          onClick={() => setExpanded(isOpen ? null : plugin.id)}
                        >
                          ...
                        </button>
                      </div>

                      {isOpen && (
                        <div className="plugin-details">
                          {plugin.diagnostic && (
                            <div className={`plugin-diagnostic ${plugin.diagnostic.available ? 'is-ok' : 'is-warn'}`}>
                              {plugin.diagnostic.message}
                            </div>
                          )}

                          <div className="plugin-perms" aria-label="Requested permissions">
                            {plugin.permissions.map((permission) => (
                              <span className={`plugin-perm ${SENSITIVE.has(permission) ? 'is-sensitive' : ''}`} key={permission}>
                                {PERMISSION_LABEL[permission]}
                              </span>
                            ))}
                          </div>

                          <div className="plugin-actions">
                            <label className="plugin-toggle" title={plugin.enabled ? 'Disable (config only)' : 'Enable (config only)'}>
                              <input type="checkbox" checked={plugin.enabled} onChange={() => void toggle(plugin)} />
                              <span>{plugin.enabled ? 'Enabled' : 'Disabled'}</span>
                            </label>
                            <button type="button" className="plugin-check" onClick={() => void checkOne(plugin)}>
                              Check
                            </button>
                            <button type="button" className="plugin-install" disabled title="Plugin execution is not available yet">
                              Coming soon
                            </button>
                          </div>

                          <div className="plugin-details-meta">
                            <span>{plugin.builtIn ? 'Built-in' : 'Local'}</span>
                            <code>{plugin.id}</code>
                            {plugin.docsUrl && <code>{plugin.docsUrl}</code>}
                          </div>

                          {plugin.safetyNotes.length > 0 && (
                            <div className="plugin-details-notes">
                              {plugin.safetyNotes.map((note) => (
                                <div key={`${plugin.id}-${note}`}>- {note}</div>
                              ))}
                            </div>
                          )}

                          {plugin.id === 'chroma-memory' && (
                            <div className="plugin-chroma">
                              <span>Chroma HTTP endpoint (optional, no ingestion yet)</span>
                              <div className="settings-path-row">
                                <input
                                  value={chromaEndpoint}
                                  placeholder="http://127.0.0.1:8000"
                                  spellCheck={false}
                                  onChange={(event) => setChromaEndpoint(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') void saveChromaEndpoint()
                                  }}
                                />
                                <button type="button" onClick={() => void saveChromaEndpoint()}>
                                  Save
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
            </section>
          ))}
          {plugins && visible.length === 0 && (
            <div className="plugins-empty-state">
              <strong>No matching plugins</strong>
              <span>Try another search or category.</span>
            </div>
          )}
        </div>

        <div className="plugins-note">
          Plugin execution and remote installation are not available yet. Diagnostics are read-only, and permissions show
          the access each plugin would request.
        </div>
      </div>
    </main>
  )
}
