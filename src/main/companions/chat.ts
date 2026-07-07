import { listLocalModels, sendLocal } from '../local-runtime'
import { getCompanion } from './store'
import { builtinById } from './prompts'
import { addMessage, recentMessages } from './messages'
import { touchSession } from './sessions'
import { createMemory, listMemories, pinMemory, searchMemories, markMemoriesUsed, updateMemory } from './memories'
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
  return /\b((what'?s|what is)\s+my name|who am i|who i am|do you remember me|ben kimim|ad[ıi]m ne|ismim ne)\b/i.test(prompt)
}

function asksAboutCompanionIdentity(prompt: string): boolean {
  return /\b(what are you exactly|what are you|who are you|what'?s your name|what is your name|what is yours|what'?s yours|your name|sen kimsin|senin ad[ıi]n ne)\b/i.test(prompt)
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

function cleanName(raw: string): string | null {
  const name = raw
    .replace(/["'`]/g, '')
    .replace(/\b(what|who|and|but|so|thanks?|thank|you|yours?|seninki|nedir|ne)\b.*$/i, '')
    .replace(/[^a-zA-ZÀ-ÖØ-öø-ÿğĞıİşŞüÜöÖçÇ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!name || name.length > 40) return null
  if (/^(good|fine|okay|ok|great|well|here|there)$/i.test(name)) return null
  return name
    .split(' ')
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toLocaleUpperCase('en-US') + part.slice(1))
    .join(' ')
}

function extractDeclaredUserName(prompt: string): string | null {
  const patterns = [
    /\bmy name is\s+(.+?)(?=$|[.!?,]|\s+(?:what|who|and|but|so)\b)/i,
    /\bi am\s+(.+?)(?=$|[.!?,]|\s+(?:what|who|and|but|so)\b)/i,
    /\bi'?m\s+(.+?)(?=$|[.!?,]|\s+(?:what|who|and|but|so)\b)/i,
    /\bbenim ad[ıi]m\s+(.+?)(?=$|[.!?,]|\s+(?:senin|ne|nedir|ve|ama)\b)/i,
    /\bad[ıi]m\s+(.+?)(?=$|[.!?,]|\s+(?:senin|ne|nedir|ve|ama)\b)/i,
    /\bismim\s+(.+?)(?=$|[.!?,]|\s+(?:senin|ne|nedir|ve|ama)\b)/i
  ]
  for (const pattern of patterns) {
    const match = prompt.match(pattern)
    const name = match?.[1] ? cleanName(match[1]) : null
    if (name) return name
  }
  return null
}

function upsertUserNameMemory(companionId: string, sessionId: string, name: string): CompanionMemory {
  const existing = listMemories(companionId).find((memory) => memory.tags.includes('name') || /^user name$/i.test(memory.title))
  const content = `User's name is ${name}.`
  const memory = existing
    ? updateMemory(existing.id, { type: 'personal_context', title: 'User name', content, importance: 5 }) ?? existing
    : createMemory({
        companionId,
        type: 'personal_context',
        title: 'User name',
        content,
        importance: 5,
        confidence: 0.98,
        sourceSessionId: sessionId,
        tags: ['identity', 'name', 'user']
      })
  return pinMemory(memory.id, true) ?? memory
}

function rememberedUserName(memories: CompanionMemory[]): string | null {
  for (const memory of memories) {
    const text = `${memory.title}. ${memory.content}`
    const match = text.match(/\b(?:user'?s name is|name is|called|ad[ıi]\s*)\s+([a-zA-ZÀ-ÖØ-öø-ÿğĞıİşŞüÜöÖçÇ -]{2,40})/i)
    const name = match?.[1] ? cleanName(match[1]) : null
    if (name) return name
  }
  return null
}

function isBadPriorAssistantReply(content: string): boolean {
  return /Dreamspace|AI-induced snooze|No action taken|just a friendly chat/i.test(content) ||
    /I am Athena, your warm companion inside Akorith\..*quiet, awake, and listening\.\s*How are you\?/is.test(content)
}

function directCompanionReply(companionName: string, prompt: string, memories: CompanionMemory[]): string | null {
  const lower = prompt.toLowerCase().trim()
  const userName = rememberedUserName(memories)
  if (asksAboutCompanionIdentity(prompt)) {
    const intro = userName && /\b(my name is|i am|i'?m|ad[ıi]m|ismim)\b/i.test(prompt) ? `Nice to meet you, ${userName}. ` : ''
    return `${intro}I'm ${companionName}, a companion inside Akorith. I can talk things through with you and remember what matters, but I don't run commands or edit files.`
  }
  if (asksAboutUserIdentity(prompt)) {
    return userName ? `You're ${userName}.` : `I don't know your name yet. Tell me once and I'll remember it.`
  }
  if (/^(hi|hey|hello|yo|selam|merhaba)\b[.!? ]*$/i.test(lower)) {
    return userName ? `Hey, ${userName}.` : 'Hey.'
  }
  if (/\b(i'?m|im|i am)\s+(good|fine|okay|ok|great|well)\b/i.test(lower) && /\b(thanks?|thank you|tesekkur|teşekkür)\b/i.test(lower)) {
    return userName ? `Good. I'm glad, ${userName}.` : `Good. I'm glad.`
  }
  return null
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

  const declaredName = extractDeclaredUserName(prompt)
  const nameMemory = declaredName ? upsertUserNameMemory(input.companionId, input.sessionId, declaredName) : null

  // 1) retrieve relevant memories
  const memories = companionMemoriesForPrompt(input.companionId, prompt)
  if (nameMemory && !memories.some((memory) => memory.id === nameMemory.id)) memories.unshift(nameMemory)
  const memoryBlock = memories.length
    ? `MEMORY (things you remember about this user — use naturally, never invent):\n${memories
        .map((m) => `- [${m.type}] ${m.title}: ${m.content}`)
        .join('\n')}`
    : 'MEMORY: (nothing relevant remembered yet)'

  // 2) recent conversation
  const recent = recentMessages(input.sessionId, 12)
  const transcript = recent
    .filter((m) => m.role === 'user' || !isBadPriorAssistantReply(m.content))
    .map((m) => `${m.role === 'user' ? 'User' : companion.name}: ${m.content}`)
    .join('\n')

  // Persist the user's turn before the local model responds so navigation away
  // and back never hides the message they just sent.
  addMessage(input.sessionId, input.companionId, 'user', prompt)
  touchSession(input.sessionId, recent.length === 0 ? prompt.slice(0, 60) : undefined)

  const directReply = directCompanionReply(companion.name, prompt, memories)
  if (directReply) {
    const reply = addMessage(input.sessionId, input.companionId, 'assistant', directReply)
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

  // 3) assemble + send
  const system = `${systemPromptFor(input.companionId)}\n\n${memoryBlock}`
  const full = `RECENT CHAT (context only; do not copy old assistant wording or style if it sounds robotic):
${transcript || '(no prior messages)'}

CURRENT USER MESSAGE:
${prompt}

Reply as ${companion.name} in one fresh natural chat message. Answer the current user message, not an older message. Do not repeat a prior assistant reply.
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
