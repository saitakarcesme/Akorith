import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PluginInfo, PluginKind, PluginPermission, PluginStatus } from '../../../preload/index.d'

// Phase 35: the Plugins page now reads the live plugin registry + diagnostics from
// the plugin manager (read-only). Enable/disable is config-only; nothing executes.

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

export default function Plugins(): JSX.Element {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [filter, setFilter] = useState<'all' | PluginKind>('all')
  const [checking, setChecking] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

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

  // Load the registry, then run availability diagnostics once on open.
  useEffect(() => {
    void load().then(() => runChecks())
  }, [load, runChecks])

  const toggle = async (plugin: PluginInfo): Promise<void> => {
    try {
      const next = plugin.enabled ? await window.api.plugins.disable(plugin.id) : await window.api.plugins.enable(plugin.id)
      setPlugins(next)
    } catch {
      /* ignore */
    }
  }

  const checkOne = async (plugin: PluginInfo): Promise<void> => {
    try {
      await window.api.plugins.check(plugin.id)
      await load()
    } catch {
      /* ignore */
    }
  }

  const kinds = useMemo(() => [...new Set((plugins ?? []).map((p) => p.kind))], [plugins])
  const visible = useMemo(
    () => (filter === 'all' ? plugins ?? [] : (plugins ?? []).filter((p) => p.kind === filter)),
    [plugins, filter]
  )
  const availableCount = (plugins ?? []).filter((p) => p.effectiveStatus === 'available' || p.effectiveStatus === 'built_in').length

  return (
    <main className="plugins-page">
      <div className="plugins-inner">
        <header className="plugins-header">
          <div>
            <h1>Plugins</h1>
            <p>Extend Akorith with agents, tools, workbench panels, and automations. Read-only foundation — nothing executes yet.</p>
          </div>
          <div className="plugins-header-actions">
            <span className="plugins-tag">{plugins ? `${availableCount}/${plugins.length} ready` : 'Loading…'}</span>
            <button type="button" className="dash-refresh" disabled={checking} onClick={() => void runChecks()}>
              {checking ? 'Checking…' : 'Re-check all'}
            </button>
          </div>
        </header>

        <div className="plugins-filters" role="tablist" aria-label="Plugin categories">
          <button type="button" className={`plugins-filter ${filter === 'all' ? 'is-active' : ''}`} onClick={() => setFilter('all')}>
            All
          </button>
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`plugins-filter ${filter === kind ? 'is-active' : ''}`}
              onClick={() => setFilter(kind)}
            >
              {KIND_LABEL[kind]}
            </button>
          ))}
        </div>

        <div className="plugins-grid">
          {visible.map((plugin) => {
            const isOpen = expanded === plugin.id
            return (
              <article className={`plugin-card status-${plugin.effectiveStatus}`} key={plugin.id}>
                <div className="plugin-card-head">
                  <span className="plugin-card-name">{plugin.name}</span>
                  <span className={`plugin-status status-${plugin.effectiveStatus}`}>{STATUS_LABEL[plugin.effectiveStatus]}</span>
                </div>
                <div className="plugin-card-category">
                  {KIND_LABEL[plugin.kind]} · v{plugin.version}
                  {plugin.builtIn ? ' · built-in' : ''}
                </div>
                <p className="plugin-card-desc">{plugin.description}</p>

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
                  <button type="button" className="plugin-details-btn" onClick={() => setExpanded(isOpen ? null : plugin.id)}>
                    {isOpen ? 'Hide details' : 'Details'}
                  </button>
                  <button type="button" className="plugin-install" disabled title="Plugin execution is not available yet">
                    Coming soon
                  </button>
                </div>

                {isOpen && (
                  <div className="plugin-details">
                    <div className="plugin-details-row">
                      <span>ID</span>
                      <code>{plugin.id}</code>
                    </div>
                    {plugin.docsUrl && (
                      <div className="plugin-details-row">
                        <span>Docs</span>
                        <code>{plugin.docsUrl}</code>
                      </div>
                    )}
                    <div className="plugin-details-notes">
                      {plugin.safetyNotes.map((note, index) => (
                        <div key={index}>• {note}</div>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            )
          })}
          {plugins && plugins.length === 0 && <div className="plugins-note">No plugins registered.</div>}
        </div>

        <div className="plugins-note">
          Foundation only — plugins do not execute, install, or load remote code in this phase. Permissions shown are the
          access a plugin would request once the plugin runtime ships. Diagnostics are read-only availability checks.
        </div>
      </div>
    </main>
  )
}
