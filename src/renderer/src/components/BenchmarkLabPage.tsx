import { useCallback, useEffect, useMemo, useState } from 'react'
import './benchmark-lab.css'

export const BENCHMARK_CATEGORIES = [
  { id: 'repo-repair', label: 'Repository repair' },
  { id: 'multi-language', label: 'Multi-language coding' },
  { id: 'code-generation', label: 'Code generation' },
  { id: 'debugging', label: 'Debugging & repair' },
  { id: 'repo-understanding', label: 'Repository understanding' },
  { id: 'tool-agent', label: 'Tool & agent use' },
  { id: 'long-context', label: 'Long context' },
  { id: 'akorith-fixtures', label: 'Akorith fixtures' }
] as const

export type BenchmarkCategoryId = (typeof BENCHMARK_CATEGORIES)[number]['id']
export type BenchmarkRunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'

export interface BenchmarkSuiteOption {
  id: string
  label: string
  description: string
  categoryIds: BenchmarkCategoryId[]
}

export interface BenchmarkModelOption {
  id: string
  label: string
  providerLabel: string
  available: boolean
  unavailableReason?: string
}

export interface BenchmarkCatalog {
  suites: BenchmarkSuiteOption[]
  models: BenchmarkModelOption[]
}

export interface BenchmarkSetup {
  suiteId: string
  modelIds: string[]
  seed: number
  repetitions: number
}

export interface BenchmarkEvidence {
  id: string
  categoryId: BenchmarkCategoryId
  caseName: string
  status: 'passed' | 'failed' | 'error' | 'skipped'
  qualityScore: number | null
  durationMs: number | null
  promptTokens: number | null
  completionTokens: number | null
  costUsd: number | null
  hardwareLabel: string | null
  summary: string
}

export interface BenchmarkModelResult {
  modelId: string
  modelLabel: string
  rank: number | null
  qualityScore: number
  speedTokensPerSecond: number | null
  totalTokens: number | null
  costUsd: number | null
  hardwareUtilizationPct: number | null
  categoryScores: Partial<Record<BenchmarkCategoryId, number>>
  evidence: BenchmarkEvidence[]
}

export interface BenchmarkRecommendation {
  id: string
  useCase: string
  modelLabel: string
  rationale: string
}

export interface BenchmarkRun {
  id: string
  status: BenchmarkRunStatus
  createdAt: number
  completedAt: number | null
  setup: BenchmarkSetup
  results: BenchmarkModelResult[]
  recommendations: BenchmarkRecommendation[]
  error?: string
}

export interface BenchmarkLabApi {
  getCatalog(): Promise<BenchmarkCatalog>
  listRuns(limit?: number): Promise<BenchmarkRun[]>
  start(input: BenchmarkSetup): Promise<BenchmarkRun>
  cancel(runId: string): Promise<BenchmarkRun | void>
  getRun?(runId: string): Promise<BenchmarkRun>
}

interface BenchmarkLabPageProps {
  api?: BenchmarkLabApi | null
}

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })

function boundedPercent(value: number | null, maximum = 100): number {
  if (value === null || !Number.isFinite(value) || maximum <= 0) return 0
  return Math.min(100, Math.max(0, (value / maximum) * 100))
}

function MetricBar({ label, value, display, maximum = 100 }: { label: string; value: number | null; display: string; maximum?: number }): JSX.Element {
  const percent = boundedPercent(value, maximum)
  return (
    <div className="benchmark-metric">
      <div className="benchmark-metric-copy">
        <span>{label}</span>
        <output aria-label={`${label}: ${display}`}>{display}</output>
      </div>
      <div className="benchmark-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={maximum} aria-valuenow={value ?? undefined}>
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

function timestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function statusLabel(value: BenchmarkRunStatus): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export default function BenchmarkLabPage({ api }: BenchmarkLabPageProps): JSX.Element {
  const [catalog, setCatalog] = useState<BenchmarkCatalog | null>(null)
  const [runs, setRuns] = useState<BenchmarkRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [suiteId, setSuiteId] = useState('')
  const [modelIds, setModelIds] = useState<string[]>([])
  const [seed, setSeed] = useState('42')
  const [repetitions, setRepetitions] = useState('3')
  const [loading, setLoading] = useState(Boolean(api))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!api) return
    setLoading(true)
    setError(null)
    try {
      const [nextCatalog, nextRuns] = await Promise.all([api.getCatalog(), api.listRuns(20)])
      setCatalog(nextCatalog)
      setRuns(nextRuns)
      setSuiteId((current) => current || nextCatalog.suites[0]?.id || '')
      setSelectedRunId((current) => current || nextRuns[0]?.id || null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Benchmark data could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const activeRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  )

  useEffect(() => {
    if (!api?.getRun || !activeRun || !['queued', 'running'].includes(activeRun.status)) return
    const timer = window.setInterval(() => {
      void api
        .getRun!(activeRun.id)
        .then((next) => setRuns((current) => current.map((run) => (run.id === next.id ? next : run))))
        .catch(() => undefined)
    }, 1_500)
    return () => window.clearInterval(timer)
  }, [activeRun, api])

  const toggleModel = (id: string): void => {
    setModelIds((current) => (current.includes(id) ? current.filter((modelId) => modelId !== id) : [...current, id]))
  }

  const numericSeed = Number(seed)
  const numericRepetitions = Number(repetitions)
  const setupIsValid =
    Number.isInteger(numericSeed) && numericSeed >= 0 && numericSeed <= 2_147_483_647 &&
    Number.isInteger(numericRepetitions) && numericRepetitions >= 1 && numericRepetitions <= 20

  const start = async (): Promise<void> => {
    if (!api || !suiteId || modelIds.length === 0 || !setupIsValid) return
    setSubmitting(true)
    setError(null)
    try {
      const run = await api.start({ suiteId, modelIds, seed: numericSeed, repetitions: numericRepetitions })
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)])
      setSelectedRunId(run.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The benchmark could not be started.')
    } finally {
      setSubmitting(false)
    }
  }

  const cancel = async (): Promise<void> => {
    if (!api || !activeRun) return
    setSubmitting(true)
    setError(null)
    try {
      const next = await api.cancel(activeRun.id)
      if (next) setRuns((current) => current.map((run) => (run.id === next.id ? next : run)))
      else await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The benchmark could not be cancelled.')
    } finally {
      setSubmitting(false)
    }
  }

  const rankedResults = useMemo(
    () =>
      [...(activeRun?.results ?? [])].sort(
        (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || b.qualityScore - a.qualityScore
      ),
    [activeRun]
  )
  const maxSpeed = Math.max(1, ...rankedResults.map((result) => result.speedTokensPerSecond ?? 0))
  const maxTokens = Math.max(1, ...rankedResults.map((result) => result.totalTokens ?? 0))
  const maxCost = Math.max(0.0001, ...rankedResults.map((result) => result.costUsd ?? 0))

  if (!api) {
    return (
      <main className="benchmark-lab benchmark-state" aria-labelledby="benchmark-title">
        <span className="benchmark-kicker">Evaluation workspace</span>
        <h1 id="benchmark-title">Benchmark</h1>
        <p>The benchmark service is not available in this build. No results have been generated.</p>
      </main>
    )
  }

  return (
    <main className="benchmark-lab" aria-labelledby="benchmark-title" aria-busy={loading}>
      <header className="benchmark-header">
        <div>
          <span className="benchmark-kicker">Evaluation workspace</span>
          <h1 id="benchmark-title">Benchmark</h1>
          <p>Compare verified model runs across quality, throughput, tokens, cost, and hardware.</p>
        </div>
        <button type="button" className="benchmark-secondary" onClick={() => void load()} disabled={loading || submitting}>
          Refresh
        </button>
      </header>

      {error && <div className="benchmark-alert" role="alert">{error}</div>}

      <section className="benchmark-setup" aria-labelledby="benchmark-setup-title">
        <div className="benchmark-section-heading">
          <div>
            <span className="benchmark-step">01</span>
            <h2 id="benchmark-setup-title">Configure a reproducible run</h2>
          </div>
          <span>Production results only</span>
        </div>
        {loading && !catalog ? (
          <p className="benchmark-empty">Loading benchmark catalog…</p>
        ) : catalog?.suites.length && catalog.models.length ? (
          <form onSubmit={(event) => { event.preventDefault(); void start() }}>
            <div className="benchmark-form-grid">
              <label>
                Suite
                <select value={suiteId} onChange={(event) => setSuiteId(event.target.value)} required>
                  {catalog.suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.label}</option>)}
                </select>
                <small>{catalog.suites.find((suite) => suite.id === suiteId)?.description}</small>
              </label>
              <label>
                Seed
                <input type="number" min={0} max={2_147_483_647} step={1} value={seed} onChange={(event) => setSeed(event.currentTarget.value)} required />
                <small>Repeatable case ordering</small>
              </label>
              <label>
                Repetitions
                <input type="number" min={1} max={20} step={1} value={repetitions} onChange={(event) => setRepetitions(event.currentTarget.value)} required />
                <small>1–20 passes per case</small>
              </label>
            </div>
            <fieldset className="benchmark-model-picker">
              <legend>Models <span>{modelIds.length} selected</span></legend>
              <div>
                {catalog.models.map((model) => (
                  <label key={model.id} className={!model.available ? 'is-unavailable' : undefined}>
                    <input type="checkbox" checked={modelIds.includes(model.id)} onChange={() => toggleModel(model.id)} disabled={!model.available} />
                    <span><strong>{model.label}</strong><small>{model.providerLabel}{!model.available && model.unavailableReason ? ` · ${model.unavailableReason}` : ''}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="benchmark-actions">
              <button type="submit" className="benchmark-primary" disabled={submitting || !suiteId || modelIds.length === 0 || !setupIsValid}>Start benchmark</button>
              {activeRun && ['queued', 'running'].includes(activeRun.status) && (
                <button type="button" className="benchmark-danger" onClick={() => void cancel()} disabled={submitting}>Cancel active run</button>
              )}
            </div>
          </form>
        ) : (
          <p className="benchmark-empty">No benchmark suites or available model catalog entries were returned.</p>
        )}
      </section>

      <section className="benchmark-category-section" aria-labelledby="benchmark-category-title">
        <div className="benchmark-section-heading">
          <div><span className="benchmark-step">02</span><h2 id="benchmark-category-title">Category overview</h2></div>
          {activeRun && <span className={`benchmark-status is-${activeRun.status}`}>{statusLabel(activeRun.status)}</span>}
        </div>
        <div className="benchmark-categories">
          {BENCHMARK_CATEGORIES.map((category) => {
            const leaders = rankedResults
              .map((result) => ({ label: result.modelLabel, score: result.categoryScores[category.id] }))
              .filter((entry): entry is { label: string; score: number } => entry.score !== undefined)
              .sort((a, b) => b.score - a.score)
            return (
              <article key={category.id}>
                <span>{category.label}</span>
                {leaders[0] ? <><strong>{decimal.format(leaders[0].score)}</strong><small>Leader · {leaders[0].label}</small></> : <><strong>—</strong><small>Not measured</small></>}
              </article>
            )
          })}
        </div>
      </section>

      <section className="benchmark-results" aria-labelledby="benchmark-results-title">
        <div className="benchmark-section-heading">
          <div><span className="benchmark-step">03</span><h2 id="benchmark-results-title">Results</h2></div>
          {runs.length > 0 && (
            <label className="benchmark-run-select">Run
              <select value={activeRun?.id ?? ''} onChange={(event) => setSelectedRunId(event.target.value)}>
                {runs.map((run) => <option key={run.id} value={run.id}>{timestamp(run.createdAt)} · {statusLabel(run.status)}</option>)}
              </select>
            </label>
          )}
        </div>

        {!activeRun ? (
          <div className="benchmark-empty benchmark-empty-panel"><strong>No benchmark results yet</strong><span>Configure a suite and choose at least one available model to begin.</span></div>
        ) : activeRun.error ? (
          <div className="benchmark-alert" role="alert">{activeRun.error}</div>
        ) : rankedResults.length === 0 ? (
          <div className="benchmark-empty benchmark-empty-panel"><strong>{statusLabel(activeRun.status)}</strong><span>This run has not produced measured results.</span></div>
        ) : (
          <>
            <div className="benchmark-comparison" aria-label="Model metric comparison">
              {rankedResults.map((result, index) => (
                <article key={result.modelId} className="benchmark-model-result">
                  <header><span className="benchmark-rank">#{result.rank ?? index + 1}</span><div><h3>{result.modelLabel}</h3><small>Measured result</small></div></header>
                  <div className="benchmark-metric-grid">
                    <MetricBar label="Quality" value={result.qualityScore} display={`${decimal.format(result.qualityScore)} / 100`} />
                    <MetricBar label="Speed" value={result.speedTokensPerSecond} maximum={maxSpeed} display={result.speedTokensPerSecond === null ? 'Not reported' : `${decimal.format(result.speedTokensPerSecond)} tok/s`} />
                    <MetricBar label="Tokens" value={result.totalTokens} maximum={maxTokens} display={result.totalTokens === null ? 'Not reported' : integer.format(result.totalTokens)} />
                    <MetricBar label="Cost" value={result.costUsd} maximum={maxCost} display={result.costUsd === null ? 'Not reported' : money.format(result.costUsd)} />
                    <MetricBar label="Hardware" value={result.hardwareUtilizationPct} display={result.hardwareUtilizationPct === null ? 'Not reported' : `${decimal.format(result.hardwareUtilizationPct)}%`} />
                  </div>
                </article>
              ))}
            </div>

            <div className="benchmark-lower-grid">
              <section className="benchmark-ranking" aria-labelledby="benchmark-ranking-title">
                <h3 id="benchmark-ranking-title">Ranking</h3>
                <ol>
                  {rankedResults.map((result) => <li key={result.modelId}><strong>{result.modelLabel}</strong><span>{decimal.format(result.qualityScore)} quality</span></li>)}
                </ol>
              </section>
              <section className="benchmark-recommendations" aria-labelledby="benchmark-recommendations-title">
                <h3 id="benchmark-recommendations-title">Model fit</h3>
                {activeRun.recommendations.length ? activeRun.recommendations.map((recommendation) => (
                  <article key={recommendation.id}><span>{recommendation.useCase}</span><strong>{recommendation.modelLabel}</strong><p>{recommendation.rationale}</p></article>
                )) : <p className="benchmark-empty">No verified recommendations were returned.</p>}
              </section>
            </div>

            <details className="benchmark-evidence">
              <summary>Inspect evidence <span>{rankedResults.reduce((count, result) => count + result.evidence.length, 0)} cases</span></summary>
              <div className="benchmark-table-wrap">
                <table>
                  <caption>Secondary benchmark evidence for the selected run</caption>
                  <thead><tr><th>Model</th><th>Case</th><th>Category</th><th>Status</th><th>Quality</th><th>Duration</th><th>Tokens</th><th>Cost</th><th>Hardware</th><th>Evidence</th></tr></thead>
                  <tbody>
                    {rankedResults.flatMap((result) => result.evidence.map((evidence) => (
                      <tr key={`${result.modelId}:${evidence.id}`}>
                        <th scope="row">{result.modelLabel}</th><td>{evidence.caseName}</td><td>{BENCHMARK_CATEGORIES.find((category) => category.id === evidence.categoryId)?.label ?? evidence.categoryId}</td><td>{evidence.status}</td>
                        <td>{evidence.qualityScore === null ? '—' : decimal.format(evidence.qualityScore)}</td><td>{evidence.durationMs === null ? '—' : `${integer.format(evidence.durationMs)} ms`}</td>
                        <td>{evidence.promptTokens === null && evidence.completionTokens === null ? '—' : integer.format((evidence.promptTokens ?? 0) + (evidence.completionTokens ?? 0))}</td><td>{evidence.costUsd === null ? '—' : money.format(evidence.costUsd)}</td><td>{evidence.hardwareLabel ?? '—'}</td><td>{evidence.summary}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </section>
    </main>
  )
}
