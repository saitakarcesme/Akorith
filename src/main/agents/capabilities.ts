import type { AgentCapability } from './types'

export const AGENT_CAPABILITY_LABELS: Record<AgentCapability, string> = {
  chat: 'Chat',
  terminal: 'Terminal',
  exec: 'Exec',
  streaming: 'Streaming',
  file_patch: 'File patch',
  test_generation: 'Test generation',
  review: 'Review',
  commit: 'Commit',
  memory: 'Memory',
  skills: 'Skills',
  automation: 'Automation',
  mission_planning: 'Mission planning'
}

export function labelAgentCapability(capability: AgentCapability): string {
  return AGENT_CAPABILITY_LABELS[capability]
}
