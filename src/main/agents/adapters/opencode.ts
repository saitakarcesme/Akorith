import { detectCliAgent } from '../status'
import { PLACEHOLDER_RUNTIME_CAPABILITY } from '../runtime'
import type { AgentAdapter, AgentAdapterMetadata } from '../types'

const metadata: AgentAdapterMetadata = {
  id: 'opencode',
  displayName: 'OpenCode',
  kind: 'cli',
  executableName: 'opencode',
  status: 'unknown',
  description: 'Future CLI adapter placeholder for OpenCode as a first-class coding agent.',
  capabilities: ['chat', 'terminal', 'exec', 'file_patch', 'review', 'automation', 'mission_planning'],
  currentIntegrationNotes: [
    'OpenCode is not connected to active chat, PTY startup, provider selection, or loop execution yet.',
    'This adapter is metadata and detection only.'
  ],
  futureIntegrationNotes: [
    'Add an OpenCode CLI adapter under the Agent Hub once command behavior and session semantics are verified.',
    'Connect it to the Mission Engine through AgentAdapter sessions instead of the legacy provider registry.'
  ],
  safetyNotes: [
    'Detection only runs opencode --version.',
    'No prompts, terminal writes, file edits, or automation calls are routed to OpenCode in this phase.'
  ]
}

export const opencodeAgentAdapter: AgentAdapter = {
  metadata,
  detect: () => detectCliAgent({ id: 'opencode', executableName: 'opencode' }),
  getRuntimeCapabilities: () => PLACEHOLDER_RUNTIME_CAPABILITY
}
