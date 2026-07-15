const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

export interface OpenCodeJsonResult {
  text: string
  eventCount: number
  toolErrors: string[]
}

export function parseOpenCodeJson(stdout: string): OpenCodeJsonResult {
  const chunks: string[] = []
  const toolErrors: string[] = []
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
      const partText = part?.text
      if (typeof partText === 'string') chunks.push(partText)
      else if (typeof text === 'string') chunks.push(text)
      else if (typeof message === 'string') chunks.push(message)
      const state = part?.state as Record<string, unknown> | undefined
      if (state && typeof state.error === 'string' && state.error.trim()) {
        toolErrors.push(state.error.replace(ANSI_PATTERN, '').replace(/[\0\r\n]+/g, ' ').trim().slice(0, 500))
      }
    } catch {
      // Ignore non-JSON log noise. Raw event envelopes must never become chat.
    }
  }
  return { text: chunks.join('').trim(), eventCount, toolErrors }
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
