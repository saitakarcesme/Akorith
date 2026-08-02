function titlePart(part: string): string {
  if (/^gpt$/i.test(part)) return 'GPT'
  if (/^api$/i.test(part)) return 'API'
  return part ? part[0].toUpperCase() + part.slice(1) : part
}

function prettySlug(model: string): string {
  if (model === 'beyefendi-v2-hf') return 'Beyefendi v2'
  if (model.startsWith('gpt-')) {
    const rest = model.slice(4).split('-').map(titlePart).join(' ')
    return `GPT-${rest}`
  }
  if (model.startsWith('claude-')) {
    return `Claude ${model.slice(7).split('-').map(titlePart).join(' ')}`
  }
  if (model.startsWith('codex-')) {
    return `Codex ${model.slice(6).split('-').map(titlePart).join(' ')}`
  }
  return model
}

export function formatModelLabel(model?: string | null, _providerId?: string): string {
  const raw = (model ?? '').trim()
  if (!raw || raw === 'default') return 'Default'
  return prettySlug(raw)
}

export function formatLocalModelLabel(id: string, label?: string): string {
  const display = (label ?? id).trim()
  return display || id
}
