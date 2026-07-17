import { useEffect, useMemo, useState } from 'react'
import type {
  CreateResearchJobInput,
  ProviderInfo,
  ResearchDepth,
  ResearchOutputFormat
} from '../../../preload/index.d'
import { SendIcon } from './icons'

const DEPTHS: Array<{ id: ResearchDepth; label: string; duration: string; detail: string }> = [
  { id: 'quick', label: 'Quick', duration: '~10 min', detail: 'Focused scan' },
  { id: 'standard', label: 'Research', duration: '~1 hour', detail: 'Cross-checked' },
  { id: 'deep', label: 'Deep', duration: '10+ hours', detail: 'Broad evidence' },
  { id: 'continuous', label: 'Continuous', duration: 'Until paused', detail: 'Keeps watching' }
]

const OUTPUTS: Array<{ id: ResearchOutputFormat; label: string }> = [
  { id: 'pdf', label: 'PDF' },
  { id: 'md', label: 'Markdown' },
  { id: 'docx', label: 'DOCX' },
  { id: 'xlsx', label: 'Excel' },
  { id: 'pptx', label: 'PowerPoint' }
]

interface ResearchComposerProps {
  providers: ProviderInfo[] | null
  disabled?: boolean
  compact?: boolean
  onSubmit: (input: CreateResearchJobInput) => Promise<boolean>
}

export default function ResearchComposer({
  providers,
  disabled = false,
  compact = false,
  onSubmit
}: ResearchComposerProps): JSX.Element {
  const availableProviders = useMemo(
    () => (providers ?? []).filter((provider) => provider.available.ok && provider.kind.includes('chat')),
    [providers]
  )
  const [prompt, setPrompt] = useState('')
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [depth, setDepth] = useState<ResearchDepth>('standard')
  const [outputFormat, setOutputFormat] = useState<ResearchOutputFormat>('pdf')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (providerId && availableProviders.some((provider) => provider.id === providerId)) return
    const preferred = availableProviders.find((provider) => provider.id === 'claude')
      ?? availableProviders.find((provider) => provider.id === 'opencode')
      ?? availableProviders[0]
    setProviderId(preferred?.id ?? '')
  }, [availableProviders, providerId])

  const activeProvider = availableProviders.find((provider) => provider.id === providerId) ?? null

  useEffect(() => {
    const availableModels = activeProvider?.models ?? []
    if (model && availableModels.includes(model)) return
    setModel(availableModels[0] ?? '')
  }, [activeProvider, model])

  async function submit(): Promise<void> {
    if (!prompt.trim() || !providerId || disabled || submitting) return
    setSubmitting(true)
    try {
      const created = await onSubmit({
        prompt: prompt.trim(),
        providerId,
        model: model || undefined,
        depth,
        outputFormat,
        autoStart: true
      })
      if (created) setPrompt('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className={`research-composer ${compact ? 'is-compact' : ''}`} aria-label="Start autonomous research">
      {!compact && (
        <div className="research-composer-intro">
          <span className="research-eyebrow">AUTONOMOUS RESEARCH</span>
          <h1>What should Akorith investigate?</h1>
          <p>Describe the outcome once. Akorith plans, gathers evidence, cross-checks claims, and publishes a validated deliverable without stopping for questions.</p>
        </div>
      )}
      <div className="research-composer-box">
        <textarea
          value={prompt}
          aria-label="Research request"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder="Research a topic, compare evidence, monitor a field, or build a complete report…"
          rows={compact ? 2 : 4}
          disabled={disabled || submitting}
        />
        {!compact && (
          <div className="research-choice-block">
            <span className="research-choice-label">Depth</span>
            <div className="research-depth-options" role="group" aria-label="Research depth">
              {DEPTHS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={depth === item.id ? 'is-selected' : ''}
                  aria-pressed={depth === item.id}
                  onClick={() => setDepth(item.id)}
                  disabled={disabled || submitting}
                >
                  <strong>{item.label}</strong>
                  <span>{item.duration}</span>
                  <small>{item.detail}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="research-composer-toolbar">
          <div className="research-composer-selects">
            <label>
              <span>Model provider</span>
              <select
                value={providerId}
                onChange={(event) => {
                  const next = availableProviders.find((provider) => provider.id === event.target.value)
                  setProviderId(event.target.value)
                  setModel(next?.models[0] ?? '')
                }}
                disabled={disabled || submitting || availableProviders.length === 0}
              >
                {availableProviders.length === 0 && <option value="">No providers available</option>}
                {availableProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
              </select>
            </label>
            <label>
              <span>Model</span>
              <select value={model} onChange={(event) => setModel(event.target.value)} disabled={disabled || submitting}>
                {(activeProvider?.models.length ? activeProvider.models : ['']).map((item) => (
                  <option key={item || 'default'} value={item}>{item || 'Default model'}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="research-output-options" role="group" aria-label="Output format">
            {OUTPUTS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={outputFormat === item.id ? 'is-selected' : ''}
                aria-pressed={outputFormat === item.id}
                onClick={() => setOutputFormat(item.id)}
                disabled={disabled || submitting}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="research-submit"
            title="Start research"
            aria-label="Start research"
            onClick={() => void submit()}
            disabled={!prompt.trim() || !providerId || disabled || submitting}
          >
            <SendIcon size={17} />
          </button>
        </div>
      </div>
    </section>
  )
}
