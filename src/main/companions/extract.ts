import { sendStructured } from '../local-runtime'
import { getSession } from './sessions'
import { listMessages } from './messages'
import { createMemory, listMemories, type CreateMemoryInput } from './memories'
import type { CompanionMemory, CompanionMemoryType } from './types'

// Phase 50: after a conversation, ask the local model to extract a few durable,
// important memories. Deduped against existing memories before saving.

const VALID_TYPES: CompanionMemoryType[] = [
  'preference',
  'project',
  'decision',
  'idea',
  'goal',
  'personal_context',
  'writing_style',
  'technical_context',
  'warning',
  'relationship',
  'recurring_topic'
]

interface ExtractedMemory {
  type: CompanionMemoryType
  title: string
  content: string
  importance: number
}

function validateExtraction(v: unknown): ExtractedMemory[] | null {
  const arr = Array.isArray(v) ? v : (v as { memories?: unknown })?.memories
  if (!Array.isArray(arr)) return null
  const out: ExtractedMemory[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const type = VALID_TYPES.includes(o.type as CompanionMemoryType) ? (o.type as CompanionMemoryType) : 'personal_context'
    const title = typeof o.title === 'string' ? o.title.trim() : ''
    const content = typeof o.content === 'string' ? o.content.trim() : ''
    if (title.length < 2 || content.length < 2) continue
    const importance = Math.max(1, Math.min(5, Number(o.importance) || 3))
    out.push({ type, title: title.slice(0, 200), content: content.slice(0, 2000), importance })
  }
  return out
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
}

/** Is `candidate` a near-duplicate of an existing memory (title overlap)? */
function isDuplicate(candidate: ExtractedMemory, existing: CompanionMemory[]): boolean {
  const cTokens = tokens(candidate.title + ' ' + candidate.content)
  for (const m of existing) {
    const mTokens = tokens(m.title + ' ' + m.content)
    let overlap = 0
    for (const t of cTokens) if (mTokens.has(t)) overlap++
    const ratio = overlap / Math.max(1, Math.min(cTokens.size, mTokens.size))
    if (ratio > 0.6) return true
  }
  return false
}

export interface ExtractResult {
  ok: boolean
  created: CompanionMemory[]
  error?: string
}

export async function extractMemoriesFromSession(sessionId: string, model?: string): Promise<ExtractResult> {
  const session = getSession(sessionId)
  if (!session) return { ok: false, created: [], error: 'session not found' }
  const messages = listMessages(sessionId)
  if (messages.length < 2) return { ok: true, created: [] }

  const transcript = messages
    .slice(-24)
    .map((m) => `${m.role === 'user' ? 'User' : 'Companion'}: ${m.content}`)
    .join('\n')

  const prompt = `From this conversation, extract only the DURABLE, important things worth remembering long-term about the user (their preferences, projects, decisions, goals, technical context, writing style, warnings). Ignore small talk and anything transient. Return at most 5.

Conversation:
${transcript}

Return: {"memories": [{"type": "preference|project|decision|idea|goal|personal_context|writing_style|technical_context|warning|relationship|recurring_topic", "title": "short label", "content": "the durable fact", "importance": 1-5}]}`

  const res = await sendStructured<ExtractedMemory[]>(prompt, {
    model,
    validate: validateExtraction,
    schemaHint: 'Return {"memories": [...]}. Empty list is fine if nothing is worth remembering.'
  })
  if (!res.ok || !res.value) return { ok: false, created: [], error: res.error ?? 'extraction failed' }

  const existing = listMemories(session.companionId, { includeArchived: true })
  const created: CompanionMemory[] = []
  for (const cand of res.value) {
    if (isDuplicate(cand, existing)) continue
    const input: CreateMemoryInput = {
      companionId: session.companionId,
      type: cand.type,
      title: cand.title,
      content: cand.content,
      importance: cand.importance,
      confidence: 0.7,
      sourceSessionId: sessionId
    }
    const mem = createMemory(input)
    created.push(mem)
    existing.push(mem)
  }
  return { ok: true, created }
}
