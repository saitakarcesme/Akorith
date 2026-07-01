import { listLocalModels, sendLocal } from '../local-runtime'
import { getCompanion } from './store'
import { builtinById } from './prompts'
import { addMessage, recentMessages } from './messages'
import { touchSession } from './sessions'
import { searchMemories, markMemoriesUsed } from './memories'
import type { CompanionContextInfo, CompanionMessage } from './types'

// Phase 50: companion chat. Retrieves relevant long-term memories, injects them
// as a MEMORY block, and sends the conversation to the local model. Companions
// never act — this only produces text and stores the exchange.

function systemPromptFor(companionId: string): string {
  const builtin = builtinById(companionId)
  if (builtin) return builtin.systemPrompt
  const c = getCompanion(companionId)
  return `You are ${c?.name ?? 'a companion'} inside Akorith — a memory-first local AI personality. You do not act on the user's machine (no files, commands, commits, or settings). You remember across conversations and are honest about what you recall.`
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
  const memories = searchMemories(input.companionId, prompt, 8)
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
  const full = `${transcript ? transcript + '\n' : ''}User: ${prompt}\n${companion.name}:`
  const model = await resolveCompanionModel(input.companionId, input.model, companion.model)
  const res = await sendLocal(full, { system, model, signal: input.signal })
  if (!res.ok) return { ok: false, error: res.error }

  // 4) persist the reply
  const reply = addMessage(input.sessionId, input.companionId, 'assistant', res.text.trim())
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
  const memories = searchMemories(companionId, query || '', 8)
  return {
    recentMessageCount: recentMessages(sessionId, 12).length,
    usedMemories: memories.map((m) => ({ id: m.id, title: m.title, type: m.type }))
  }
}
