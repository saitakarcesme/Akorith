import { detectCliAgent } from '../status'
import { existingProviderRuntimeCapability } from '../runtime'
import type { AgentAdapter, AgentAdapterMetadata } from '../types'

const metadata: AgentAdapterMetadata = {
  id: 'codex',
  displayName: 'Codex CLI',
  kind: 'cli',
  executableName: 'codex',
  status: 'unknown',
  description: 'Codex command-line integration used for ChatGPT provider calls and Olympus terminal sessions.',
  capabilities: ['chat', 'terminal', 'exec', 'file_patch', 'review', 'mission_planning'],
  currentIntegrationNotes: [
    'Provider runtime lives in src/main/providers/chatgpt.ts.',
    'PTY command kinds for Codex live in src/main/pty.ts.',
    'Chat provider uses codex exec with --output-last-message and estimated usage.'
  ],
  futureIntegrationNotes: [
    'Model Codex as a first-class CLI agent with durable sessions, status, and capabilities.',
    'Keep the current ChatGPT provider behavior until the AgentAdapter bridge is deliberately introduced.'
  ],
  safetyNotes: [
    'Codex file edits currently happen through the CLI or PTY flow, not through this metadata adapter.',
    'This phase does not change Codex sandbox, approval, or terminal behavior.'
  ]
}

export const codexAgentAdapter: AgentAdapter = {
  metadata,
  detect: () => detectCliAgent({ id: 'codex', executableName: 'codex' }),
  getRuntimeCapabilities: () =>
    existingProviderRuntimeCapability({
      canExecute: true,
      canUseExistingTerminal: true
    })
}
