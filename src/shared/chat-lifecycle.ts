export type ChatLifecycleState =
  | 'running'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted'

export interface ChatLifecycleMetadata {
  requestId: string
  state: ChatLifecycleState
}

export const CHAT_RUNNING_RESPONSE =
  'Akorith is working on this request. Progress will appear here as the selected model reports it.'

export function interruptedChatResponse(workspace: boolean): string {
  return workspace
    ? 'This request was interrupted before Akorith could save a final response. Any project changes produced before the interruption remain available in Review and Files.'
    : 'This request was interrupted before Akorith could save a final response. Retry it if you still need the result.'
}

export function legacyMissingChatResponse(workspace: boolean): string {
  return workspace
    ? 'Akorith did not save a final response for this earlier request. Any project changes produced by that turn remain available in Review and Files.'
    : 'Akorith did not save a final response for this earlier request. Retry it if you still need the result.'
}
