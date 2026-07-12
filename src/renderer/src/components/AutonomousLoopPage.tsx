import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AutonomousLoopCycle,
  AutonomousLoopDetail,
  AutonomousLoopEvent,
  AutonomousLoopRecord,
  AutonomousModelSelection,
  CatalogDiscoveryView,
  CatalogModelView,
  CreateAutonomousLoopInput
} from '../../../preload/index.d'
import './autonomous-loop.css'

const EXECUTOR_CAPABILITIES = [
  'file_read',
  'file_edit',
  'file_create',
  'file_delete',
  'command_execution',
  'tool_use',
  'multi_file_reasoning',
  'code_generation',
  'test_execution',
  'debugging',
  'iterative_repair',
  'streaming_status'
] as const

type SetupStep = 'source' | 'executor' | 'review'
type SourceKind = 'new' | 'existing_github'
type LoopGroup = 'active' | 'paused' | 'recent'

const STATUS_LABEL: Record<AutonomousLoopRecord['status'], string> = {
  setting_up: 'Setting up',
  running: 'Running',
  pausing: 'Pausing',
  paused: 'Paused',
  stopping: 'Stopping',
  stopped: 'Stopped',
  completed: 'Completed',
  error: 'Needs attention'
}

const STAGE_LABEL: Record<AutonomousLoopRecord['stage'], string> = {
  idle: 'Idle',
  observing: 'Observing',
  analyzing: 'Analyzing',
  inventory: 'Inventory',
  planning: 'Planning',
  executing: 'Executing',
  validating: 'Validating',
  repairing: 'Repairing',
  reviewing: 'Reviewing',
  committing: 'Committing',
  pushing: 'Pushing',
  scheduling: 'Scheduling'
}

function requestId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${random}`
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function formatTime(timestamp: number | null): string {
  if (timestamp === null) return 'Not yet'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
}

function formatRelativeTime(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null) return 'No activity yet'
  const seconds = Math.round((timestamp - now) / 1_000)
  const absolute = Math.abs(seconds)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (absolute < 60) return formatter.format(seconds, 'second')
  if (absolute < 3_600) return formatter.format(Math.round(seconds / 60), 'minute')
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3_600), 'hour')
  return formatter.format(Math.round(seconds / 86_400), 'day')
}

function modelIsFreshAndEligible(model: CatalogModelView, now = Date.now()): boolean {
  if (model.availability.status !== 'available') return false
  if (model.latestProbe?.status !== 'succeeded' || (model.latestProbe.freshUntil ?? 0) < now) return false
  return EXECUTOR_CAPABILITIES.every((name) => {
    const capability = model.effectiveCapabilities[name]
    return capability?.support === 'supported' && capability.source === 'probe' && capability.verifiedAt !== null
  })
}

function modelReason(model: CatalogModelView, now = Date.now()): string {
  if (model.availability.status !== 'available') return model.availability.reason ?? 'Model is unavailable.'
  if (!model.latestProbe) return 'Run the code capability probe before selecting this model.'
  if (model.latestProbe.status !== 'succeeded') return model.latestProbe.failureMessage ?? `Latest probe: ${model.latestProbe.status}.`
  if ((model.latestProbe.freshUntil ?? 0) < now) return 'The capability probe has expired. Run it again.'
  const missing = EXECUTOR_CAPABILITIES.filter((name) => {
    const value = model.effectiveCapabilities[name]
    return value?.support !== 'supported' || value.source !== 'probe' || value.verifiedAt === null
  })
  return missing.length > 0 ? `Probe did not confirm ${missing.join(', ')}.` : 'Fresh probe confirmed every Loop capability.'
}

function modelSelection(model: CatalogModelView): AutonomousModelSelection & { capabilityProbeId: string } {
  return {
    catalogId: model.id,
    providerId: model.providerId,
    model: model.modelName,
    location: model.source,
    nodeId: model.nodeId ?? undefined,
    capabilityProbeId: model.latestProbe!.id
  }
}

function groupFor(loop: AutonomousLoopRecord): LoopGroup {
  if (loop.status === 'paused') return 'paused'
  if (['setting_up', 'running', 'pausing', 'stopping'].includes(loop.status)) return 'active'
  return 'recent'
}

function LoopStatus({ loop }: { loop: AutonomousLoopRecord }): JSX.Element {
  return (
    <span className={`aloop-status is-${loop.status}`}>
      <span aria-hidden="true" />
      {STATUS_LABEL[loop.status]}
    </span>
  )
}

function LoopActions({
  loop,
  busy,
  onOpen,
  onPause,
  onResume,
  onStop
}: {
  loop: AutonomousLoopRecord
  busy: boolean
  onOpen: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
}): JSX.Element {
  const canPause = loop.status === 'running' || loop.status === 'setting_up'
  const canResume = loop.status === 'paused'
  const canStop = !['stopped', 'completed', 'error', 'stopping'].includes(loop.status)
  return (
    <div className="aloop-card-actions" aria-label={`${loop.projectName} actions`}>
      <button type="button" onClick={onOpen}>Open</button>
      {canPause && <button type="button" disabled={busy} onClick={onPause}>Pause</button>}
      {canResume && <button type="button" disabled={busy} onClick={onResume}>Resume</button>}
      {canStop && <button type="button" className="is-danger" disabled={busy} onClick={onStop}>Stop</button>}
    </div>
  )
}

function LoopCard({
  loop,
  busy,
  onOpen,
  onPause,
  onResume,
  onStop
}: {
  loop: AutonomousLoopRecord
  busy: boolean
  onOpen: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
}): JSX.Element {
  const tokens = loop.tokenUsage.input + loop.tokenUsage.output + loop.tokenUsage.cached
  const runtime = loop.executor.location === 'remote'
    ? loop.executor.nodeId ?? 'Remote node'
    : loop.executor.location === 'local' ? 'This device' : 'Cloud runtime'
  return (
    <article className="aloop-card" aria-labelledby={`aloop-card-title-${loop.id}`}>
      <div className="aloop-card-main">
        <div className="aloop-card-title-row">
          <button id={`aloop-card-title-${loop.id}`} type="button" className="aloop-card-title" onClick={onOpen}>{loop.projectName}</button>
          <LoopStatus loop={loop} />
        </div>
        <p className="aloop-card-repository" title={loop.workspacePath}>{loop.repositoryId}</p>
        <dl className="aloop-card-facts">
          <div><dt>Phase</dt><dd>{STAGE_LABEL[loop.stage]}</dd></div>
          <div><dt>Executor</dt><dd>{loop.executor.model}</dd></div>
          <div><dt>Runtime</dt><dd>{runtime}</dd></div>
          <div><dt>Activity</dt><dd title={formatTime(loop.lastActivityAt)}>{formatRelativeTime(loop.lastActivityAt)}</dd></div>
        </dl>
      </div>
      <div className="aloop-card-totals" aria-label="Loop totals">
        <span><strong>{loop.commitCount}</strong> commits</span>
        <span><strong>{loop.pushCount}</strong> pushes</span>
        <span><strong>{formatCount(tokens)}</strong> tokens</span>
      </div>
      <LoopActions loop={loop} busy={busy} onOpen={onOpen} onPause={onPause} onResume={onResume} onStop={onStop} />
    </article>
  )
}

function LoopCollection({
  title,
  description,
  loops,
  busyId,
  action
}: {
  title: string
  description: string
  loops: AutonomousLoopRecord[]
  busyId: string | null
  action: (kind: 'open' | 'pause' | 'resume' | 'stop', loop: AutonomousLoopRecord) => void
}): JSX.Element | null {
  if (loops.length === 0) return null
  return (
    <section className="aloop-group" aria-labelledby={`aloop-group-${title.toLowerCase()}`}>
      <div className="aloop-group-heading">
        <div>
          <h2 id={`aloop-group-${title.toLowerCase()}`}>{title}</h2>
          <p>{description}</p>
        </div>
        <span>{loops.length}</span>
      </div>
      <div className="aloop-card-list">
        {loops.map((loop) => (
          <LoopCard
            key={loop.id}
            loop={loop}
            busy={busyId === loop.id}
            onOpen={() => action('open', loop)}
            onPause={() => action('pause', loop)}
            onResume={() => action('resume', loop)}
            onStop={() => action('stop', loop)}
          />
        ))}
      </div>
    </section>
  )
}

interface SourceState {
  kind: SourceKind
  parentPath: string
  projectName: string
  remoteUrl: string
  createRemoteWithPlugin: boolean
  githubOwner: string
  githubVisibility: 'private' | 'public'
}

const EMPTY_SOURCE: SourceState = {
  kind: 'new',
  parentPath: '',
  projectName: '',
  remoteUrl: '',
  createRemoteWithPlugin: false,
  githubOwner: '',
  githubVisibility: 'private'
}

function SetupProgress({ step }: { step: SetupStep }): JSX.Element {
  const position = step === 'source' ? 1 : step === 'executor' ? 2 : 3
  return (
    <ol className="aloop-setup-progress" aria-label="Create Loop progress">
      {['Project source', 'Executor', 'Review & start'].map((label, index) => (
        <li key={label} className={index + 1 === position ? 'is-current' : index + 1 < position ? 'is-complete' : ''} aria-current={index + 1 === position ? 'step' : undefined}>
          <span>{index + 1}</span>{label}
        </li>
      ))}
    </ol>
  )
}

function SourceStep({ source, onChange }: { source: SourceState; onChange: (next: SourceState) => void }): JSX.Element {
  return (
    <section className="aloop-setup-panel" aria-labelledby="aloop-source-title">
      <div className="aloop-section-copy">
        <p className="aloop-eyebrow">Step 1</p>
        <h2 id="aloop-source-title">Choose the project source</h2>
        <p>Loop works from a real repository. Create a clean project or clone an existing GitHub repository.</p>
      </div>
      <fieldset className="aloop-source-choice">
        <legend>Source type</legend>
        <label className={source.kind === 'new' ? 'is-selected' : ''}>
          <input type="radio" name="source-kind" checked={source.kind === 'new'} onChange={() => onChange({ ...source, kind: 'new' })} />
          <span><strong>New project</strong><small>Initialize a repository in a chosen parent folder.</small></span>
        </label>
        <label className={source.kind === 'existing_github' ? 'is-selected' : ''}>
          <input type="radio" name="source-kind" checked={source.kind === 'existing_github'} onChange={() => onChange({ ...source, kind: 'existing_github' })} />
          <span><strong>Existing GitHub repository</strong><small>Clone a validated HTTPS or SSH GitHub URL.</small></span>
        </label>
      </fieldset>
      {source.kind === 'new' ? (
        <div className="aloop-fields">
          <label><span>Parent folder</span><input autoFocus required value={source.parentPath} placeholder="C:\\Projects" onChange={(event) => onChange({ ...source, parentPath: event.target.value })} /></label>
          <label><span>Project name</span><input required value={source.projectName} placeholder="my-project" onChange={(event) => onChange({ ...source, projectName: event.target.value })} /></label>
          <label><span>GitHub remote URL</span><input required={!source.createRemoteWithPlugin} disabled={source.createRemoteWithPlugin} value={source.remoteUrl} placeholder="https://github.com/owner/repository.git" onChange={(event) => onChange({ ...source, remoteUrl: event.target.value, createRemoteWithPlugin: false })} /></label>
          <label className="aloop-check">
            <input type="checkbox" checked={source.createRemoteWithPlugin} onChange={(event) => onChange({ ...source, createRemoteWithPlugin: event.target.checked, remoteUrl: event.target.checked ? '' : source.remoteUrl })} />
            <span>Create the required GitHub remote through the connected GitHub plugin instead</span>
          </label>
          {source.createRemoteWithPlugin && (
            <div className="aloop-inline-fields">
              <label><span>GitHub owner</span><input required value={source.githubOwner} onChange={(event) => onChange({ ...source, githubOwner: event.target.value })} /></label>
              <label><span>Visibility</span><select value={source.githubVisibility} onChange={(event) => onChange({ ...source, githubVisibility: event.target.value as 'private' | 'public' })}><option value="private">Private</option><option value="public">Public</option></select></label>
            </div>
          )}
        </div>
      ) : (
        <div className="aloop-fields">
          <label><span>GitHub repository URL</span><input autoFocus required value={source.remoteUrl} placeholder="https://github.com/owner/repository.git" onChange={(event) => onChange({ ...source, remoteUrl: event.target.value })} /></label>
          <p className="aloop-field-note">Akorith validates the remote, clone access, and push permission before the Loop begins.</p>
        </div>
      )}
    </section>
  )
}

function ModelBadges({ model, eligible }: { model: CatalogModelView; eligible: boolean }): JSX.Element {
  const context = model.contextWindowTokens ? `${formatCount(model.contextWindowTokens)} context` : 'Context unknown'
  const load = model.currentLoadPercent === null ? 'Load unknown' : `${Math.round(model.currentLoadPercent)}% load`
  return (
    <div className="aloop-model-badges" aria-label="Model details">
      <span>{model.providerLabel}</span>
      <span>{model.source === 'remote' ? model.nodeName ?? 'Remote node' : model.source === 'local' ? 'Local' : 'Cloud'}</span>
      <span>{context}</span>
      <span>{load}</span>
      {model.quantization && <span>{model.quantization}</span>}
      <span className={eligible ? 'is-verified' : 'is-unverified'}>{eligible ? 'Probe verified' : 'Probe required'}</span>
    </div>
  )
}

function ExecutorStep({
  catalog,
  loading,
  error,
  selectedId,
  probingId,
  onRefresh,
  onProbe,
  onSelect
}: {
  catalog: CatalogDiscoveryView | null
  loading: boolean
  error: string | null
  selectedId: string | null
  probingId: string | null
  onRefresh: () => void
  onProbe: (id: string) => void
  onSelect: (id: string) => void
}): JSX.Element {
  const models = catalog?.catalog.models ?? []
  return (
    <section className="aloop-setup-panel" aria-labelledby="aloop-executor-title">
      <div className="aloop-section-copy aloop-section-copy-row">
        <div>
          <p className="aloop-eyebrow">Step 2</p>
          <h2 id="aloop-executor-title">Choose a verified executor</h2>
          <p>Only available models with a fresh, successful code-execution probe can run a Loop.</p>
        </div>
        <button type="button" className="aloop-secondary-button" disabled={loading} onClick={onRefresh}>{loading ? 'Discovering…' : 'Discover models'}</button>
      </div>
      {error && <div className="aloop-callout is-error" role="alert">{error}</div>}
      {catalog?.warnings.map((warning) => <div className="aloop-callout is-warning" key={warning}>{warning}</div>)}
      {loading && models.length === 0 ? (
        <div className="aloop-loading" role="status"><span />Discovering model runtimes and remote nodes…</div>
      ) : models.length === 0 ? (
        <div className="aloop-model-empty">
          <h3>No models discovered</h3>
          <p>Start a supported local runtime, connect a remote node, or configure a provider, then discover again.</p>
        </div>
      ) : (
        <div className="aloop-model-list" role="radiogroup" aria-label="Loop executor">
          {models.map((model) => {
            const eligible = modelIsFreshAndEligible(model)
            const probing = probingId === model.id
            return (
              <div key={model.id} className={`aloop-model ${selectedId === model.id ? 'is-selected' : ''} ${eligible ? 'is-eligible' : ''}`}>
                <label>
                  <input type="radio" name="executor" checked={selectedId === model.id} disabled={!eligible || probing} onChange={() => onSelect(model.id)} />
                  <span className="aloop-model-copy">
                    <span className="aloop-model-title"><strong>{model.displayLabel}</strong><small>{model.modelName}</small></span>
                    <ModelBadges model={model} eligible={eligible} />
                    <span className="aloop-model-reason">{modelReason(model)}</span>
                  </span>
                </label>
                {!eligible && (
                  <button type="button" className="aloop-probe-button" disabled={probing || model.availability.status === 'unavailable'} onClick={() => onProbe(model.id)}>
                    {probing ? 'Running probe…' : 'Run capability probe'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function ReviewStep({ source, model }: { source: SourceState; model: CatalogModelView }): JSX.Element {
  const sourceLabel = source.kind === 'new' ? `${source.parentPath} / ${source.projectName}` : source.remoteUrl
  return (
    <section className="aloop-setup-panel" aria-labelledby="aloop-review-title">
      <div className="aloop-section-copy">
        <p className="aloop-eyebrow">Step 3</p>
        <h2 id="aloop-review-title">Review and start</h2>
        <p>Akorith will observe the repository, choose evidence-backed tasks, validate edits, review the diff, then commit and push only approved work.</p>
      </div>
      <dl className="aloop-review-list">
        <div><dt>Project source</dt><dd>{source.kind === 'new' ? 'New project' : 'Existing GitHub repository'}<small>{sourceLabel}</small></dd></div>
        <div><dt>Executor</dt><dd>{model.displayLabel}<small>{model.providerLabel} · {model.source === 'remote' ? model.nodeName ?? 'Remote node' : model.source}</small></dd></div>
        <div><dt>Capability evidence</dt><dd>Fresh code-execution probe<small>Valid until {formatTime(model.latestProbe?.freshUntil ?? null)}</small></dd></div>
        <div><dt>Automation boundary</dt><dd>One repository, one Loop<small>Secret scanning, validation, review vetoes, bounded retries, and non-force pushes remain enforced.</small></dd></div>
      </dl>
      <div className="aloop-callout is-info">There is no task prompt. The Loop derives the next highest-value task from repository evidence on every cycle.</div>
    </section>
  )
}

function LoopSetup({ onClose, onCreated }: { onClose: () => void; onCreated: (loop: AutonomousLoopRecord) => void }): JSX.Element {
  const [step, setStep] = useState<SetupStep>('source')
  const [source, setSource] = useState<SourceState>(EMPTY_SOURCE)
  const [catalog, setCatalog] = useState<CatalogDiscoveryView | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [probingId, setProbingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const pendingRequests = useRef(new Set<string>())
  const setupRef = useRef<HTMLDivElement>(null)

  const discover = useCallback(async (): Promise<void> => {
    const id = requestId('catalog')
    pendingRequests.current.add(id)
    setCatalogLoading(true)
    setCatalogError(null)
    try {
      const result = await window.api.autonomousLoop.catalog(id)
      if (result.ok) {
        setCatalog(result.value)
        setSelectedId((current) => result.value.catalog.models.some((model) => model.id === current && modelIsFreshAndEligible(model)) ? current : null)
      } else {
        setCatalogError(result.error)
      }
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : 'Model discovery failed.')
    } finally {
      pendingRequests.current.delete(id)
      setCatalogLoading(false)
    }
  }, [])

  useEffect(() => () => {
    for (const id of pendingRequests.current) void window.api.autonomousLoop.cancelRequest(id)
  }, [])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !creating) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [creating, onClose])

  useEffect(() => {
    if (step === 'executor' && catalog === null && !catalogLoading) void discover()
  }, [catalog, catalogLoading, discover, step])

  const probe = async (catalogModelId: string): Promise<void> => {
    const id = requestId('probe')
    pendingRequests.current.add(id)
    setProbingId(catalogModelId)
    setCatalogError(null)
    try {
      const result = await window.api.autonomousLoop.probe(id, catalogModelId)
      if (!result.ok) setCatalogError(result.error)
      else if (result.value.status !== 'succeeded') setCatalogError(result.value.failureMessage ?? `Capability probe ended with status ${result.value.status}.`)
      await discover()
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : 'Capability probe failed.')
    } finally {
      pendingRequests.current.delete(id)
      setProbingId(null)
    }
  }

  const selectedModel = catalog?.catalog.models.find((model) => model.id === selectedId && modelIsFreshAndEligible(model)) ?? null
  const sourceValid = source.kind === 'new'
    ? source.parentPath.trim().length > 0 && source.projectName.trim().length > 0 &&
      (source.remoteUrl.trim().length > 0 || (source.createRemoteWithPlugin && source.githubOwner.trim().length > 0))
    : source.remoteUrl.trim().length > 0

  const create = async (): Promise<void> => {
    if (!selectedModel) return
    const id = requestId('create')
    pendingRequests.current.add(id)
    setCreating(true)
    setCreateError(null)
    const sourceInput: CreateAutonomousLoopInput['source'] = source.kind === 'existing_github'
      ? { kind: 'existing_github', remoteUrl: source.remoteUrl.trim() }
      : {
          kind: 'new',
          parentPath: source.parentPath.trim(),
          projectName: source.projectName.trim(),
          remoteUrl: source.remoteUrl.trim() || undefined,
          createRemoteWithPlugin: source.createRemoteWithPlugin || undefined,
          githubOwner: source.createRemoteWithPlugin ? source.githubOwner.trim() : undefined,
          githubVisibility: source.createRemoteWithPlugin ? source.githubVisibility : undefined
        }
    try {
      const result = await window.api.autonomousLoop.create(id, { source: sourceInput, executor: modelSelection(selectedModel) })
      if (result.ok) onCreated(result.value.loop)
      else setCreateError(result.error)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Loop setup failed.')
    } finally {
      pendingRequests.current.delete(id)
      setCreating(false)
    }
  }

  const previous = (): void => setStep(step === 'review' ? 'executor' : 'source')
  const next = (): void => setStep(step === 'source' ? 'executor' : 'review')

  return (
    <div
      ref={setupRef}
      className="aloop-setup"
      role="dialog"
      aria-modal="true"
      aria-labelledby="aloop-setup-title"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const focusable = Array.from(setupRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }}
    >
      <header className="aloop-setup-header">
        <div><p className="aloop-eyebrow">Autonomous repository work</p><h1 id="aloop-setup-title">Create Loop</h1></div>
        <button type="button" className="aloop-icon-button" aria-label="Close Loop setup" onClick={onClose}>×</button>
      </header>
      <SetupProgress step={step} />
      <div className="aloop-setup-body">
        {step === 'source' && <SourceStep source={source} onChange={setSource} />}
        {step === 'executor' && <ExecutorStep catalog={catalog} loading={catalogLoading} error={catalogError} selectedId={selectedId} probingId={probingId} onRefresh={() => void discover()} onProbe={(id) => void probe(id)} onSelect={setSelectedId} />}
        {step === 'review' && selectedModel && <ReviewStep source={source} model={selectedModel} />}
        {createError && <div className="aloop-callout is-error" role="alert">{createError}</div>}
      </div>
      <footer className="aloop-setup-footer">
        <button type="button" className="aloop-secondary-button" onClick={step === 'source' ? onClose : previous}>{step === 'source' ? 'Cancel' : 'Back'}</button>
        {step !== 'review' ? (
          <button type="button" className="aloop-primary-button" disabled={step === 'source' ? !sourceValid : !selectedModel} onClick={next}>Continue</button>
        ) : (
          <button type="button" className="aloop-primary-button" disabled={creating || !selectedModel} onClick={() => void create()}>{creating ? 'Starting Loop…' : 'Start Loop'}</button>
        )}
      </footer>
    </div>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }): JSX.Element {
  return <div className="aloop-metric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>
}

function CycleSummary({ cycle }: { cycle: AutonomousLoopCycle }): JSX.Element {
  return (
    <article className="aloop-cycle">
      <header>
        <div><span>Cycle {cycle.index}</span><h3>{cycle.plannedTask?.title ?? cycle.summary ?? 'Repository observation'}</h3></div>
        <span className={`aloop-cycle-status is-${cycle.status}`}>{cycle.status.replaceAll('_', ' ')}</span>
      </header>
      {cycle.plannedTask && <p>{cycle.plannedTask.reason}</p>}
      {cycle.plannedTask?.acceptanceCriteria.length ? <ul>{cycle.plannedTask.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul> : null}
      {cycle.summary && <p className="aloop-cycle-summary">{cycle.summary}</p>}
      <footer>
        <span>{cycle.changedFiles.length} files</span>
        <span>{cycle.repairAttempts} repairs</span>
        <span>{cycle.durationMs === null ? 'In progress' : `${Math.round(cycle.durationMs / 1_000)}s`}</span>
        {cycle.commitSha && <code title={cycle.commitSha}>{cycle.commitSha.slice(0, 8)}</code>}
        {cycle.pushed && <span className="is-pushed">Pushed</span>}
      </footer>
      {cycle.error && <div className="aloop-inline-error">{cycle.error}</div>}
    </article>
  )
}

function Activity({ events }: { events: AutonomousLoopEvent[] }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const ordered = useMemo(() => [...events].sort((left, right) => left.occurredAt - right.occurredAt), [events])

  const jumpLatest = useCallback((): void => {
    const node = scrollRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
    setFollowing(true)
  }, [])

  useLayoutEffect(() => {
    if (following) jumpLatest()
  }, [following, jumpLatest, ordered.length])

  return (
    <section className="aloop-activity" aria-labelledby="aloop-activity-title">
      <div className="aloop-detail-section-head"><div><h2 id="aloop-activity-title">Activity</h2><p>Validated stage events from the persistent Loop engine.</p></div><span>{events.length} events</span></div>
      <div
        ref={scrollRef}
        className="aloop-activity-scroll"
        tabIndex={0}
        onScroll={(event) => {
          const node = event.currentTarget
          setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 32)
        }}
      >
        {ordered.length === 0 ? <div className="aloop-empty-inline">No activity has been recorded yet.</div> : ordered.map((event) => (
          <article className={`aloop-event is-${event.level}`} key={event.id}>
            <span className="aloop-event-marker" aria-hidden="true" />
            <div>
              <header><strong>{event.title}</strong><time dateTime={new Date(event.occurredAt).toISOString()}>{formatTime(event.occurredAt)}</time></header>
              <p>{event.summary}</p>
              <span>{STAGE_LABEL[event.stage]} · {event.kind.replaceAll('_', ' ')}</span>
            </div>
          </article>
        ))}
      </div>
      {!following && <button type="button" className="aloop-jump-latest" onClick={jumpLatest}>Jump to latest</button>}
    </section>
  )
}

function LoopDetailView({
  detail,
  loading,
  error,
  busy,
  onBack,
  onRetry,
  onPause,
  onResume,
  onStop,
  onOpenRepository,
  onOpenGitHub
}: {
  detail: AutonomousLoopDetail | null
  loading: boolean
  error: string | null
  busy: boolean
  onBack: () => void
  onRetry: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onOpenRepository: () => void
  onOpenGitHub: () => void
}): JSX.Element {
  if (loading && detail === null) return <div className="aloop-page-state" role="status"><span className="aloop-spinner" />Loading Loop details…</div>
  if (error && detail === null) return <div className="aloop-page-state is-error" role="alert"><h2>Loop details could not be loaded</h2><p>{error}</p><button type="button" onClick={onRetry}>Try again</button></div>
  if (!detail) return <div className="aloop-page-state"><h2>Loop not found</h2><button type="button" onClick={onBack}>Return to Loop list</button></div>
  const { loop } = detail
  const tokens = loop.tokenUsage.input + loop.tokenUsage.output + loop.tokenUsage.cached
  return (
    <div className="aloop-detail-page">
      <header className="aloop-detail-header">
        <div className="aloop-detail-heading">
          <button type="button" className="aloop-back-button" onClick={onBack}>← All Loops</button>
          <div className="aloop-title-row"><h1>{loop.projectName}</h1><LoopStatus loop={loop} /></div>
          <p>{loop.repositoryId} · <span>{STAGE_LABEL[loop.stage]}</span></p>
        </div>
        <div className="aloop-detail-actions">
          <button type="button" className="aloop-secondary-button" onClick={onOpenRepository}>Open repository</button>
          {loop.remoteUrl && <button type="button" className="aloop-secondary-button" onClick={onOpenGitHub}>Open GitHub</button>}
          {(loop.status === 'running' || loop.status === 'setting_up') && <button type="button" className="aloop-secondary-button" disabled={busy} onClick={onPause}>Pause</button>}
          {loop.status === 'paused' && <button type="button" className="aloop-primary-button" disabled={busy} onClick={onResume}>Resume</button>}
          {!['stopped', 'completed', 'error', 'stopping'].includes(loop.status) && <button type="button" className="aloop-danger-button" disabled={busy} onClick={onStop}>Stop</button>}
        </div>
      </header>
      {error && <div className="aloop-callout is-error" role="alert">{error}</div>}
      {loop.error && <div className="aloop-callout is-error" role="alert"><strong>Loop error</strong> {loop.error}</div>}
      <section className="aloop-metrics" aria-label="Loop metrics">
        <Metric label="Current phase" value={STAGE_LABEL[loop.stage]} detail={loop.status === 'running' ? `Next cycle ${formatRelativeTime(loop.nextCycleAt)}` : STATUS_LABEL[loop.status]} />
        <Metric label="Executor" value={loop.executor.model} detail={`${loop.executor.providerId} · ${loop.executor.location}`} />
        <Metric label="Tasks" value={`${loop.successfulTasks} completed`} detail={`${loop.failedTasks} failed`} />
        <Metric label="Git progress" value={`${loop.commitCount} commits`} detail={`${loop.pushCount} pushes`} />
        <Metric label="Token usage" value={formatCount(tokens)} detail={`$${loop.tokenUsage.costUsd.toFixed(4)} recorded`} />
        <Metric label="Last activity" value={formatRelativeTime(loop.lastActivityAt)} detail={formatTime(loop.lastActivityAt)} />
      </section>
      <div className="aloop-detail-grid">
        <Activity events={detail.events} />
        <section className="aloop-cycles" aria-labelledby="aloop-cycles-title">
          <div className="aloop-detail-section-head"><div><h2 id="aloop-cycles-title">Cycles</h2><p>Planned work, validation evidence, repairs, and Git outcomes.</p></div><span>{detail.cycles.length} cycles</span></div>
          <div className="aloop-cycle-list">
            {detail.cycles.length === 0 ? <div className="aloop-empty-inline">The first cycle has not started yet.</div> : detail.cycles.map((cycle) => <CycleSummary key={cycle.id} cycle={cycle} />)}
          </div>
        </section>
      </div>
    </div>
  )
}

export default function AutonomousLoopPage({ active }: { active: boolean }): JSX.Element {
  const [loops, setLoops] = useState<AutonomousLoopRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AutonomousLoopDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  const loadList = useCallback(async (): Promise<void> => {
    setLoading(true)
    setListError(null)
    try {
      setLoops(await window.api.autonomousLoop.list())
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'Loops could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    setDetailLoading(true)
    setDetailError(null)
    try {
      const value = await window.api.autonomousLoop.detail(id)
      setDetail(value)
      if (value === null) setDetailError('This Loop no longer exists.')
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : 'Loop details could not be loaded.')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void loadList()
    const unsubscribe = window.api.autonomousLoop.onChanged((changedId) => {
      void loadList()
      if (selectedId === changedId) void loadDetail(changedId)
    })
    return unsubscribe
  }, [active, loadDetail, loadList, selectedId])

  useEffect(() => {
    if (active && selectedId) void loadDetail(selectedId)
  }, [active, loadDetail, selectedId])

  const runAction = async (kind: 'pause' | 'resume' | 'stop', loop: AutonomousLoopRecord): Promise<void> => {
    setBusyId(loop.id)
    setActionMessage(null)
    try {
      const result = await window.api.autonomousLoop[kind](loop.id)
      if (!result.ok) setActionMessage(result.error)
      else {
        setLoops((current) => current.map((item) => item.id === result.value.id ? result.value : item))
        if (selectedId === loop.id) await loadDetail(loop.id)
      }
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : `Could not ${kind} Loop.`)
    } finally {
      setBusyId(null)
    }
  }

  const openLocation = async (kind: 'openRepository' | 'openGitHub', loopId: string): Promise<void> => {
    setDetailError(null)
    try {
      const result = await window.api.autonomousLoop[kind](loopId)
      if (!result.ok) setDetailError(result.error ?? `Akorith could not ${kind === 'openGitHub' ? 'open GitHub' : 'open the repository'}.`)
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : 'The location could not be opened.')
    }
  }

  const grouped = useMemo(() => ({
    active: loops.filter((loop) => groupFor(loop) === 'active'),
    paused: loops.filter((loop) => groupFor(loop) === 'paused'),
    recent: loops.filter((loop) => groupFor(loop) === 'recent')
  }), [loops])

  const collectionAction = (kind: 'open' | 'pause' | 'resume' | 'stop', loop: AutonomousLoopRecord): void => {
    if (kind === 'open') {
      setDetail(null)
      setSelectedId(loop.id)
    } else void runAction(kind, loop)
  }

  if (!active) return <div className="aloop-page" hidden />
  if (setupOpen) return <div className="aloop-page"><LoopSetup onClose={() => setSetupOpen(false)} onCreated={(loop) => { setSetupOpen(false); setSelectedId(loop.id); void loadList() }} /></div>
  if (selectedId) return (
    <div className="aloop-page">
      <LoopDetailView
        detail={detail}
        loading={detailLoading}
        error={detailError}
        busy={busyId === selectedId}
        onBack={() => { setSelectedId(null); setDetail(null); setDetailError(null) }}
        onRetry={() => void loadDetail(selectedId)}
        onPause={() => { const loop = detail?.loop; if (loop) void runAction('pause', loop) }}
        onResume={() => { const loop = detail?.loop; if (loop) void runAction('resume', loop) }}
        onStop={() => { const loop = detail?.loop; if (loop) void runAction('stop', loop) }}
        onOpenRepository={() => void openLocation('openRepository', selectedId)}
        onOpenGitHub={() => void openLocation('openGitHub', selectedId)}
      />
    </div>
  )

  return (
    <div className="aloop-page">
      <header className="aloop-page-header">
        <div><p className="aloop-eyebrow">Repository automation</p><h1>Loop</h1><p>Autonomous, evidence-driven project work with validated model capabilities and guarded Git delivery.</p></div>
        <button type="button" className="aloop-primary-button" onClick={() => setSetupOpen(true)}>Create Loop</button>
      </header>
      <main className="aloop-landing">
        {actionMessage && <div className="aloop-callout is-error" role="alert">{actionMessage}</div>}
        {loading && loops.length === 0 ? (
          <div className="aloop-page-state" role="status"><span className="aloop-spinner" />Loading Loops…</div>
        ) : listError && loops.length === 0 ? (
          <div className="aloop-page-state is-error" role="alert"><h2>Loops could not be loaded</h2><p>{listError}</p><button type="button" onClick={() => void loadList()}>Try again</button></div>
        ) : loops.length === 0 ? (
          <div className="aloop-empty-state">
            <span className="aloop-empty-mark" aria-hidden="true">↻</span>
            <h2>Let a project keep moving</h2>
            <p>Create a Loop, choose a repository and a probe-verified executor, then Akorith will plan and deliver bounded improvements cycle by cycle.</p>
            <button type="button" className="aloop-primary-button" onClick={() => setSetupOpen(true)}>Create your first Loop</button>
          </div>
        ) : (
          <>
            {listError && <div className="aloop-callout is-warning">Showing the last loaded data. Refresh failed: {listError}</div>}
            <LoopCollection title="Active" description="Running now or changing state" loops={grouped.active} busyId={busyId} action={collectionAction} />
            <LoopCollection title="Paused" description="Ready to resume with the same repository context" loops={grouped.paused} busyId={busyId} action={collectionAction} />
            <LoopCollection title="Recent" description="Completed, stopped, and attention-needed Loops" loops={grouped.recent} busyId={busyId} action={collectionAction} />
          </>
        )}
      </main>
    </div>
  )
}

export { modelIsFreshAndEligible }
