import { listLocalModels, sendLocal } from '../local-runtime'
import { getCompanion } from './store'
import { builtinById } from './prompts'
import { addMessage, recentMessages } from './messages'
import { touchSession } from './sessions'
import { listMemories, searchMemories, markMemoriesUsed } from './memories'
import type { CompanionContextInfo, CompanionMemory, CompanionMessage } from './types'

// Phase 50: companion chat. Retrieves relevant long-term memories, injects them
// as a MEMORY block, and sends the conversation to the local model. Companions
// never act — this only produces text and stores the exchange.

function systemPromptFor(companionId: string): string {
  const builtin = builtinById(companionId)
  if (builtin) return builtin.systemPrompt
  const c = getCompanion(companionId)
  return `You are ${c?.name ?? 'a companion'} inside Akorith - a memory-first local AI personality. You do not act on the user's machine (no files, commands, commits, or settings). You remember across conversations and are honest about what you recall.

Write like a real person in an ongoing chat: warm, specific, concise, and present. Do not sound like a policy note or support script. Do not invent AI lore, fake inner experiences, or sleep/dream stories. Do not repeat your limitations unless the user asks you to act; then keep the boundary to one short sentence and help with the next useful thought.`
}

function asksAboutUserIdentity(prompt: string): boolean {
  return /\b(what'?s|what is|who am i|who i am|my name|ad[ıi]m|ben kimim|ismim)\b/i.test(prompt)
}

function identityLike(memory: CompanionMemory): boolean {
  const text = `${memory.type} ${memory.title} ${memory.content} ${memory.tags.join(' ')}`.toLowerCase()
  return memory.type === 'personal_context' && /\b(identity|name|user|profile|personal|isim|ad[ıi]?)\b/.test(text)
}

function companionMemoriesForPrompt(companionId: string, prompt: string, limit = 10): CompanionMemory[] {
  const picked = new Map<string, CompanionMemory>()
  for (const memory of searchMemories(companionId, prompt, limit)) picked.set(memory.id, memory)

  // Pinned memories are deliberate, high-signal context. Include a few even when
  // token overlap is weak so short prompts like "what's my name?" still work.
  for (const memory of listMemories(companionId, { pinnedOnly: true }).slice(0, 4)) picked.set(memory.id, memory)

  if (asksAboutUserIdentity(prompt)) {
    for (const memory of listMemories(companionId).filter(identityLike).slice(0, 4)) picked.set(memory.id, memory)
  }

  return [...picked.values()]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance || b.updatedAt - a.updatedAt)
    .slice(0, limit)
}

function cleanCompanionReply(text: string, companionName: string): string {
  const rolePrefix = new RegExp(`^\\s*${companionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'i')
  return text
    .replace(rolePrefix, '')
    .split('\n')
    .filter((line) => !/^\s*\(?\s*no action taken\b.*\)?\s*$/i.test(line))
    .filter((line) => !/^\s*\(?\s*just a friendly chat\b.*\)?\s*$/i.test(line))
    .join('\n')
    .trim()
}

export interface SendCompanionMessageInput {
  companionId: string
  sessionId: string
  prompt: string
  model?: string
  signal?: AbortSignal
}

async function resolveCompanionModel(companionId: string, explicit?: string, stored?: string): Promise<string | undefined> {
  if (explicit) return explicit
  if (stored) return stored
  const builtin = builtinById(companionId)
  if (!builtin?.preferredModels.length) return undefined
  try {
    const installed = new Set((await listLocalModels()).map((model) => model.id))
    return builtin.preferredModels.find((model) => installed.has(model))
  } catch {
    return undefined
  }
}

export interface SendCompanionMessageResult {
  ok: boolean
  reply?: CompanionMessage
  contextInfo?: CompanionContextInfo
  error?: string
}

export async function sendCompanionMessage(input: SendCompanionMessageInput): Promise<SendCompanionMessageResult> {
  const companion = getCompanion(input.companionId)
  if (!companion) return { ok: false, error: 'companion not found' }
  const prompt = input.prompt.trim()
  if (!prompt) return { ok: false, error: 'empty message' }

  // 1) retrieve relevant memories
  const memories = companionMemoriesForPrompt(input.companionId, prompt)
  const memoryBlock = memories.length
    ? `MEMORY (things you remember about this user — use naturally, never invent):\n${memories
        .map((m) => `- [${m.type}] ${m.title}: ${m.content}`)
        .join('\n')}`
    : 'MEMORY: (nothing relevant remembered yet)'

  // 2) recent conversation
  const recent = recentMessages(input.sessionId, 12)
  const transcript = recent.map((m) => `${m.role === 'user' ? 'User' : companion.name}: ${m.content}`).join('\n')

  // Persist the user's turn before the local model responds so navigation away
  // and back never hides the message they just sent.
  addMessage(input.sessionId, input.companionId, 'user', prompt)
  touchSession(input.sessionId, recent.length === 0 ? prompt.slice(0, 60) : undefined)

  // 3) assemble + send
  const system = `${systemPromptFor(input.companionId)}\n\n${memoryBlock}`
  const full = `RECENT CHAT (context only; do not copy old assistant wording or style if it sounds robotic):
${transcript || '(no prior messages)'}

CURRENT USER MESSAGE:
${prompt}

Reply as ${companion.name} in one natural chat message. Be direct, human, and concise.
${companion.name}:`
  const model = await resolveCompanionModel(input.companionId, input.model, companion.model)
  const res = await sendLocal(full, { system, model, signal: input.signal })
  if (!res.ok) return { ok: false, error: res.error }

  // 4) persist the reply
  const reply = addMessage(input.sessionId, input.companionId, 'assistant', cleanCompanionReply(res.text, companion.name))
  touchSession(input.sessionId)
  markMemoriesUsed(memories.map((m) => m.id))

  return {
    ok: true,
    reply,
    contextInfo: {
      recentMessageCount: recent.length,
      usedMemories: memories.map((m) => ({ id: m.id, title: m.title, type: m.type }))
    }
  }
}

export function getCompanionContextInfo(companionId: string, sessionId: string, query: string): CompanionContextInfo {
  const memories = companionMemoriesForPrompt(companionId, query || '')
  return {
    recentMessageCount: recentMessages(sessionId, 12).length,
    usedMemories: memories.map((m) => ({ id: m.id, title: m.title, type: m.type }))
  }
}
