import { describeProviders } from '../providers/registry'
import { getRuntimeStatus } from '../ollama-connection'
import type { LocalModelInfo } from './types'

// List the local models available to Loop and internal execution flows. Prefers
// the live runtime's model list (resolved endpoint), falling back to the local
// provider's configured models.

export async function listLocalModels(): Promise<LocalModelInfo[]> {
  const seen = new Set<string>()
  const out: LocalModelInfo[] = []
  const add = (id: string): void => {
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    out.push({ id: trimmed, label: trimmed })
  }

  // 1) the live resolved runtime (already probed /api/tags).
  try {
    const status = await getRuntimeStatus()
    for (const m of status.models) add(m)
  } catch {
    /* fall through to provider list */
  }

  // 2) the local provider's configured/known models.
  try {
    const providers = await describeProviders()
    const local = providers.find((p) => p.id === 'local')
    if (local) for (const m of local.models) add(m)
  } catch {
    /* best effort */
  }

  return out
}

/** A sensible default local model id, or undefined if none are known. */
export async function defaultLocalModel(): Promise<string | undefined> {
  const models = await listLocalModels()
  return models[0]?.id
}
