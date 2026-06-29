import { staticAgentDetection } from '../status'
import { PLACEHOLDER_RUNTIME_CAPABILITY } from '../runtime'
import type { AgentAdapter, AgentAdapterMetadata } from '../types'

const metadata: AgentAdapterMetadata = {
  id: 'memory',
  displayName: 'Memory / Skills',
  kind: 'memory',
  status: 'unknown',
  description: 'Future internal adapter for Hermes-style memory, skills, workflow memory, and automations.',
  capabilities: ['memory', 'skills', 'automation', 'mission_planning'],
  currentIntegrationNotes: [
    'Conversation summaries and SQLite history remain the current memory mechanisms.',
    'No durable skill memory layer is active yet.'
  ],
  futureIntegrationNotes: [
    'Add project memory, reusable skills, workflow recipes, and retrieval hooks for the Mission Engine.',
    'Keep this separate from chat history until a typed memory store and permission model exist.'
  ],
  safetyNotes: [
    'This adapter has no executable and performs no file, network, provider, or terminal actions.',
    'Future memory writes should be explicit, auditable, and locally stored.'
  ]
}

export const memoryAgentAdapter: AgentAdapter = {
  metadata,
  detect: async () =>
    staticAgentDetection(
      'memory',
      'available',
      'Internal memory foundation is registered; durable skill memory is not implemented yet.'
    ),
  getRuntimeCapabilities: () => ({
    ...PLACEHOLDER_RUNTIME_CAPABILITY,
    canCreateSession: true
  })
}
