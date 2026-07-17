const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

export interface OpenCodeJsonResult {
  text: string
  eventCount: number
  toolErrors: string[]
  usage?: OpenCodeTokenUsage
}

export interface OpenCodeTokenUsage {
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
}

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

export function parseOpenCodeJson(stdout: string): OpenCodeJsonResult {
  const chunks: string[] = []
  const toolErrors: string[] = []
  const usage: OpenCodeTokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  }
  let hasUsage = false
  let eventCount = 0
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      eventCount += 1
      const message = event.message
      const text = event.text ?? event.content ?? event.result
      const part = event.part as Record<string, unknown> | undefined
      const partType = typeof part?.type === 'string' ? part.type : ''
      const eventType = typeof event.type === 'string' ? event.type : ''
      const partText = part?.text
      if (typeof partText === 'string') chunks.push(partText)
      else if (typeof text === 'string') chunks.push(text)
      else if (typeof message === 'string') chunks.push(message)
      const state = part?.state as Record<string, unknown> | undefined
      if (state && typeof state.error === 'string' && state.error.trim()) {
        toolErrors.push(state.error.replace(ANSI_PATTERN, '').replace(/[\0\r\n]+/g, ' ').trim().slice(0, 500))
      }
      if (eventType === 'step_finish' || eventType === 'step-finish' || partType === 'step-finish') {
        const tokens = (part?.tokens ?? event.tokens) as Record<string, unknown> | undefined
        if (tokens && typeof tokens === 'object') {
          const cache = tokens.cache && typeof tokens.cache === 'object'
            ? tokens.cache as Record<string, unknown>
            : {}
          const prompt = finiteCount(tokens.input ?? tokens.prompt)
          const completion = finiteCount(tokens.output ?? tokens.completion)
          const cacheRead = finiteCount(cache.read ?? tokens.cache_read ?? tokens.cached_input)
          const cacheWrite = finiteCount(cache.write ?? tokens.cache_write)
          const reasoning = finiteCount(tokens.reasoning)
          const explicitTotal = finiteCount(tokens.total)
          const componentTotal = prompt + completion + cacheRead + cacheWrite + reasoning
          if (explicitTotal > 0 || componentTotal > 0) {
            hasUsage = true
            usage.promptTokens += prompt
            usage.completionTokens += completion
            usage.cacheReadTokens += cacheRead
            usage.cacheWriteTokens += cacheWrite
            usage.reasoningTokens += reasoning
            usage.totalTokens += explicitTotal || componentTotal
          }
        }
      }
    } catch {
      // Ignore non-JSON log noise. Raw event envelopes must never become chat.
    }
  }
  return { text: chunks.join('').trim(), eventCount, toolErrors, usage: hasUsage ? usage : undefined }
}

/** Converts legacy event-stream messages already persisted by older builds. */
export function normalizeStoredOpenCodeMessage(content: string): string {
  const parsed = parseOpenCodeJson(content)
  if (parsed.eventCount === 0) return content
  if (parsed.text) return parsed.text
  const toolError = parsed.toolErrors.at(-1)
  if (toolError) return `OpenCode could not complete the workspace action: ${toolError}`
  return 'OpenCode completed without a text response. Check its workspace permissions and try again.'
}
