// Phase 14.2 conversation memory — the electron-free, side-effect-free core that
// turns a session's stored messages into a bounded provider prompt. Kept pure so
// it can be unit-verified headlessly (scripts/verify-conversation-context.ts).
//
// Why this exists: every provider.send() is a single-shot CLI/HTTP call with no
// memory of its own. To make a visible chat actually remember prior turns, the
// chat:send handler assembles the session transcript here and sends it as the
// prompt. Memory is keyed strictly by sessionId (the caller only ever passes one
// session's messages), so there is no cross-chat or cross-project leakage.

export interface ConvMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ContextPolicy {
  /** Max recent messages kept verbatim in the prompt. */
  recentVerbatim: number
  /** Char budget for the verbatim transcript (older context is summarized). */
  maxChars: number
  /** Older context is only summarized once it exceeds this many messages. */
  summarizeAfter: number
}

// Conservative, reliable defaults. ~24 recent turns verbatim within a 48k-char
// budget keeps the model grounded without sending unbounded history forever.
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  recentVerbatim: 24,
  maxChars: 48_000,
  summarizeAfter: 24
}

export interface ContextWindow {
  /** Recent messages included verbatim (chronological order). */
  verbatim: ConvMessage[]
  /** Messages older than the verbatim window — candidates for summarization. */
  older: ConvMessage[]
  /** Approx chars of the verbatim transcript. */
  approxChars: number
}

const ROLE_LABEL: Record<ConvMessage['role'], string> = { user: 'User', assistant: 'Assistant' }

/**
 * Choose the verbatim window from the tail of the conversation, bounded by both
 * message count and a char budget. Always keeps at least the most recent message.
 */
export function selectContextWindow(messages: ConvMessage[], policy: ContextPolicy = DEFAULT_CONTEXT_POLICY): ContextWindow {
  const verbatim: ConvMessage[] = []
  let chars = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const cost = m.content.length + ROLE_LABEL[m.role].length + 4
    if (verbatim.length >= policy.recentVerbatim) break
    // Always include the newest message; only the budget gates the rest.
    if (verbatim.length > 0 && chars + cost > policy.maxChars) break
    verbatim.unshift(m)
    chars += cost
  }
  const older = messages.slice(0, messages.length - verbatim.length)
  return { verbatim, older, approxChars: chars }
}

/** Render verbatim turns as a role-tagged transcript. */
export function renderTranscript(messages: ConvMessage[]): string {
  return messages.map((m) => `${ROLE_LABEL[m.role]}: ${m.content}`).join('\n\n')
}

/** Build the meta-call prompt that compresses older turns into a session summary. */
export function buildOlderSummaryPrompt(older: ConvMessage[], priorSummary?: string | null): string {
  const head =
    `You are compressing the earlier part of an ongoing chat conversation into a concise running summary. ` +
    `This is an internal orchestration call — do not answer or continue the conversation. ` +
    `Preserve concrete facts, decisions, names, values, and anything the user asked to remember. Keep it under ~200 words.`
  const prev = priorSummary && priorSummary.trim() ? `\n\nExisting summary so far (extend it, don't repeat verbatim):\n${priorSummary.trim()}` : ''
  const body = renderTranscript(older)
  return `${head}${prev}\n\nEarlier turns to fold into the summary:\n"""\n${body}\n"""\n\nReturn ONLY the updated summary text.`
}

export interface ProviderPromptInput {
  /** All prior messages in the session (NOT including the new user prompt). */
  priorMessages: ConvMessage[]
  /** The new user message being sent now. */
  currentPrompt: string
  /** Cached summary of the older (non-verbatim) context, if any. */
  summary?: string | null
  /** Optional repo digest (Workspace only) — read-only context, not instructions. */
  digest?: string | null
  policy?: ContextPolicy
}

export interface BuiltProviderPrompt {
  /** The full text to hand to provider.send(). */
  prompt: string
  /** Recent messages included verbatim. */
  includedVerbatim: number
  /** Older messages represented by the summary (0 when none). */
  summarizedCount: number
  /** Whether a summary block was actually included. */
  usedSummary: boolean
  /** Whether the repo digest was included. */
  usedDigest: boolean
  approxChars: number
}

/**
 * Assemble the final prompt the provider sees: optional repo digest, an optional
 * older-context summary, the recent verbatim transcript, and the new user
 * message — framed so the model continues the SAME conversation. With no prior
 * messages it returns the clean prompt (plus digest), exactly like a fresh chat.
 */
export function renderProviderPrompt(input: ProviderPromptInput): BuiltProviderPrompt {
  const policy = input.policy ?? DEFAULT_CONTEXT_POLICY
  const digestBlock = input.digest && input.digest.trim() ? `${input.digest.trim()}\n\n---\n\n` : ''
  const usedDigest = digestBlock.length > 0

  const window = selectContextWindow(input.priorMessages, policy)
  const hasHistory = input.priorMessages.length > 0
  if (!hasHistory) {
    return {
      prompt: `${digestBlock}${input.currentPrompt}`,
      includedVerbatim: 0,
      summarizedCount: 0,
      usedSummary: false,
      usedDigest,
      approxChars: input.currentPrompt.length
    }
  }

  const usedSummary = window.older.length > 0 && Boolean(input.summary && input.summary.trim())
  const summarizedCount = window.older.length

  const parts: string[] = [
    `[Conversation context — this is an ongoing session. Read the prior turns below and respond ONLY to the latest user message, as the assistant. Do not claim this is the first message or that nothing has been discussed.]`
  ]
  if (usedSummary) parts.push(`Summary of earlier conversation:\n${input.summary!.trim()}`)
  if (window.verbatim.length > 0) parts.push(`Recent conversation:\n${renderTranscript(window.verbatim)}`)
  parts.push(`Latest user message to answer now:\n${input.currentPrompt}`)

  const prompt = `${digestBlock}${parts.join('\n\n')}`
  return {
    prompt,
    includedVerbatim: window.verbatim.length,
    summarizedCount,
    usedSummary,
    usedDigest,
    approxChars: prompt.length
  }
}

export interface ContextInfo {
  totalMessages: number
  includedVerbatim: number
  summarizedCount: number
  hasSummary: boolean
  approxChars: number
  approxTokens: number
}

/**
 * Report what WOULD be sent for a session, without calling any model — the data
 * behind the composer's memory indicator. `summaryCovers` is how many older
 * messages the cached summary represents (0 if none cached).
 */
export function describeContext(
  priorMessages: ConvMessage[],
  cachedSummaryCovers: number,
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY
): ContextInfo {
  const window = selectContextWindow(priorMessages, policy)
  const summarizedCount = window.older.length
  const hasSummary = summarizedCount > 0 && cachedSummaryCovers >= summarizedCount
  const approxChars = window.approxChars
  return {
    totalMessages: priorMessages.length,
    includedVerbatim: window.verbatim.length,
    summarizedCount,
    hasSummary,
    approxChars,
    approxTokens: Math.round(approxChars / 4)
  }
}
