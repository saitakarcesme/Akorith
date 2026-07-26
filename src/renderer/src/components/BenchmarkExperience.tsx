import { memo, useMemo, useState, type ReactNode } from 'react'

export type BenchmarkQueueStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type BenchmarkResultStatus = 'completed' | 'failed' | 'cancelled'
export type BenchmarkRunStatus = 'completed' | 'failed' | 'cancelled' | 'partial'

export interface BenchmarkModelViewModel {
  key: string
  label: string
  available: boolean
  reason?: string
}

export interface BenchmarkModelGroupViewModel {
  id: string
  label: string
  available: boolean
  reason?: string
  models: BenchmarkModelViewModel[]
}

export interface BenchmarkChallengeViewModel {
  id: string
  label: string
  category: string
  description: string
  metricLabel: string
  deliverables?: string[]
  requiresRepository?: boolean
  historicalRuns?: number
}

export interface BenchmarkSettingsViewModel {
  maxTokens: number
  temperature: number
  timeoutMs: number
  parallel: boolean
}

export interface BenchmarkQueueItemViewModel {
  id: string
  modelKey: string
  providerLabel: string
  modelLabel: string
  status: BenchmarkQueueStatus
  detail?: string
  durationMs?: number | null
}

export interface BenchmarkResultViewModel {
  id: string
  modelKey: string
  providerLabel: string
  modelLabel: string
  status: BenchmarkResultStatus
  rank?: number | null
  score?: number | null
  durationMs?: number | null
  tokens?: number | null
  primaryMetricLabel?: string
  primaryMetricValue?: string
}

export interface BenchmarkRecentRunViewModel {
  id: string
  createdAt: number
  challengeLabel: string
  modelCount: number
  status: BenchmarkRunStatus
  bestModelLabel?: string
  bestScore?: number | null
  durationMs?: number | null
}

export interface BenchmarkLibraryItemViewModel {
  id: string
  updatedAt: number
  challengeLabel: string
  providerLabel: string
  modelLabel: string
  status?: BenchmarkResultStatus
  score?: number | null
  durationMs?: number | null
}

// Concise aliases keep adapter code readable while the ViewModel-suffixed
// names remain explicit for consumers that share benchmark domain types.
export type BenchmarkChallengeView = BenchmarkChallengeViewModel
export type BenchmarkLibraryView = BenchmarkLibraryItemViewModel
export type BenchmarkModelGroupView = BenchmarkModelGroupViewModel
export type BenchmarkQueueView = BenchmarkQueueItemViewModel
export type BenchmarkRecentRunView = BenchmarkRecentRunViewModel
export type BenchmarkResultView = BenchmarkResultViewModel
export type BenchmarkSettingsView = BenchmarkSettingsViewModel

export interface BenchmarkExperienceProps {
  modelGroups: BenchmarkModelGroupViewModel[]
  selectedModelKeys: string[]
  onToggleModel: (modelKey: string) => void
  challenges: BenchmarkChallengeViewModel[]
  selectedChallengeId: string
  onSelectChallenge: (challengeId: string) => void
  settings: BenchmarkSettingsViewModel
  onSettingsChange: (patch: Partial<BenchmarkSettingsViewModel>) => void
  running: boolean
  onStart: () => void
  onStop: () => void
  queue: BenchmarkQueueItemViewModel[]
  results: BenchmarkResultViewModel[]
  recentRuns: BenchmarkRecentRunViewModel[]
  library: BenchmarkLibraryItemViewModel[]
  estimatedMs?: number | null
  validationMessage?: string | null
  repositorySetup?: ReactNode
}

function formatDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—'
  if (value < 1_000) return `${Math.round(value)} ms`
  const totalSeconds = Math.round(value / 1_000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

function statusLabel(status: BenchmarkQueueStatus | BenchmarkResultStatus | BenchmarkRunStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Running'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'partial':
      return 'Partial'
  }
}

function acceptFiniteNumber(value: string, onAccept: (numberValue: number) => void): void {
  if (value.trim() === '') return
  const numberValue = Number(value)
  if (Number.isFinite(numberValue)) onAccept(numberValue)
}

export const BenchmarkExperience = memo(function BenchmarkExperience({
  modelGroups,
  selectedModelKeys,
  onToggleModel,
  challenges,
  selectedChallengeId,
  onSelectChallenge,
  settings,
  onSettingsChange,
  running,
  onStart,
  onStop,
  queue,
  results,
  recentRuns,
  library,
  estimatedMs,
  validationMessage,
  repositorySetup
}: BenchmarkExperienceProps): JSX.Element {
  const [modelSearch, setModelSearch] = useState('')
  const [challengeSearch, setChallengeSearch] = useState('')

  const selectedKeySet = useMemo(() => new Set(selectedModelKeys), [selectedModelKeys])
  const allModels = useMemo(
    () =>
      modelGroups.flatMap((group) =>
        group.models.map((model) => ({
          ...model,
          providerId: group.id,
          providerLabel: group.label,
          providerAvailable: group.available,
          providerReason: group.reason
        }))
      ),
    [modelGroups]
  )
  const selectedModels = useMemo(
    () => selectedModelKeys.map((key) => allModels.find((model) => model.key === key)).filter((model) => model != null),
    [allModels, selectedModelKeys]
  )
  const visibleModelGroups = useMemo(() => {
    const query = modelSearch.trim().toLocaleLowerCase()
    if (!query) return modelGroups
    return modelGroups
      .map((group) => ({
        ...group,
        models: group.models.filter((model) =>
          `${group.label} ${model.label}`.toLocaleLowerCase().includes(query)
        )
      }))
      .filter((group) => group.models.length > 0)
  }, [modelGroups, modelSearch])
  const visibleChallenges = useMemo(() => {
    const query = challengeSearch.trim().toLocaleLowerCase()
    if (!query) return challenges
    return challenges.filter((challenge) =>
      `${challenge.label} ${challenge.category} ${challenge.description} ${challenge.metricLabel}`
        .toLocaleLowerCase()
        .includes(query)
    )
  }, [challengeSearch, challenges])
  const selectedChallenge = useMemo(
    () => challenges.find((challenge) => challenge.id === selectedChallengeId) ?? null,
    [challenges, selectedChallengeId]
  )
  const orderedResults = useMemo(
    () =>
      results.slice().sort((left, right) => {
        const leftRank = left.rank ?? Number.MAX_SAFE_INTEGER
        const rightRank = right.rank ?? Number.MAX_SAFE_INTEGER
        if (leftRank !== rightRank) return leftRank - rightRank
        return (right.score ?? -1) - (left.score ?? -1)
      }),
    [results]
  )

  const settledQueueCount = queue.filter((item) =>
    item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled'
  ).length
  const queueTotal = queue.length > 0 ? queue.length : selectedModels.length
  const activeQueueItem = queue.find((item) => item.status === 'running') ?? null
  const setupReady = selectedModels.length > 0 && selectedChallenge != null
  const startDisabled = running || !setupReady || Boolean(validationMessage)
  const viewState = running ? 'running' : results.length > 0 ? 'completed' : setupReady ? 'ready' : 'idle'
  const activeStep =
    selectedModels.length === 0 ? 1 : selectedChallenge == null ? 2 : validationMessage ? 3 : 4
  const stepItems = [
    { number: 1, label: 'Select Models' },
    { number: 2, label: 'Choose Benchmark' },
    { number: 3, label: 'Configure' },
    { number: 4, label: 'Run Benchmark' }
  ]
  const selectedModelSummary =
    selectedModels.length === 0
      ? 'No models selected'
      : `${selectedModels
          .slice(0, 3)
          .map((model) => `${model.providerLabel} · ${model.label}`)
          .join(', ')}${selectedModels.length > 3 ? ` +${selectedModels.length - 3}` : ''}`
  const workspaceHeading =
    viewState === 'running'
      ? 'Benchmark in progress'
      : viewState === 'completed'
        ? 'Benchmark results'
        : viewState === 'ready'
          ? 'Ready to run'
          : 'No benchmark runs yet'
  const workspaceCopy =
    viewState === 'running'
      ? activeQueueItem
        ? `${activeQueueItem.providerLabel} · ${activeQueueItem.modelLabel} is running.`
        : 'The selected models are being evaluated.'
      : viewState === 'completed'
        ? 'Measured results from the latest run are shown below.'
        : viewState === 'ready'
          ? 'Review the run summary and start when ready.'
          : 'Select models, choose a benchmark, and configure the run.'
  const progressMaximum = Math.max(queueTotal, 1)
  const queuePreview: BenchmarkQueueItemViewModel[] = queue.length > 0
    ? queue
    : selectedModels.map((model) => ({
        id: `ready-${model.key}`,
        modelKey: model.key,
        providerLabel: model.providerLabel,
        modelLabel: model.label,
        status: 'queued' as const
      }))

  return (
    <main className="benchmark-experience" data-state={viewState}>
      <div className="benchmark-experience__inner">
        <header className="benchmark-experience__header">
          <p className="benchmark-experience__intro" role="heading" aria-level={1}>
            <span className="benchmark-experience__title">Benchmark</span>
            <span className="benchmark-experience__subtitle">
              Run one challenge across models and compare reproducible performance.
            </span>
          </p>
        </header>

        <nav className="benchmark-experience__stepper-scroll" aria-label="Benchmark workflow">
          <ol className="benchmark-experience__stepper">
            {stepItems.map((step) => {
              const isCurrent = step.number === activeStep
              const isComplete = step.number < activeStep || (viewState === 'completed' && step.number === 4)
              return (
                <li
                  key={step.number}
                  className={`${isCurrent ? 'is-current' : ''} ${isComplete ? 'is-complete' : ''}`}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  <span aria-hidden="true">{step.number}</span>
                  <strong>{step.label}</strong>
                </li>
              )
            })}
          </ol>
        </nav>

        <div className="benchmark-experience__setup-grid">
          <section className="benchmark-experience__panel benchmark-experience__models" aria-labelledby="benchmark-models-title">
            <div className="benchmark-experience__panel-head">
              <h2 id="benchmark-models-title">Models</h2>
              <span>{selectedModels.length} selected</span>
            </div>
            <label className="benchmark-experience__search">
              <span className="benchmark-experience__sr-only">Search models</span>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="7" cy="7" r="4.25" />
                <path d="m10.25 10.25 3 3" />
              </svg>
              <input
                type="search"
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                placeholder="Search models..."
                autoComplete="off"
              />
            </label>

            <div className="benchmark-experience__model-list">
              {visibleModelGroups.map((group) => (
                <fieldset key={group.id} className="benchmark-experience__model-group">
                  <legend>
                    <span>{group.label}</span>
                    {!group.available && <small>{group.reason ?? 'Unavailable'}</small>}
                  </legend>
                  {group.models.map((model) => {
                    const disabled = !group.available || !model.available
                    const reason = model.reason ?? group.reason
                    return (
                      <label
                        key={model.key}
                        className={`benchmark-experience__choice ${disabled ? 'is-disabled' : ''}`}
                        title={disabled ? reason : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={selectedKeySet.has(model.key)}
                          disabled={disabled || running}
                          onChange={() => onToggleModel(model.key)}
                        />
                        <span>{model.label}</span>
                        {disabled && <small>{reason ?? 'Unavailable'}</small>}
                      </label>
                    )
                  })}
                </fieldset>
              ))}
              {visibleModelGroups.length === 0 && (
                <p className="benchmark-experience__inline-empty">No models match “{modelSearch.trim()}”.</p>
              )}
            </div>
          </section>

          <section className="benchmark-experience__panel benchmark-experience__challenges" aria-labelledby="benchmark-challenges-title">
            <div className="benchmark-experience__panel-head">
              <h2 id="benchmark-challenges-title">Benchmark</h2>
              <span>{challenges.length} available</span>
            </div>
            <label className="benchmark-experience__search">
              <span className="benchmark-experience__sr-only">Search benchmarks</span>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="7" cy="7" r="4.25" />
                <path d="m10.25 10.25 3 3" />
              </svg>
              <input
                type="search"
                value={challengeSearch}
                onChange={(event) => setChallengeSearch(event.target.value)}
                placeholder="Search benchmarks..."
                autoComplete="off"
              />
            </label>

            <fieldset className="benchmark-experience__challenge-list">
              <legend className="benchmark-experience__sr-only">Choose one benchmark</legend>
              {visibleChallenges.map((challenge) => (
                <label
                  key={challenge.id}
                  className={`benchmark-experience__challenge-choice ${
                    challenge.id === selectedChallengeId ? 'is-selected' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="benchmark-challenge"
                    value={challenge.id}
                    checked={challenge.id === selectedChallengeId}
                    disabled={running}
                    onChange={() => onSelectChallenge(challenge.id)}
                  />
                  <span>
                    <strong>{challenge.label}</strong>
                    <small>{challenge.category}</small>
                  </span>
                </label>
              ))}
              {visibleChallenges.length === 0 && (
                <p className="benchmark-experience__inline-empty">No benchmarks match “{challengeSearch.trim()}”.</p>
              )}
            </fieldset>

            {selectedChallenge && (
              <div className="benchmark-experience__challenge-detail">
                <div>
                  <strong>{selectedChallenge.metricLabel}</strong>
                  <span>
                    {selectedChallenge.requiresRepository ? 'Repository required' : 'Repository-free'}
                    {selectedChallenge.historicalRuns != null
                      ? ` · ${selectedChallenge.historicalRuns} historical run${
                          selectedChallenge.historicalRuns === 1 ? '' : 's'
                        }`
                      : ''}
                  </span>
                </div>
                <p>{selectedChallenge.description}</p>
                {selectedChallenge.deliverables && selectedChallenge.deliverables.length > 0 && (
                  <ul>
                    {selectedChallenge.deliverables.map((deliverable) => (
                      <li key={deliverable}>{deliverable}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <form
            className="benchmark-experience__panel benchmark-experience__settings"
            aria-labelledby="benchmark-settings-title"
            onSubmit={(event) => {
              event.preventDefault()
              if (!startDisabled) onStart()
            }}
          >
            <div className="benchmark-experience__panel-head">
              <h2 id="benchmark-settings-title">Settings</h2>
              <span>{settings.parallel ? 'Parallel' : 'Sequential'}</span>
            </div>

            <div className="benchmark-experience__settings-fields">
              <label className="benchmark-experience__field">
                <span>Max tokens</span>
                <input
                  type="number"
                  min={64}
                  max={1_000_000}
                  step={64}
                  value={settings.maxTokens}
                  disabled={running}
                  onChange={(event) =>
                    acceptFiniteNumber(event.target.value, (maxTokens) => onSettingsChange({ maxTokens }))
                  }
                />
              </label>
              <label className="benchmark-experience__field">
                <span>Temperature</span>
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={settings.temperature}
                  disabled={running}
                  onChange={(event) =>
                    acceptFiniteNumber(event.target.value, (temperature) => onSettingsChange({ temperature }))
                  }
                />
              </label>
              <label className="benchmark-experience__field">
                <span>Timeout</span>
                <span className="benchmark-experience__input-unit">
                  <input
                    type="number"
                    min={1}
                    max={1_800}
                    step={1}
                    value={Math.round(settings.timeoutMs / 1_000)}
                    disabled={running}
                    onChange={(event) =>
                      acceptFiniteNumber(event.target.value, (timeoutSeconds) =>
                        onSettingsChange({ timeoutMs: timeoutSeconds * 1_000 })
                      )
                    }
                  />
                  <small>sec</small>
                </span>
              </label>
              <label className="benchmark-experience__switch-row">
                <span>
                  <strong>Parallel execution</strong>
                  <small>Run selected models at the same time.</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={settings.parallel}
                  disabled={running}
                  onChange={(event) => onSettingsChange({ parallel: event.target.checked })}
                />
              </label>
            </div>

            <div className="benchmark-experience__settings-summary">
              <div>
                <span>Models</span>
                <strong>{selectedModels.length || '—'}</strong>
              </div>
              <div>
                <span>Estimate</span>
                <strong>{estimatedMs == null ? 'No estimate' : formatDuration(estimatedMs)}</strong>
              </div>
            </div>

            <p className="benchmark-experience__settings-note">
              Timeout is enforced for every provider. Token and temperature controls are applied directly by supported runtimes and included in the run contract for the others.
            </p>

            {validationMessage && (
              <p id="benchmark-validation-message" className="benchmark-experience__validation" role="alert">
                {validationMessage}
              </p>
            )}

            {running ? (
              <button type="button" className="benchmark-experience__run-button is-stop" onClick={onStop}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="4.25" y="4.25" width="7.5" height="7.5" />
                </svg>
                Stop Benchmark
              </button>
            ) : (
              <button
                type="submit"
                className="benchmark-experience__run-button"
                disabled={startDisabled}
                aria-describedby={validationMessage ? 'benchmark-validation-message' : undefined}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m5.25 3.75 6 4.25-6 4.25z" />
                </svg>
                Start Benchmark
              </button>
            )}
          </form>
        </div>

        {repositorySetup}

        <section className="benchmark-experience__selection-summary" aria-label="Selected benchmark summary">
          <div>
            <span>Selected models</span>
            <strong title={selectedModelSummary}>{selectedModelSummary}</strong>
          </div>
          <div>
            <span>Benchmark</span>
            <strong>{selectedChallenge?.label ?? 'Not selected'}</strong>
          </div>
          <div>
            <span>Execution</span>
            <strong>{settings.parallel ? 'Parallel' : 'Sequential'}</strong>
          </div>
          <div>
            <span>Estimated time</span>
            <strong>{estimatedMs == null ? 'No estimate yet' : formatDuration(estimatedMs)}</strong>
          </div>
        </section>

        <section
          className="benchmark-experience__workspace"
          data-state={viewState}
          aria-labelledby="benchmark-workspace-title"
        >
          <header className="benchmark-experience__workspace-head">
            <div>
              <span>Latest run</span>
              <h2 id="benchmark-workspace-title">{workspaceHeading}</h2>
              <p role={running ? 'status' : undefined} aria-live={running ? 'polite' : undefined}>
                {workspaceCopy}
              </p>
            </div>
            <dl>
              <div>
                <dt>Completed</dt>
                <dd>{queueTotal > 0 ? `${settledQueueCount}/${queueTotal}` : '—'}</dd>
              </div>
              <div>
                <dt>Estimate</dt>
                <dd>{estimatedMs == null ? '—' : formatDuration(estimatedMs)}</dd>
              </div>
            </dl>
          </header>

          {running && (
            <div className="benchmark-experience__live-progress">
              <progress value={settledQueueCount} max={progressMaximum}>
                {settledQueueCount} of {progressMaximum}
              </progress>
              <span>
                {settledQueueCount} of {queueTotal} complete
              </span>
              <strong>{activeQueueItem?.detail ?? activeQueueItem?.modelLabel ?? 'Preparing next model'}</strong>
            </div>
          )}

          {viewState === 'idle' && recentRuns.length === 0 && library.length === 0 ? (
            <div className="benchmark-experience__empty">
              <span aria-hidden="true">
                <svg viewBox="0 0 32 32">
                  <rect x="6" y="17" width="4" height="9" />
                  <rect x="14" y="11" width="4" height="15" />
                  <rect x="22" y="6" width="4" height="20" />
                </svg>
              </span>
              <strong>No benchmark runs yet</strong>
              <p>Configure your benchmark and start the run.</p>
            </div>
          ) : (
            <div className="benchmark-experience__run-grid">
              <section className="benchmark-experience__subpanel benchmark-experience__results">
                <div className="benchmark-experience__subpanel-head">
                  <div>
                    <h3>Score table</h3>
                    <p>{selectedChallenge?.metricLabel ?? 'Comparable benchmark results'}</p>
                  </div>
                  <span>{orderedResults.length} results</span>
                </div>
                {orderedResults.length === 0 ? (
                  <div className="benchmark-experience__subpanel-empty">
                    {viewState === 'ready'
                      ? 'Results will appear here after the run starts.'
                      : 'Waiting for the first completed model.'}
                  </div>
                ) : (
                  <div className="benchmark-experience__table-scroll">
                    <table>
                      <caption className="benchmark-experience__sr-only">Latest benchmark scores</caption>
                      <thead>
                        <tr>
                          <th scope="col">Rank</th>
                          <th scope="col">Model</th>
                          <th scope="col">Status</th>
                          <th scope="col">Score</th>
                          <th scope="col">Duration</th>
                          <th scope="col">Tokens</th>
                          <th scope="col">Primary metric</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orderedResults.map((result) => (
                          <tr key={result.id}>
                            <td>{result.rank == null ? '—' : `#${result.rank}`}</td>
                            <th scope="row">
                              <strong>{result.modelLabel}</strong>
                              <span>{result.providerLabel}</span>
                            </th>
                            <td>
                              <span className={`benchmark-experience__status is-${result.status}`}>
                                {statusLabel(result.status)}
                              </span>
                            </td>
                            <td>{result.score == null ? '—' : result.score}</td>
                            <td>{formatDuration(result.durationMs)}</td>
                            <td>{result.tokens == null ? '—' : result.tokens.toLocaleString()}</td>
                            <td>
                              {result.primaryMetricValue ?? '—'}
                              {result.primaryMetricLabel && <span>{result.primaryMetricLabel}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <aside className="benchmark-experience__subpanel benchmark-experience__queue" aria-labelledby="benchmark-queue-title">
                <div className="benchmark-experience__subpanel-head">
                  <div>
                    <h3 id="benchmark-queue-title">Run queue</h3>
                    <p>{settings.parallel ? 'Parallel execution' : 'Sequential execution'}</p>
                  </div>
                  <span>{queuePreview.length} models</span>
                </div>
                {queuePreview.length === 0 ? (
                  <div className="benchmark-experience__subpanel-empty">Select models to prepare the queue.</div>
                ) : (
                  <ol className="benchmark-experience__queue-list">
                    {queuePreview.map((item, itemIndex) => (
                      <li key={item.id} className={`is-${item.status}`}>
                        <span>{itemIndex + 1}</span>
                        <div>
                          <strong>{item.modelLabel}</strong>
                          <small>{item.providerLabel}</small>
                          {item.detail && <p>{item.detail}</p>}
                        </div>
                        <div>
                          <span>{queue.length === 0 ? 'Ready' : statusLabel(item.status)}</span>
                          <time>{formatDuration(item.durationMs)}</time>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </aside>
            </div>
          )}

          <div className="benchmark-experience__history-grid">
            <section className="benchmark-experience__subpanel benchmark-experience__recent">
              <div className="benchmark-experience__subpanel-head">
                <div>
                  <h3>Recent runs</h3>
                  <p>Persisted benchmark sessions</p>
                </div>
                <span>{recentRuns.length} saved</span>
              </div>
              {recentRuns.length === 0 ? (
                <div className="benchmark-experience__subpanel-empty">Completed runs will be listed here.</div>
              ) : (
                <div className="benchmark-experience__table-scroll">
                  <table>
                    <caption className="benchmark-experience__sr-only">Recent benchmark runs</caption>
                    <thead>
                      <tr>
                        <th scope="col">When</th>
                        <th scope="col">Benchmark</th>
                        <th scope="col">Models</th>
                        <th scope="col">Best result</th>
                        <th scope="col">Duration</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentRuns.slice(0, 8).map((run) => (
                        <tr key={run.id}>
                          <td>
                            <time dateTime={new Date(run.createdAt).toISOString()}>{formatTimestamp(run.createdAt)}</time>
                          </td>
                          <th scope="row">{run.challengeLabel}</th>
                          <td>{run.modelCount}</td>
                          <td>
                            {run.bestModelLabel ?? '—'}
                            {run.bestScore != null && <span>{run.bestScore}</span>}
                          </td>
                          <td>{formatDuration(run.durationMs)}</td>
                          <td>
                            <span className={`benchmark-experience__status is-${run.status}`}>
                              {statusLabel(run.status)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="benchmark-experience__subpanel benchmark-experience__library">
              <div className="benchmark-experience__subpanel-head">
                <div>
                  <h3>Historical library</h3>
                  <p>Latest saved result per model and challenge</p>
                </div>
                <span>{library.length} entries</span>
              </div>
              {library.length === 0 ? (
                <div className="benchmark-experience__subpanel-empty">No historical results yet.</div>
              ) : (
                <ul className="benchmark-experience__library-list">
                  {library.slice(0, 6).map((item) => (
                    <li key={item.id}>
                      <div>
                        <strong>{item.modelLabel}</strong>
                        <span>{item.providerLabel} · {item.challengeLabel}</span>
                      </div>
                      <div>
                        <strong>{item.score == null ? '—' : item.score}</strong>
                        <time dateTime={new Date(item.updatedAt).toISOString()}>{formatTimestamp(item.updatedAt)}</time>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </section>
      </div>
    </main>
  )
})

export default BenchmarkExperience
