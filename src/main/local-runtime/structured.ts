import { sendLocal } from './send'
import { extractJson, parseJsonLoose } from './json'
import type { LocalRuntimeSendOptions, LocalStructuredResult } from './types'

// Phase 47: structured (JSON) output from the local model with tolerant parsing
// and a single repair retry. Used by Loop/Companions/Agents planners.

export { extractJson, parseJsonLoose }

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
