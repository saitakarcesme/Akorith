import type { ChatActivity, ChatAttachment, ChatUsage } from '../../../preload/index.d'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: 'streaming' | 'done' | 'error'
  attachments?: ChatAttachment[]
  meta?: { provider: string; model: string; usage?: ChatUsage }
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
