import { useEffect, useMemo, useState } from 'react'
import type {
  CreateResearchJobInput,
  ProjectRow,
  ProviderInfo
} from '../../../preload/index.d'
import { SendIcon } from './icons'
import { RESEARCH_DURATION_OPTIONS } from './researchDuration'

type TargetKind = 'karpathy-starter' | 'project'

interface ResearchComposerProps {
  providers: ProviderInfo[] | null
  disabled?: boolean
  onSubmit: (input: CreateResearchJobInput) => Promise<boolean>
}

export default function ResearchComposer({
  providers,
  disabled = false,
  onSubmit
}: ResearchComposerProps): JSX.Element {
  const availableProviders = useMemo(
    () => (providers ?? []).filter((provider) =>
      provider.available.ok && provider.kind.includes('executor')
    ),
    [providers]
  )
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [targetKind, setTargetKind] = useState<TargetKind>('karpathy-starter')
  const [projectId, setProjectId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [depth, setDepth] = useState<CreateResearchJobInput['depth']>('standard')
  const [command, setCommand] = useState('npm run benchmark')
  const [editablePaths, setEditablePaths] = useState('src')
  const [metricName, setMetricName] = useState('score')
  const [metricPattern, setMetricPattern] = useState('^score:\\s*([0-9]+(?:\\.[0-9]+)?)\\s*$')
  const [metricDirection, setMetricDirection] = useState<'minimize' | 'maximize'>('maximize')
  const [timeoutMinutes, setTimeoutMinutes] = useState(10)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api.projects.list()
      .then((next) => {
        if (cancelled) return
        const withPaths = next.filter((project) => Boolean(project.path))
        setProjects(withPaths)
        setProjectId((current) => current || withPaths[0]?.id || '')
      })
      .catch(() => {
        if (!cancelled) setProjects([])
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (providerId && availableProviders.some((provider) => provider.id === providerId)) return
    const preferred = availableProviders.find((provider) => provider.id === 'chatgpt')
      ?? availableProviders.find((provider) => provider.id === 'claude')
      ?? availableProviders.find((provider) => provider.id === 'opencode')
      ?? availableProviders[0]
    setProviderId(preferred?.id ?? '')
  }, [availableProviders, providerId])

  const activeProvider = availableProviders.find((provider) => provider.id === providerId) ?? null
  const depthIndex = Math.max(0, RESEARCH_DURATION_OPTIONS.findIndex((item) => item.id === depth))
  const selectedDepth = RESEARCH_DURATION_OPTIONS[depthIndex]
  const projectReady = targetKind !== 'project' || Boolean(projectId)
  const customProtocolReady = targetKind !== 'project' || Boolean(
    command.trim()
    && editablePaths.trim()
    && metricName.trim()
    && metricPattern.trim()
    && timeoutMinutes >= 1
    && timeoutMinutes <= 120
  )
  const canSubmit = Boolean(
    prompt.trim()
    && providerId
    && projectReady
    && customProtocolReady
    && !disabled
    && !submitting
  )

  useEffect(() => {
    const availableModels = activeProvider?.models ?? []
    if (model && availableModels.includes(model)) return
    setModel(availableModels[0] ?? '')
  }, [activeProvider, model])

  async function submit(): Promise<void> {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const autoresearch: NonNullable<CreateResearchJobInput['autoresearch']> = targetKind === 'karpathy-starter'
        ? { target: { kind: 'karpathy-starter' } }
        : {
            target: { kind: 'project', projectId },
            command: command.trim(),
            editablePaths: editablePaths.split(/[,\n]/).map((path) => path.trim()).filter(Boolean),
            metricName: metricName.trim(),
            metricPattern: metricPattern.trim(),
            metricDirection,
            experimentTimeoutMinutes: timeoutMinutes
          }
      const created = await onSubmit({
        prompt: prompt.trim(),
        providerId,
        model: model || undefined,
        depth,
        outputFormat: 'md',
        mode: 'autoresearch',
        autoresearch,
        autoStart: true
      })
      if (created) setPrompt('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="research-composer" aria-label="Start Autoresearch">
      <div className="research-composer-intro">
        <span className="research-eyebrow">AUTORESEARCH</span>
        <h1>What should Akorith improve?</h1>
        <p>Akorith establishes a baseline, makes one scoped change, measures it, and keeps only verified improvements.</p>
      </div>

      <div className="research-composer-box">
        <div className="autoresearch-targets" role="radiogroup" aria-label="Experiment workspace">
          <button
            type="button"
            role="radio"
            aria-checked={targetKind === 'karpathy-starter'}
            className={targetKind === 'karpathy-starter' ? 'is-selected' : ''}
            onClick={() => setTargetKind('karpathy-starter')}
          >
            <span className="autoresearch-target-mark">K</span>
            <span>
              <strong>Karpathy starter</strong>
              <small>Official autoresearch · pinned upstream revision</small>
            </span>
            <em>GPU</em>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={targetKind === 'project'}
            className={targetKind === 'project' ? 'is-selected' : ''}
            onClick={() => setTargetKind('project')}
          >
            <span className="autoresearch-target-mark is-project">A</span>
            <span>
              <strong>Akorith project</strong>
              <small>Your repository · isolated Git worktree</small>
            </span>
            <em>CUSTOM</em>
          </button>
        </div>

        {targetKind === 'project' && (
          <label className="autoresearch-project-picker">
            <span>Experiment repository</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projects.length === 0 && <option value="">No local Akorith projects</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name} — {project.path}</option>
              ))}
            </select>
          </label>
        )}

        <textarea
          value={prompt}
          aria-label="Research objective"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder={targetKind === 'karpathy-starter'
            ? 'Describe the model improvement goal or research direction…'
            : 'Describe what should improve and any hypotheses the agent should explore…'}
          rows={4}
          disabled={disabled || submitting}
        />

        <div className="research-choice-block">
          <div className="research-duration-heading">
            <label id="research-duration-label" htmlFor="research-duration">Run duration</label>
            <output htmlFor="research-duration" aria-live="polite">
              <strong>{selectedDepth.label}</strong>
              <span>{selectedDepth.detail}</span>
            </output>
          </div>
          <div className="research-duration-control" data-duration-index={depthIndex}>
            <input
              id="research-duration"
              type="range"
              min={0}
              max={RESEARCH_DURATION_OPTIONS.length - 1}
              step={1}
              value={depthIndex}
              aria-labelledby="research-duration-label"
              aria-valuetext={`${selectedDepth.label}, ${selectedDepth.detail}`}
              onChange={(event) => setDepth(RESEARCH_DURATION_OPTIONS[Number(event.target.value)]?.id ?? 'standard')}
              disabled={disabled || submitting}
            />
            <div className="research-duration-labels" aria-hidden="true">
              {RESEARCH_DURATION_OPTIONS.map((item) => (
                <span key={item.id} data-short-label={item.shortLabel} className={depth === item.id ? 'is-selected' : ''}>{item.label}</span>
              ))}
            </div>
          </div>
        </div>

        {targetKind === 'karpathy-starter' ? (
          <div className="autoresearch-contract" aria-label="Karpathy experiment contract">
            <div><span>Edit boundary</span><strong>train.py</strong></div>
            <div><span>Benchmark</span><strong>uv run train.py</strong></div>
            <div><span>Decision metric</span><strong>val_bpb ↓</strong></div>
            <div><span>Per-run cap</span><strong>10 min</strong></div>
            <p>Requires <code>uv</code>, Python 3.10+, and one NVIDIA GPU. Akorith prepares the pinned upstream environment before the baseline.</p>
          </div>
        ) : (
          <details className="autoresearch-advanced" open>
            <summary><span>Experiment contract</span><em>Shell-free · rollback protected</em></summary>
            <div className="autoresearch-field-grid">
              <label className="is-wide"><span>Run command</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npm run benchmark" /></label>
              <label><span>Editable files / folders</span><input value={editablePaths} onChange={(event) => setEditablePaths(event.target.value)} placeholder="src, benchmark.ts" /></label>
              <label><span>Metric name</span><input value={metricName} onChange={(event) => setMetricName(event.target.value)} placeholder="score" /></label>
              <label className="is-wide"><span>Metric regex · numeric capture group</span><input value={metricPattern} onChange={(event) => setMetricPattern(event.target.value)} spellCheck={false} /></label>
              <label><span>Better result</span><select value={metricDirection} onChange={(event) => setMetricDirection(event.target.value as 'minimize' | 'maximize')}><option value="maximize">Higher wins</option><option value="minimize">Lower wins</option></select></label>
              <label><span>Per-run timeout</span><div className="autoresearch-number"><input type="number" min={1} max={120} value={timeoutMinutes} onChange={(event) => setTimeoutMinutes(Number(event.target.value))} /><em>min</em></div></label>
            </div>
          </details>
        )}

        <div className="research-composer-toolbar">
          <div className="research-composer-selects">
            <label>
              <span>Research agent</span>
              <select
                value={providerId}
                onChange={(event) => {
                  const next = availableProviders.find((provider) => provider.id === event.target.value)
                  setProviderId(event.target.value)
                  setModel(next?.models[0] ?? '')
                }}
                disabled={disabled || submitting || availableProviders.length === 0}
              >
                {availableProviders.length === 0 && <option value="">No executor providers available</option>}
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
          <button
            type="button"
            className="research-submit autoresearch-submit"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            <span>{submitting ? 'Starting…' : 'Start experiments'}</span>
            <SendIcon size={16} />
          </button>
        </div>
      </div>
    </section>
  )
}
