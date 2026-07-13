// Phase 50: Companions — long-memory local AI personalities (Athena, Zeus).
// Companions TALK and REMEMBER. They take NO actions: no files, no commands, no
// terminal input, no commits, no calling Agents/Loop, no changing settings.

export interface Companion {
  id: string
  name: string
  /** Short tagline shown on the card. */
  tagline: string
  /** Personality tags for the card. */
  tags: string[]
  /** Built-in companions are seeded and cannot be deleted. */
  builtin: boolean
  /** Optional per-companion model override (else the local default). */
  model?: string
  createdAt: number
  updatedAt: number
}

export interface CompanionSession {
  id: string
  companionId: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export type CompanionRole = 'user' | 'assistant'

export interface CompanionMessage {
  id: string
  sessionId: string
  companionId: string
  role: CompanionRole
  content: string
  createdAt: number
}

export type CompanionMemoryType =
  | 'preference'
  | 'project'
  | 'decision'
  | 'idea'
  | 'goal'
  | 'personal_context'
  | 'writing_style'
  | 'technical_context'
  | 'warning'
  | 'relationship'
  | 'recurring_topic'

export interface CompanionMemory {
  id: string
  companionId: string
  type: CompanionMemoryType
  title: string
  content: string
  /** 1..5 — how important this memory is. */
  importance: number
  /** 0..1 — model confidence in the memory. */
  confidence: number
  sourceSessionId?: string
  pinned: boolean
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  archivedAt?: number
  tags: string[]
}

export type CompanionMemoryEventKind = 'extracted' | 'merged' | 'updated' | 'pinned' | 'archived' | 'forgotten' | 'recalled'

export interface CompanionMemoryEvent {
  id: string
  companionId: string
  memoryId?: string
  kind: CompanionMemoryEventKind
  detail?: string
  createdAt: number
}

/** Memory context surfaced for a single reply (for the memory indicator). */
export interface CompanionContextInfo {
  recentMessageCount: number
  usedMemories: { id: string; title: string; type: CompanionMemoryType }[]
}
