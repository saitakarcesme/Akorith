import { useMemo, useState } from 'react'

// Phase 34.8: Plugins foundation. STATIC metadata only — no execution, no install,
// no remote code, no marketplace. This is the UI shell future plugin work plugs into.

type PluginCategory = 'Agents' | 'Tools' | 'Workbench Panels' | 'Automations' | 'Model Providers' | 'Integrations'
type PluginStatus = 'built-in' | 'planned' | 'disabled' | 'missing'
type PluginPermission = 'filesystem' | 'terminal' | 'network' | 'git' | 'memory'

interface PluginEntry {
  id: string
  name: string
  category: PluginCategory
  status: PluginStatus
  description: string
  permissions: PluginPermission[]
}

const CATEGORIES: PluginCategory[] = ['Agents', 'Tools', 'Workbench Panels', 'Automations', 'Model Providers', 'Integrations']

// Built-in / planned placeholders. These describe direction only — none of them
// execute anything in this phase.
const PLUGINS: PluginEntry[] = [
  {
    id: 'opencode-agent',
    name: 'OpenCode Agent',
    category: 'Agents',
    status: 'planned',
    description: 'A real OpenCode adapter session that plans and executes through the Agent OS runtime.',
    permissions: ['filesystem', 'terminal', 'git']
  },
  {
    id: 'hermes-memory',
    name: 'Hermes Memory / Skills',
    category: 'Agents',
    status: 'planned',
    description: 'Durable memory and reusable skills shared across chats, projects, and missions.',
    permissions: ['memory', 'filesystem']
  },
  {
    id: 'github-workbench',
    name: 'GitHub Workbench',
    category: 'Workbench Panels',
    status: 'planned',
    description: 'Pull requests, issues, and review threads as a read-first bottom-workbench panel.',
    permissions: ['network', 'git']
  },
  {
    id: 'remote-ollama-telemetry',
    name: 'Remote Ollama Telemetry',
    category: 'Integrations',
    status: 'planned',
    description: 'A secured companion endpoint that reports remote GPU/VRAM so the Dashboard can show off-machine runtimes.',
    permissions: ['network']
  },
  {
    id: 'browser-automation',
    name: 'Browser Automation',
    category: 'Automations',
    status: 'planned',
    description: 'Drive a sandboxed browser for research and verification flows.',
    permissions: ['network', 'filesystem']
  },
  {
    id: 'testlab-extensions',
    name: 'Test Lab Extensions',
    category: 'Tools',
    status: 'built-in',
    description: 'The existing sandboxed generate-and-run Test Lab, exposed as an extensible surface.',
    permissions: ['filesystem', 'terminal']
  },
  {
    id: 'mission-runners',
    name: 'Mission Engine Runners',
    category: 'Automations',
    status: 'planned',
    description: 'Planner / executor / reviewer / tester / committer runners for the Mission Engine — preview-only today.',
    permissions: ['filesystem', 'terminal', 'git', 'network']
  },
  {
    id: 'model-providers',
    name: 'Custom Model Providers',
    category: 'Model Providers',
    status: 'built-in',
    description: 'Claude, Codex, and local Ollama providers via the existing registry. Additional providers plug in here.',
    permissions: ['network']
  }
]

const STATUS_LABEL: Record<PluginStatus, string> = {
  'built-in': 'Built-in',
  planned: 'Planned',
  disabled: 'Disabled',
  missing: 'Missing'
}

export default function Plugins(): JSX.Element {
  const [filter, setFilter] = useState<'all' | PluginCategory>('all')

  const visible = useMemo(
    () => (filter === 'all' ? PLUGINS : PLUGINS.filter((plugin) => plugin.category === filter)),
    [filter]
  )

  return (
    <main className="plugins-page">
      <div className="plugins-inner">
        <header className="plugins-header">
          <div>
            <h1>Plugins</h1>
            <p>Extend Akorith with agents, tools, workbench panels, and automations.</p>
          </div>
          <span className="plugins-tag">Foundation · {PLUGINS.length} registered</span>
        </header>

        <div className="plugins-filters" role="tablist" aria-label="Plugin categories">
          <button
            type="button"
            className={`plugins-filter ${filter === 'all' ? 'is-active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All
          </button>
          {CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              className={`plugins-filter ${filter === category ? 'is-active' : ''}`}
              onClick={() => setFilter(category)}
            >
              {category}
            </button>
          ))}
        </div>

        <div className="plugins-grid">
          {visible.map((plugin) => (
            <article className="plugin-card" key={plugin.id}>
              <div className="plugin-card-head">
                <span className="plugin-card-name">{plugin.name}</span>
                <span className={`plugin-status status-${plugin.status}`}>{STATUS_LABEL[plugin.status]}</span>
              </div>
              <div className="plugin-card-category">{plugin.category}</div>
              <p className="plugin-card-desc">{plugin.description}</p>
              <div className="plugin-perms" aria-label="Requested permissions">
                {plugin.permissions.map((permission) => (
                  <span className="plugin-perm" key={permission}>
                    {permission}
                  </span>
                ))}
              </div>
              <button type="button" className="plugin-install" disabled title="Plugin installation is not available yet">
                Coming soon
              </button>
            </article>
          ))}
        </div>

        <div className="plugins-note">
          Static foundation only — plugins do not execute, install, or load remote code in this phase. Permissions
          shown are the access a plugin would request once the plugin system ships.
        </div>
      </div>
    </main>
  )
}
