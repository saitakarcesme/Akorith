export interface AgentRuntimeCapability {
  canCreateSession: boolean
  canSendMessage: boolean
  canStream: boolean
  canExecute: boolean
  canAttachToPty: boolean
  canUseExistingProvider: boolean
  canUseExistingTerminal: boolean
  isPlaceholder: boolean
}

export const PLACEHOLDER_RUNTIME_CAPABILITY: AgentRuntimeCapability = {
  canCreateSession: true,
  canSendMessage: false,
  canStream: false,
  canExecute: false,
  canAttachToPty: false,
  canUseExistingProvider: false,
  canUseExistingTerminal: false,
  isPlaceholder: true
}

export function existingProviderRuntimeCapability(
  patch: Partial<AgentRuntimeCapability> = {}
): AgentRuntimeCapability {
  return {
    ...PLACEHOLDER_RUNTIME_CAPABILITY,
    canUseExistingProvider: true,
    ...patch,
    isPlaceholder: true
  }
}
