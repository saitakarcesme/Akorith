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

export interface OpenCodeActivity {
  kind: 'command' | 'file' | 'tool' | 'warning'
  label: string
  detail?: string
  status: 'running' | 'complete' | 'error'
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function cleanInline(value: unknown, maxLength = 240): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(ANSI_PATTERN, '').replace(/[\0\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text
}

function displayPath(value: string, workspaceDirectory?: string): string {
  const normalized = value.replace(/\\/g, '/')
  if (!workspaceDirectory) return normalized
  const root = workspaceDirectory.replace(/\\/g, '/').replace(/\/+$/, '')
  const lower = normalized.toLocaleLowerCase()
  const lowerRoot = root.toLocaleLowerCase()
  return lower === lowerRoot
    ? normalized.split('/').filter(Boolean).at(-1) ?? normalized
    : lower.startsWith(`${lowerRoot}/`)
      ? normalized.slice(root.length + 1)
      : normalized
}

function toolLabel(tool: string, input: Record<string, unknown>, workspaceDirectory?: string): {
  kind: OpenCodeActivity['kind']
  label: string
} {
  const file = cleanInline(input.filePath ?? input.file ?? input.path, 500)
  const shownFile = file ? displayPath(file, workspaceDirectory) : ''
  const command = cleanInline(input.command, 300)
  if (command) return { kind: 'command', label: command }
  if (shownFile) {
    const verb = /^(?:edit|write|patch|apply_patch|create)$/i.test(tool)
      ? 'Updating'
      : /^(?:delete|remove)$/i.test(tool)
        ? 'Removing'
        : 'Reading'
    return { kind: 'file', label: `${verb} ${shownFile}` }
  }
  const pattern = cleanInline(input.pattern ?? input.query ?? input.search, 140)
  if (pattern && /^(?:grep|search|glob)$/i.test(tool)) {
    return { kind: 'tool', label: `Searching for ${pattern}` }
  }
  const friendly = tool.replace(/[_-]+/g, ' ').trim()
  return {
    kind: 'tool',
    label: friendly ? `${friendly[0].toLocaleUpperCase()}${friendly.slice(1)}` : 'Using a workspace tool'
  }
}

/** Convert one OpenCode JSONL envelope into a truthful, provider-neutral activity. */
export function normalizeOpenCodeActivityEvent(
  event: Record<string, unknown>,
  workspaceDirectory?: string
): OpenCodeActivity | null {
  const part = record(event.part)
  const type = typeof event.type === 'string' ? event.type : ''
  const partType = typeof part.type === 'string' ? part.type : ''
  if (type !== 'tool_use' && partType !== 'tool') return null

  const tool = cleanInline(part.tool ?? event.tool, 80) || 'tool'
  const state = record(part.state)
  const directInput = record(part.input)
  const input = Object.keys(directInput).length > 0 ? directInput : record(state.input)
  const rawStatus = String(state.status ?? '')
  const status: OpenCodeActivity['status'] =
    rawStatus === 'error' || typeof state.error === 'string'
      ? 'error'
      : rawStatus === 'completed'
        ? 'complete'
        : 'running'
  const normalized = toolLabel(tool, input, workspaceDirectory)
  const error = cleanInline(state.error, 300)
  const output = normalized.kind === 'command' ? cleanInline(state.output, 220) : ''
  return {
    ...normalized,
    detail: error || output || undefined,
    status
  }
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
