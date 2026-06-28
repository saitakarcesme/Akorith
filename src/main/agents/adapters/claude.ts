import { detectCliAgent } from '../status'
import type { AgentAdapter, AgentAdapterMetadata } from '../types'

const metadata: AgentAdapterMetadata = {
  id: 'claude',
  displayName: 'Claude Code / Claude CLI',
  kind: 'cli',
  executableName: 'claude',
  status: 'unknown',
  description: 'Claude command-line integration used for planning chat and Atlantis terminal sessions.',
  capabilities: ['chat', 'terminal', 'streaming', 'review', 'mission_planning'],
  currentIntegrationNotes: [
    'Provider runtime lives in src/main/providers/claude.ts.',
    'PTY command kinds for Claude live in src/main/pty.ts.',
    'Chat provider calls claude -p with stream-json output and parses text deltas.'
  ],
  futureIntegrationNotes: [
    'Promote Claude into the universal AgentAdapter session model after the Agent Hub exists.',
    'Expose capability-specific status without replacing the current provider registry in this phase.'
  ],
  safetyNotes: [
    'This foundation does not change Claude prompt sending, streaming, PTY startup, or approval gates.',
    'Auto-mode terminal writes must continue through bridgeSend() to PtyManager.write().'
  ]
}

export const claudeAgentAdapter: AgentAdapter = {
  metadata,
  detect: () => detectCliAgent({ id: 'claude', executableName: 'claude' })
}
