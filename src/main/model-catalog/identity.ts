import type { ModelSource } from './types'

const ID_MAX = 180

export function normalizeCatalogIdentifier(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:@/+\-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX)
  return normalized || fallback
}

/** Stable across refreshes; never depends on list order or transient health. */
export function stableCatalogModelId(input: {
  source: ModelSource
  providerId: string
  nodeId?: string | null
  modelId: string
}): string {
  // Encode each independently so provider/node/model delimiters can never
  // alias one another (for example an Ollama `name:tag`).
  const provider = encodeURIComponent(normalizeCatalogIdentifier(input.providerId, 'provider'))
  const node = encodeURIComponent(
    normalizeCatalogIdentifier(input.nodeId ?? (input.source === 'local' ? 'this-device' : input.source), 'node')
  )
  const model = encodeURIComponent(normalizeCatalogIdentifier(input.modelId, 'model'))
  return `model:${input.source}:${provider}:${node}:${model}`
}

export function catalogDisplayLabel(input: {
  source: ModelSource
  providerLabel: string
  nodeName?: string | null
  modelLabel: string
}): string {
  const model = input.modelLabel.trim() || 'Unnamed model'
  if (input.source === 'local') return `Local — This device · ${model}`
  if (input.source === 'remote') return `Remote — ${input.nodeName?.trim() || 'Remote node'} · ${model}`
  return `Cloud — ${input.providerLabel.trim() || 'Provider'} · ${model}`
}
