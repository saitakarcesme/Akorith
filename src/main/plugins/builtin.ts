import type { PluginManifest } from './types'

// Phase 35: the built-in plugin registry (static manifests; diagnostics run live).
// Permissions describe the access each plugin WOULD need once an execution runtime
// exists — none of it is granted or exercised in this phase.

export const BUILTIN_PLUGINS: PluginManifest[] = [
  {
    id: 'opencode-agent',
    name: 'OpenCode CLI',
    version: '1.0.0',
    kind: 'agent',
    description: 'OpenCode runs locally behind Workspace and Goal. Its streamed events are rendered as one conversational project-editing flow.',
    status: 'planned',
    permissions: ['terminal_read', 'terminal_write', 'filesystem_read', 'git_read'],
    docsUrl: 'docs/phase-37-sidebar-chat-opencode-gaia.md',
    safetyNotes: [
      'Workspace and Goal stay scoped to the selected project directory.',
      'OpenCode Go login is interactive (opencode auth login); Akorith never stores or prints tokens.'
    ],
    builtIn: true
  },
  {
    id: 'github-workbench',
    name: 'GitHub Workbench',
    version: '0.1.0',
    kind: 'integration',
    description: 'Pull requests, issues, and checks as a read-first workbench panel. Phase 35 diagnoses the GitHub CLI only.',
    status: 'planned',
    permissions: ['git_read', 'network'],
    safetyNotes: ['No mutations in Phase 35.', 'Future writes would be explicit and per-action.'],
    builtIn: true
  },
  {
    id: 'remote-ollama-telemetry',
    name: 'Remote Ollama Telemetry',
    version: '0.1.0',
    kind: 'telemetry',
    description: 'A secured companion that reports remote GPU/VRAM so the Dashboard can show off-machine runtimes. Phase 35 checks local Ollama tooling and configured remote profiles.',
    status: 'planned',
    permissions: ['network', 'model_runtime'],
    safetyNotes: ['No public exposure.', 'Remote GPU telemetry needs a secured companion endpoint (future).'],
    builtIn: true
  },
  {
    id: 'hermes-memory',
    name: 'Hermes Memory / Skills',
    version: '0.1.0',
    kind: 'memory',
    description: 'Durable memory and reusable skills shared across chats, projects, and missions.',
    status: 'planned',
    permissions: ['memory_read', 'memory_write', 'filesystem_read'],
    safetyNotes: ['No memory store implemented yet.'],
    builtIn: true
  },
  {
    id: 'chroma-memory',
    name: 'Chroma Memory',
    version: '0.1.0',
    kind: 'memory',
    description: 'Vector memory backend (mission/skill/project memory, semantic search). Phase 35 only diagnoses whether Python + chromadb are available; no ingestion or embeddings.',
    status: 'planned',
    permissions: ['memory_read', 'memory_write', 'network', 'filesystem_read'],
    settingsSchema: { chromaEndpoint: { type: 'string', label: 'Chroma HTTP endpoint (optional)' } },
    safetyNotes: [
      'No documents are ingested and no embeddings are stored in Phase 35.',
      'Chroma is never auto-started; a future opt-in will manage it.'
    ],
    builtIn: true
  },
  {
    id: 'browser-automation',
    name: 'Browser / Chrome Automation',
    version: '0.1.0',
    kind: 'browser',
    description: 'Controlled browser tasks for research, web-app testing, and screenshot-assisted debugging. Phase 35 only detects whether Chrome/Chromium is installed.',
    status: 'planned',
    permissions: ['browser', 'network', 'filesystem_read'],
    safetyNotes: [
      'No browser profile data (cookies/history/passwords) is ever read.',
      'No website is automated in Phase 35 — detection only.'
    ],
    builtIn: true
  },
  {
    id: 'testlab-extensions',
    name: 'Test Lab Extensions',
    version: '1.0.0',
    kind: 'tool',
    description: 'The existing sandboxed generate-and-run Test Lab, exposed as an extensible surface.',
    status: 'built_in',
    permissions: ['filesystem_read', 'terminal_read'],
    safetyNotes: ['Built-in; runs in the existing Test Lab sandbox.'],
    builtIn: true
  },
  {
    id: 'mission-runners',
    name: 'Mission Engine Runners',
    version: '0.1.0',
    kind: 'automation',
    description: 'Planner / executor / reviewer / tester / committer runners for the Mission Engine — preview-only today.',
    status: 'planned',
    permissions: ['terminal_write', 'git_write', 'filesystem_write', 'network'],
    safetyNotes: ['No Run Mission in Phase 35.', 'Execution would be gated behind explicit per-capability approval.'],
    builtIn: true
  },
  {
    id: 'controller-api',
    name: 'API / Controller',
    version: '1.0.0',
    kind: 'integration',
    description: 'The optional local controller HTTP API itself. Status follows whether the controller is enabled and running.',
    status: 'built_in',
    permissions: ['controller_api', 'network'],
    docsUrl: 'docs/controller-api.md',
    safetyNotes: ['Loopback-only by default, token-protected, read-only in Phase 35.'],
    builtIn: true
  }
]
