import type { MessageRow } from '../../../preload/index.d'
import {
  interruptedChatResponse,
  legacyMissingChatResponse
} from '../../../shared/chat-lifecycle'
import { normalizeStoredOpenCodeMessage } from '../../../shared/opencode-output'
import type { ChatMessage } from './chat-types'

function legacyRecoveryMessage(message: MessageRow, workspace: boolean): ChatMessage {
  return {
    id: `legacy-recovery:${message.id}`,
    role: 'assistant',
    text: legacyMissingChatResponse(workspace),
    status: 'error',
    taskPrompt: message.content
  }
}

function storedAssistant(
  message: MessageRow,
  taskPrompt: string | undefined,
  workspace: boolean
): ChatMessage {
  const lifecycle = message.metadata?.chatLifecycle
  const failed = lifecycle
    ? lifecycle.state === 'error' ||
      lifecycle.state === 'cancelled' ||
      lifecycle.state === 'timed_out' ||
      lifecycle.state === 'interrupted'
    : false
  return {
    id: message.id,
    role: 'assistant',
    text: lifecycle?.state === 'interrupted'
      ? interruptedChatResponse(workspace)
      : message.providerId === 'opencode'
        ? normalizeStoredOpenCodeMessage(message.content)
        : message.content,
    status: lifecycle?.state === 'running' ? 'streaming' : failed ? 'error' : 'done',
    attachments: message.attachments,
    meta: {
      provider: message.providerId,
      model: message.model ?? 'default',
      usage: message.metadata?.usage,
      changes: message.metadata?.changes,
      workspaceGoal: message.metadata?.workspaceGoal
    },
    taskPrompt,
    startedAt: message.metadata?.startedAt ??
      (message.metadata?.workspaceGoal ? message.createdAt : undefined),
    endedAt: message.metadata?.endedAt ??
      (message.metadata?.workspaceGoal?.final ? message.createdAt : undefined)
  }
}

/**
 * Hydrate persisted rows without hiding legacy half-turns. A deterministic
 * recovery card is inserted after every user row that has no assistant pair.
 */
export function hydrateStoredChatMessages(
  messages: MessageRow[],
  workspace: boolean
): ChatMessage[] {
  const loaded: ChatMessage[] = []
  let pendingUser: MessageRow | null = null

  for (const message of messages) {
    if (message.role === 'user') {
      if (pendingUser) loaded.push(legacyRecoveryMessage(pendingUser, workspace))
      loaded.push({
        id: message.id,
        role: 'user',
        text: message.content,
        status: 'done',
        attachments: message.attachments
      })
      pendingUser = message
      continue
    }

    loaded.push(storedAssistant(message, pendingUser?.content, workspace))
    pendingUser = null
  }

  if (pendingUser) loaded.push(legacyRecoveryMessage(pendingUser, workspace))
  return loaded
}
