import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PluginInfo, PluginKind } from '../../../preload/index.d'
import akorithLogo from '../assets/plugin-logos/akorith.png'
import browserLogo from '../assets/plugin-logos/browser.png'
import chromaLogo from '../assets/plugin-logos/chroma.ico'
import githubLogo from '../assets/plugin-logos/github.png'
import ollamaLogo from '../assets/plugin-logos/ollama.png'
import opencodeLogo from '../assets/plugin-logos/opencode.png'

type PluginTab = 'plugins' | 'apps' | 'mcps'

const KIND_LABEL: Record<PluginKind, string> = {
  agent: 'Agent',
  tool: 'Tool',
  workbench: 'Workbench',
  automation: 'Automation',
  model_provider: 'Model provider',
  integration: 'Integration',
  memory: 'Memory',
  browser: 'Browser',
  telemetry: 'Telemetry'
}

const PLUGIN_LOGOS: Record<string, string> = {
  'opencode-agent': opencodeLogo,
  'github-workbench': githubLogo,
  'remote-ollama-telemetry': ollamaLogo,
  'chroma-memory': chromaLogo,
  'browser-automation': browserLogo,
  'hermes-memory': akorithLogo,
  'testlab-extensions': akorithLogo,
  'mission-runners': akorithLogo,
  'controller-api': akorithLogo
}

function conciseDescription(plugin: PluginInfo): string {
  if (plugin.id === 'opencode-agent') return 'Run OpenCode as the Gaia coding agent'
  if (plugin.id === 'github-workbench') return 'Triage repositories, pull requests, issues, and checks'
  if (plugin.id === 'remote-ollama-telemetry') return 'Read GPU and runtime telemetry from a connected computer'
  if (plugin.id === 'hermes-memory') return 'Share durable memory and reusable skills across projects'
  if (plugin.id === 'chroma-memory') return 'Use Chroma as a semantic memory backend'
  if (plugin.id === 'browser-automation') return 'Control a browser for research, testing, and screenshots'
  if (plugin.id === 'testlab-extensions') return 'Generate and run tests in an isolated workspace'
  if (plugin.id === 'mission-runners') return 'Coordinate planner, executor, reviewer, and tester runs'
  if (plugin.id === 'controller-api') return 'Expose the optional read-only Akorith controller API'
  return plugin.description.split(/(?<=[.!?])\s/)[0] ?? plugin.description
}

export default function Plugins(): JSX.Element {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [tab, setTab] = useState<PluginTab>('plugins')
  const [query, setQuery] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      setPlugins(await window.api.plugins.list())
    } catch {
      setPlugins([])
    }
  }, [])

  const runChecks = useCallback(async (): Promise<void> => {
    try {
      setPlugins(await window.api.plugins.checkAll())
    } catch {
      await load()
    }
  }, [load])

  useEffect(() => {
    void load().then(runChecks)
  }, [load, runChecks])

  const toggle = async (plugin: PluginInfo): Promise<void> => {
    const next = plugin.enabled
      ? await window.api.plugins.disable(plugin.id)
      : await window.api.plugins.enable(plugin.id)
    setPlugins(next)
  }

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return plugins ?? []
    return (plugins ?? []).filter((plugin) =>
      [plugin.name, conciseDescription(plugin), KIND_LABEL[plugin.kind]].some((value) => value.toLowerCase().includes(normalized))
    )
  }, [plugins, query])

  return (
    <main className="plugins-page codex-plugins-page">
      <div className="plugins-inner">
        <header className="plugins-header codex-plugins-header">
          <div>
            <h1>Plugins</h1>
            <p>Manage plugins, apps, and MCP connections</p>
          </div>
        </header>

        <div className="plugins-toolbar">
          <div className="plugins-tabs" role="tablist" aria-label="Plugin sources">
            <button type="button" role="tab" aria-selected={tab === 'plugins'} className={tab === 'plugins' ? 'is-active' : ''} onClick={() => setTab('plugins')}>
              Plugins <span>{plugins?.length ?? 0}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === 'apps'} className={tab === 'apps' ? 'is-active' : ''} onClick={() => setTab('apps')}>
              Apps <span>0</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === 'mcps'} className={tab === 'mcps' ? 'is-active' : ''} onClick={() => setTab('mcps')}>
              MCPs <span>0</span>
            </button>
          </div>
          <label className="plugins-search">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search plugins" aria-label="Search plugins" />
          </label>
        </div>

        {tab === 'plugins' ? (
          <div className="plugin-list" aria-live="polite">
            {visible.map((plugin) => {
              const logo = PLUGIN_LOGOS[plugin.id]
              return (
              <article className="plugin-row" key={plugin.id}>
                {logo && (
                  <div className={`plugin-row-logo ${plugin.id === 'remote-ollama-telemetry' ? 'is-light' : ''}`}>
                    <img src={logo} alt="" />
                  </div>
                )}
                <div className="plugin-row-copy">
                  <div className="plugin-row-title">
                    <strong>{plugin.name}</strong>
                  </div>
                  <p>{conciseDescription(plugin)}</p>
                </div>
                <label className="codex-switch" title={plugin.enabled ? `Disable ${plugin.name}` : `Enable ${plugin.name}`}>
                  <input type="checkbox" checked={plugin.enabled} onChange={() => void toggle(plugin)} />
                  <span aria-hidden="true" />
                  <em className="sr-only">{plugin.enabled ? 'Enabled' : 'Disabled'}</em>
                </label>
              </article>
              )
            })}
            {plugins === null && <div className="plugin-list-empty">Loading plugins…</div>}
            {plugins !== null && visible.length === 0 && <div className="plugin-list-empty">No plugins match “{query}”.</div>}
          </div>
        ) : (
          <div className="plugin-list-empty">
            {tab === 'apps' ? 'Connected apps will appear here.' : 'MCP servers will appear here.'}
          </div>
        )}
      </div>
    </main>
  )
}
