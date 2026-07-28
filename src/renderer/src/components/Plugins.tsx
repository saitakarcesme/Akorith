import { memo, useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { PluginInfo, PluginKind } from '../../../preload/index.d'
import akorithLogo from '../assets/plugin-logos/akorith.png'
import browserLogo from '../assets/plugin-logos/browser.png'
import chromaLogo from '../assets/plugin-logos/chroma.ico'
import githubLogo from '../assets/plugin-logos/github.png'
import gitLogo from '../assets/plugin-logos/git.svg'
import gitLfsLogo from '../assets/plugin-logos/git-lfs.ico'
import graphvizLogo from '../assets/plugin-logos/graphviz.png'
import imagemagickLogo from '../assets/plugin-logos/imagemagick.png'
import jqLogo from '../assets/plugin-logos/jq.svg'
import nodejsLogo from '../assets/plugin-logos/nodejs.svg'
import ollamaLogo from '../assets/plugin-logos/ollama.png'
import opencodeLogo from '../assets/plugin-logos/opencode-square.svg'
import pandocLogo from '../assets/plugin-logos/pandoc.svg'
import popplerLogo from '../assets/plugin-logos/poppler.png'
import pythonLogo from '../assets/plugin-logos/python.svg'
import ripgrepLogo from '../assets/plugin-logos/ripgrep.svg'
import shellcheckLogo from '../assets/plugin-logos/shellcheck.svg'
import sqliteLogo from '../assets/plugin-logos/sqlite.gif'
import tesseractLogo from '../assets/plugin-logos/tesseract.png'
import ffmpegLogo from '../assets/plugin-logos/ffmpeg.png'
import ytDlpLogo from '../assets/plugin-logos/yt-dlp.ico'

type PluginTab = 'plugins' | 'apps' | 'mcps'
type PluginCategoryId = 'agents' | 'project' | 'runtime' | 'memory' | 'media' | 'quality'

interface PluginCategory {
  id: PluginCategoryId
  label: string
}

const PLUGIN_TABS: PluginTab[] = ['plugins', 'apps', 'mcps']

const PLUGIN_CATEGORIES: PluginCategory[] = [
  { id: 'agents', label: 'Agents & workflow' },
  { id: 'project', label: 'Project & source control' },
  { id: 'runtime', label: 'Runtimes & data' },
  { id: 'media', label: 'Documents & media' },
  { id: 'memory', label: 'Memory & browser' },
  { id: 'quality', label: 'Quality & diagrams' }
]

const CATEGORY_BY_PLUGIN: Record<string, PluginCategoryId> = {
  'opencode-agent': 'agents',
  'testlab-extensions': 'agents',
  'mission-runners': 'agents',
  'controller-api': 'agents',
  'github-workbench': 'project',
  'git-cli': 'project',
  'git-lfs-tool': 'project',
  'ripgrep-tool': 'project',
  'remote-ollama-telemetry': 'runtime',
  'python-runtime': 'runtime',
  'node-runtime': 'runtime',
  'jq-tool': 'runtime',
  'sqlite-tool': 'runtime',
  'hermes-memory': 'memory',
  'chroma-memory': 'memory',
  'browser-automation': 'memory',
  'ffmpeg-tool': 'media',
  'pandoc-tool': 'media',
  'poppler-tool': 'media',
  'imagemagick-tool': 'media',
  'tesseract-tool': 'media',
  'yt-dlp-tool': 'media',
  'shellcheck-tool': 'quality',
  'graphviz-tool': 'quality'
}

const CATEGORY_BY_KIND: Record<PluginKind, PluginCategoryId> = {
  agent: 'agents',
  automation: 'agents',
  workbench: 'project',
  integration: 'project',
  model_provider: 'runtime',
  telemetry: 'runtime',
  memory: 'memory',
  browser: 'memory',
  tool: 'quality'
}

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
  'controller-api': akorithLogo,
  'git-cli': gitLogo,
  'ripgrep-tool': ripgrepLogo,
  'jq-tool': jqLogo,
  'sqlite-tool': sqliteLogo,
  'ffmpeg-tool': ffmpegLogo,
  'pandoc-tool': pandocLogo,
  'poppler-tool': popplerLogo,
  'imagemagick-tool': imagemagickLogo,
  'tesseract-tool': tesseractLogo,
  'graphviz-tool': graphvizLogo,
  'python-runtime': pythonLogo,
  'node-runtime': nodejsLogo,
  'git-lfs-tool': gitLfsLogo,
  'shellcheck-tool': shellcheckLogo,
  'yt-dlp-tool': ytDlpLogo
}

function conciseDescription(plugin: PluginInfo): string {
  if (plugin.id === 'opencode-agent') return 'Run OpenCode locally for Workspace and Goal tasks'
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

function pluginCategory(plugin: PluginInfo): PluginCategoryId {
  return CATEGORY_BY_PLUGIN[plugin.id] ?? CATEGORY_BY_KIND[plugin.kind]
}

interface PluginRowProps {
  plugin: PluginInfo
  onToggle(plugin: PluginInfo): void
}

const PluginRow = memo(function PluginRow({ plugin, onToggle }: PluginRowProps): JSX.Element {
  const logo = PLUGIN_LOGOS[plugin.id]
  const ready = plugin.enabled && plugin.diagnostic?.available === true
  const state = !plugin.enabled
    ? 'Disabled'
    : ready
      ? 'Ready'
      : plugin.effectiveStatus === 'planned'
        ? 'Planned'
        : plugin.diagnosticCommand
          ? 'Not installed'
          : 'Unavailable'
  const diagnostic = ready
    ? plugin.diagnostic?.message
    : plugin.installHint ?? plugin.diagnostic?.message

  return (
    <article className={`plugin-row ${logo ? 'has-logo' : 'has-no-logo'}`}>
      {logo && (
        <div className={`plugin-row-logo ${plugin.id === 'remote-ollama-telemetry' ? 'is-light' : ''}`}>
          <img src={logo} alt="" loading="lazy" decoding="async" />
        </div>
      )}
      <div className="plugin-row-copy">
        <div className="plugin-row-title">
          <strong>{plugin.name}</strong>
          <span className={`plugin-state is-${ready ? 'ready' : plugin.enabled ? 'missing' : 'disabled'}`}>{state}</span>
        </div>
        <p>{conciseDescription(plugin)}</p>
        {diagnostic && <small className={ready ? '' : 'is-warn'}>{diagnostic}</small>}
      </div>
      <label className="codex-switch" title={plugin.enabled ? `Disable ${plugin.name}` : `Enable ${plugin.name}`}>
        <input type="checkbox" checked={plugin.enabled} onChange={() => onToggle(plugin)} />
        <span aria-hidden="true" />
        <em className="sr-only">{plugin.enabled ? 'Enabled' : 'Disabled'}</em>
      </label>
    </article>
  )
})

export default function Plugins(): JSX.Element {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [tab, setTab] = useState<PluginTab>('plugins')
  const [query, setQuery] = useState('')
  const [checking, setChecking] = useState(false)

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
      await load()
    } finally {
      setChecking(false)
    }
  }, [load])

  useEffect(() => {
    // Main warms the bounded diagnostics cache after first paint. Loading this
    // surface should only read that snapshot; the explicit button owns a fresh
    // tool scan so navigation never launches a duplicate process storm.
    void load()
  }, [load])

  const toggle = useCallback(async (plugin: PluginInfo): Promise<void> => {
    const next = plugin.enabled
      ? await window.api.plugins.disable(plugin.id)
      : await window.api.plugins.enable(plugin.id)
    setPlugins(next)
  }, [])

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return plugins ?? []
    return (plugins ?? []).filter((plugin) =>
      [plugin.name, conciseDescription(plugin), KIND_LABEL[plugin.kind], plugin.diagnostic?.message ?? '', plugin.installHint ?? '']
        .some((value) => value.toLowerCase().includes(normalized))
    )
  }, [plugins, query])

  const readyCount = useMemo(
    () => (plugins ?? []).filter((plugin) => plugin.enabled && plugin.diagnostic?.available).length,
    [plugins]
  )

  const categorized = useMemo(() => {
    const grouped = new Map<PluginCategoryId, PluginInfo[]>(
      PLUGIN_CATEGORIES.map((category) => [category.id, []])
    )
    for (const plugin of visible) grouped.get(pluginCategory(plugin))?.push(plugin)
    return PLUGIN_CATEGORIES
      .map((category) => ({ ...category, plugins: grouped.get(category.id) ?? [] }))
      .filter((category) => category.plugins.length > 0)
  }, [visible])

  const handleTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const current = PLUGIN_TABS.indexOf(tab)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? PLUGIN_TABS.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + PLUGIN_TABS.length) % PLUGIN_TABS.length
    event.preventDefault()
    setTab(PLUGIN_TABS[next])
    document.getElementById(`plugins-${PLUGIN_TABS[next]}-tab`)?.focus()
  }, [tab])

  return (
    <main className="plugins-page codex-plugins-page">
      <div className="plugins-inner">
        <header className="plugins-header codex-plugins-header">
          <div>
            <h1>Plugins</h1>
            <p>{readyCount} local tools ready for Workspace and durable /loop goals</p>
          </div>
          <button type="button" className="plugins-check-button" disabled={checking} onClick={() => void runChecks()}>
            {checking ? 'Checking…' : 'Check tools'}
          </button>
        </header>

        <div className="plugins-toolbar">
          <div className="plugins-tabs research-surface-switch" role="tablist" aria-label="Plugin sources">
            <button id="plugins-plugins-tab" type="button" role="tab" aria-controls="plugins-view-panel" aria-selected={tab === 'plugins'} tabIndex={tab === 'plugins' ? 0 : -1} className={tab === 'plugins' ? 'is-active' : ''} onClick={() => setTab('plugins')} onKeyDown={handleTabKeyDown}>
              Plugins <span>{plugins?.length ?? 0}</span>
            </button>
            <button id="plugins-apps-tab" type="button" role="tab" aria-controls="plugins-view-panel" aria-selected={tab === 'apps'} tabIndex={tab === 'apps' ? 0 : -1} className={tab === 'apps' ? 'is-active' : ''} onClick={() => setTab('apps')} onKeyDown={handleTabKeyDown}>
              Apps <span>0</span>
            </button>
            <button id="plugins-mcps-tab" type="button" role="tab" aria-controls="plugins-view-panel" aria-selected={tab === 'mcps'} tabIndex={tab === 'mcps' ? 0 : -1} className={tab === 'mcps' ? 'is-active' : ''} onClick={() => setTab('mcps')} onKeyDown={handleTabKeyDown}>
              MCPs <span>0</span>
            </button>
          </div>
          <label className="plugins-search">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search plugins" aria-label="Search plugins" />
          </label>
        </div>

        <div id="plugins-view-panel" role="tabpanel" aria-labelledby={`plugins-${tab}-tab`}>
          {tab === 'plugins' ? (
            <div className="plugin-category-grid" aria-live="polite">
              {categorized.map((category) => (
                <section className="plugin-category" aria-labelledby={`plugin-category-${category.id}`} key={category.id}>
                  <header className="plugin-category-header">
                    <h2 id={`plugin-category-${category.id}`}>{category.label}</h2>
                    <span>{category.plugins.length}</span>
                  </header>
                  <div className="plugin-list">
                    {category.plugins.map((plugin) => (
                      <PluginRow key={plugin.id} plugin={plugin} onToggle={toggle} />
                    ))}
                  </div>
                </section>
              ))}
              {plugins === null && <div className="plugin-list-empty">Loading plugins…</div>}
              {plugins !== null && visible.length === 0 && <div className="plugin-list-empty">No plugins match “{query}”.</div>}
            </div>
          ) : (
            <div className="plugin-list-empty">
              {tab === 'apps' ? 'Connected apps will appear here.' : 'MCP servers will appear here.'}
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
