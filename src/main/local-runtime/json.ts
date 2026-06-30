// Phase 47: pure JSON-extraction helpers (no electron / provider imports) so they
// can be unit-tested in verify scripts without a live runtime.

/** Pull the first balanced JSON object/array out of model text (fenced or raw). */
export function extractJson(text: string): string | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.search(/[{[]/)
  if (start < 0) return null
  const open = candidate[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return candidate.slice(start, i + 1)
    }
  }
  return null
}

export function parseJsonLoose<T>(text: string): T | null {
  const json = extractJson(text)
  if (!json) return null
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}
