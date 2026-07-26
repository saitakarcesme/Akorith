import type { ChatActivity, ChatAttachment, ChatSendResult, ChatUsage, WorkspaceGoalStatus } from '../../../preload/index.d'

export interface WorkspaceGoalMessageMeta {
  bindingId: string
  loopId: string
  goal: string
  status: WorkspaceGoalStatus
  attempts: number
  final: boolean
  error?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: 'streaming' | 'done' | 'error'
  attachments?: ChatAttachment[]
  meta?: {
    provider: string
    model: string
    usage?: ChatUsage
    changes?: ChatSendResult['changes']
    workspaceGoal?: WorkspaceGoalMessageMeta
  }
  activities?: ChatActivity[]
  startedAt?: number
  endedAt?: number
  intent?: 'execute' | 'plan'
}

export interface ComposerAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  kind: 'image' | 'document' | 'code' | 'file'
  dataBase64: string
  previewUrl?: string
}

export interface QueuedTurn {
  id: string
  prompt: string
  providerId: string
  model: string
  attachments: ComposerAttachment[]
  intent: 'execute' | 'plan'
}
