import { sendLocal } from './send'
import type { LocalRuntimeSendOptions, LocalStructuredResult } from './types'

// Phase 47: structured (JSON) output from the local model with tolerant parsing
// and a single repair retry. Used by Loop/Companions/Agents planners.

/** Pull the first JSON object/array out of model text (fenced or raw). */
export function extractJson(text: string): string | null {
  if (!text) return null
  // Prefer a ```json fenced block, then any ``` block.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  // Find the first balanced { ... } or [ ... ].
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

export interface StructuredOptions<T> extends LocalRuntimeSendOptions {
  /** Validate + narrow the parsed value. Return null/throw to reject. */
  validate: (value: unknown) => T | null
  /** Extra instruction appended to nudge JSON-only output. */
  schemaHint?: string
}

const JSON_GUIDANCE =
  'Respond with ONLY a single valid JSON value. No prose, no markdown fences, no comments.'

export async function sendStructured<T>(prompt: string, opts: StructuredOptions<T>): Promise<LocalStructuredResult<T>> {
  const askPrompt = `${prompt}\n\n${opts.schemaHint ? opts.schemaHint + '\n\n' : ''}${JSON_GUIDANCE}`
  const first = await sendLocal(askPrompt, opts)
  if (!first.ok) {
    return { ok: false, raw: '', model: first.model, repaired: false, error: first.error }
  }

  const tryParse = (text: string): T | null => {
    const parsed = parseJsonLoose<unknown>(text)
    if (parsed === null) return null
    try {
      return opts.validate(parsed)
    } catch {
      return null
    }
  }

  const firstValue = tryParse(first.text)
  if (firstValue !== null) {
    return { ok: true, value: firstValue, raw: first.text, model: first.model, repaired: false }
  }

  // One repair pass: hand the model its own output and ask for valid JSON only.
  const repairPrompt = `Your previous response was not valid JSON for this task.\n\nPrevious response:\n${first.text.slice(0, 4000)}\n\nReturn the corrected value now. ${JSON_GUIDANCE}`
  const second = await sendLocal(repairPrompt, opts)
  if (second.ok) {
    const secondValue = tryParse(second.text)
    if (secondValue !== null) {
      return { ok: true, value: secondValue, raw: second.text, model: second.model, repaired: true }
    }
  }

  return {
    ok: false,
    raw: second.ok ? second.text : first.text,
    model: first.model,
    repaired: true,
    error: 'Local model did not return valid JSON for this task (after one repair attempt).'
  }
}
