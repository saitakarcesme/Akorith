import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import './telemetry-dashboard.css'

export type DashboardHeatmapMode = 'daily' | 'weekly' | 'cumulative'
export type DashboardExecutionLocation = 'local' | 'remote' | 'cloud'

export interface DashboardSummaryMetrics {
  lifetimeTokens: number
  peakDailyTokens: number
  longestTaskDurationMs: number | null
  currentStreakDays: number
  longestStreakDays: number
  recordedSince: number | null
}

export interface DashboardActivityInsights {
  fastModeUsagePercent: number | null
  mostUsedReasoningMode: string | null
  skillsExplored: number
  totalSkillInvocations: number
  totalTasks: number
  successfulTasks: number
  failedTasks: number
  averageTaskDurationMs: number | null
}

export interface DashboardModelInsight {
  providerId: string | null
  model: string
  location: DashboardExecutionLocation | null
  nodeLabel?: string | null
  runs: number
  successfulRuns: number
  failedRuns: number
  totalTokens: number
  totalDurationMs: number
}

export interface DashboardPluginInsight {
  pluginId: string
  label: string
  icon?: string | null
  runs: number
  successfulRuns: number
  failedRuns: number
}

export interface DashboardTaskInsight {
  taskType: string
  runs: number
  successfulRuns: number
  failedRuns: number
  totalTokens: number
  totalDurationMs: number
}

export interface DashboardOverview {
  summary: DashboardSummaryMetrics
  activity: DashboardActivityInsights
  models: DashboardModelInsight[]
  plugins: DashboardPluginInsight[]
  tasks: DashboardTaskInsight[]
}

export interface DashboardHeatmapCell {
  key: string
  label: string
  startDay: string
  endDay: string
  tokens: number
  tasks: number
  primaryModel: string | null
  intensity: 0 | 1 | 2 | 3 | 4
}

export interface DashboardHeatmapView {
  mode: DashboardHeatmapMode
  startDay: string
  endDay: string
  cells: DashboardHeatmapCell[]
}

export type DashboardGpuStatus = 'observed' | 'unsupported' | 'disconnected' | 'unavailable'

export interface DashboardGpuDevice {
  id: string
  nodeId: string
  nodeLabel: string
  location: 'local' | 'remote'
  name: string
  utilizationPercent?: number
  memoryUsedMb?: number
  memoryTotalMb?: number
  temperatureC?: number
  powerWatts?: number
  activeModel?: string
  processName?: string
}

export interface DashboardGpuSnapshot {
  status: DashboardGpuStatus
  observedAt: number
  reason?: string
  devices: DashboardGpuDevice[]
  warnings: string[]
}

/** Renderer-only contract. Main-process aggregation and validation stay behind preload. */
export interface DashboardTelemetryApi {
  loadOverview(): Promise<DashboardOverview>
  loadHeatmap(mode: DashboardHeatmapMode): Promise<DashboardHeatmapView>
  loadGpuSnapshot(): Promise<DashboardGpuSnapshot>
}

interface TelemetryDashboardPageProps {
  api?: DashboardTelemetryApi | null
  gpuPollIntervalMs?: number
}

const METRIC_DEFINITIONS = {
  lifetime: 'Total recorded input and output tokens since telemetry was enabled.',
  peak: 'Highest recorded input and output token usage in a single local-calendar day.',
  longestTask: 'Longest completed model task duration recorded by Akorith.',
  currentStreak: 'Consecutive days ending today with at least one completed model task.',
  longestStreak: 'Longest historical run of consecutive days with a completed model task.'
} as const

const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const fullNumber = new Intl.NumberFormat()
const dateLabel = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' })

function safeError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'Dashboard telemetry could not be loaded.'
}

function parseDay(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const parsed = new Date(`${day}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function formatTokens(value: number): string {
  return compactNumber.format(Math.max(0, value))
}

function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable'
  const seconds = Math.max(0, Math.round(value / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function formatRecordedSince(value: number | null): string {
  if (value === null) return 'Recorded since telemetry was enabled'
  return `Recorded since ${dateLabel.format(new Date(value))}`
}

function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'Unavailable' : `${Math.max(0, Math.min(100, value)).toFixed(0)}%`
}

function formatMegabytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'Unavailable'
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`
  return `${Math.round(value)} MB`
}

function resolveDefaultApi(): DashboardTelemetryApi | null {
  const bridge = (window as unknown as { api?: { dashboardTelemetry?: Partial<DashboardTelemetryApi> } }).api?.dashboardTelemetry
  if (
    typeof bridge?.loadOverview !== 'function' ||
    typeof bridge.loadHeatmap !== 'function' ||
    typeof bridge.loadGpuSnapshot !== 'function'
  ) return null
  return bridge as DashboardTelemetryApi
}

function Metric({ label, value, definition }: { label: string; value: string; definition: string }): JSX.Element {
  return (
    <div className="td-metric">
      <strong>{value}</strong>
      <abbr title={definition}>{label}</abbr>
    </div>
  )
}

function heatmapDescription(cell: DashboardHeatmapCell): string {
  const range = cell.startDay === cell.endDay ? cell.startDay : `${cell.startDay} to ${cell.endDay}`
  const model = cell.primaryModel ? ` Primary model: ${cell.primaryModel}.` : ''
  return `${range}: ${fullNumber.format(cell.tokens)} tokens, ${fullNumber.format(cell.tasks)} tasks.${model}`
}

function DailyHeatmap({ view }: { view: DashboardHeatmapView }): JSX.Element {
  const first = parseDay(view.cells[0]?.startDay ?? view.startDay)
  const leadingDays = first?.getUTCDay() ?? 0
  const columns = Math.max(1, Math.ceil((leadingDays + view.cells.length) / 7))
  const months = new Map<number, string>()

  view.cells.forEach((cell, index) => {
    const date = parseDay(cell.startDay)
    if (!date) return
    const column = Math.floor((leadingDays + index) / 7) + 1
    if (index === 0 || date.getUTCDate() <= 7) months.set(column, monthLabel.format(date))
  })

  return (
    <div className="td-heatmap-canvas" style={{ '--td-weeks': columns } as CSSProperties}>
      <div className="td-months" aria-hidden="true">
        {[...months].map(([column, label]) => <span key={`${column}-${label}`} style={{ gridColumn: column }}>{label}</span>)}
      </div>
      <div className="td-daily-grid" role="group" aria-label={`Daily token activity from ${view.startDay} to ${view.endDay}`}>
        {view.cells.map((cell, index) => {
          const position = leadingDays + index
          return (
            <button
              key={cell.key}
              type="button"
              className={`td-heatmap-cell is-level-${cell.intensity}`}
              style={{ gridColumn: Math.floor(position / 7) + 1, gridRow: (position % 7) + 1 }}
              aria-label={heatmapDescription(cell)}
              title={heatmapDescription(cell)}
            />
          )
        })}
      </div>
    </div>
  )
}

function LinearHeatmap({ view }: { view: DashboardHeatmapView }): JSX.Element {
  const minimum = view.mode === 'weekly' ? 13 : 30
  return (
    <div
      className={`td-linear-grid is-${view.mode}`}
      style={{ gridTemplateColumns: `repeat(${Math.max(1, view.cells.length)}, minmax(${minimum}px, 1fr))` }}
      role="group"
      aria-label={`${view.mode} token activity from ${view.startDay} to ${view.endDay}`}
    >
      {view.cells.map((cell) => (
        <button
          key={cell.key}
          type="button"
          className={`td-heatmap-cell is-level-${cell.intensity}`}
          aria-label={heatmapDescription(cell)}
          title={heatmapDescription(cell)}
        >
          {view.mode === 'cumulative' ? <span>{cell.label}</span> : null}
        </button>
      ))}
    </div>
  )
}

function Heatmap({ view }: { view: DashboardHeatmapView }): JSX.Element {
  if (view.cells.length === 0) return <div className="td-inline-empty">No token activity has been recorded for this range.</div>
  return view.mode === 'daily' ? <DailyHeatmap view={view} /> : <LinearHeatmap view={view} />
}

function InsightRow({ label, value }: { label: string; value: string }): JSX.Element {
  return <div className="td-insight-row"><span>{label}</span><strong>{value}</strong></div>
}

function ModelInsights({ models }: { models: DashboardModelInsight[] }): JSX.Element {
  const used = models.filter((model) => model.runs > 0 || model.totalTokens > 0).slice(0, 7)
  const maxRuns = Math.max(1, ...used.map((model) => model.runs))
  const totalTokens = used.reduce((sum, model) => sum + model.totalTokens, 0)
  const topLocal = used.find((model) => model.location === 'local')
  const topCloud = used.find((model) => model.location === 'cloud')
  const topSuccessful = [...used].sort((a, b) => b.successfulRuns - a.successfulRuns)[0]

  if (!used.length) return <div className="td-inline-empty">Model usage will appear after a recorded model task.</div>
  return (
    <>
      <div className="td-model-highlights" aria-label="Model usage highlights">
        <span>Top local <strong>{topLocal?.model ?? 'None recorded'}</strong></span>
        <span>Top cloud <strong>{topCloud?.model ?? 'None recorded'}</strong></span>
        <span>Most successes <strong>{topSuccessful?.model ?? 'None recorded'}</strong></span>
      </div>
      <div className="td-token-distribution" aria-label="Model token distribution">
        {used.filter((model) => model.totalTokens > 0).map((model, index) => (
          <span
            key={`${model.providerId ?? 'unknown'}-${model.model}`}
            className={`is-tone-${index % 5}`}
            style={{ flexGrow: model.totalTokens }}
            title={`${model.model}: ${fullNumber.format(model.totalTokens)} tokens`}
          />
        ))}
        {totalTokens === 0 ? <i>Tokens unavailable</i> : null}
      </div>
      <ol className="td-ranked-list">
        {used.map((model, index) => (
          <li key={`${model.providerId ?? 'unknown'}-${model.model}-${model.nodeLabel ?? ''}`}>
            <div className="td-rank-copy">
              <span className="td-rank">{index + 1}</span>
              <span className="td-model-name"><strong>{model.model}</strong><small>{model.location ?? 'unknown'}{model.nodeLabel ? ` · ${model.nodeLabel}` : ''}</small></span>
              <span className="td-model-stats"><strong>{fullNumber.format(model.runs)} runs</strong><small>{formatTokens(model.totalTokens)} tokens · {formatDuration(model.totalDurationMs)}</small></span>
            </div>
            <span className="td-proportion"><i style={{ width: `${Math.max(3, (model.runs / maxRuns) * 100)}%` }} /></span>
          </li>
        ))}
      </ol>
    </>
  )
}

function PluginInsights({ plugins }: { plugins: DashboardPluginInsight[] }): JSX.Element {
  const used = plugins.filter((plugin) => plugin.runs > 0).slice(0, 7)
  if (!used.length) return <div className="td-inline-empty">Plugin invocations will appear here after first use.</div>
  const maxRuns = Math.max(...used.map((plugin) => plugin.runs), 1)
  return (
    <ol className="td-plugin-list">
      {used.map((plugin) => (
        <li key={plugin.pluginId}>
          <span className="td-plugin-icon" aria-hidden="true">{plugin.icon?.trim() || '◇'}</span>
          <strong>{plugin.label}</strong>
          <span className="td-plugin-bar"><i style={{ width: `${Math.max(4, (plugin.runs / maxRuns) * 100)}%` }} /></span>
          <span>{fullNumber.format(plugin.runs)} runs</span>
        </li>
      ))}
    </ol>
  )
}

function GpuMeter({ label, value, detail }: { label: string; value?: number; detail: string }): JSX.Element {
  const measured = value !== undefined && Number.isFinite(value)
  const safeValue = measured ? Math.max(0, Math.min(100, value)) : 0
  return (
    <div className="td-gpu-meter">
      <div><span>{label}</span><strong>{detail}</strong></div>
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={measured ? safeValue : undefined} aria-valuetext={measured ? detail : 'Unavailable'}>
        <span style={{ width: `${safeValue}%` }} />
      </div>
    </div>
  )
}

function GpuPanel({ snapshot, loading, onRefresh }: { snapshot: DashboardGpuSnapshot | null; loading: boolean; onRefresh(): void }): JSX.Element {
  const status = snapshot?.status ?? 'unavailable'
  return (
    <section className="td-section td-gpu-section" aria-labelledby="td-gpu-title" aria-busy={loading}>
      <header className="td-section-heading">
        <div><h2 id="td-gpu-title">GPU telemetry</h2><span className={`td-status is-${status}`}>{status}</span></div>
        <button type="button" className="td-refresh" onClick={onRefresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </header>
      {!snapshot || snapshot.status !== 'observed' || snapshot.devices.length === 0 ? (
        <div className="td-gpu-unavailable">
          <strong>GPU data unavailable</strong>
          <span>{snapshot?.reason ?? 'No supported GPU observation is available.'}</span>
        </div>
      ) : (
        <div className="td-gpu-devices">
          {snapshot.devices.map((device) => {
            const memoryPercent = device.memoryUsedMb !== undefined && device.memoryTotalMb
              ? (device.memoryUsedMb / device.memoryTotalMb) * 100
              : undefined
            return (
              <article key={`${device.nodeId}-${device.id}`} aria-label={device.name}>
                <header><div><strong>{device.name}</strong><small>{device.location} · {device.nodeLabel}</small></div><time dateTime={new Date(snapshot.observedAt).toISOString()}>{dateLabel.format(new Date(snapshot.observedAt))}</time></header>
                <GpuMeter label="GPU utilization" value={device.utilizationPercent} detail={device.utilizationPercent === undefined ? 'Unavailable' : `${device.utilizationPercent.toFixed(0)}%`} />
                <GpuMeter label="VRAM usage" value={memoryPercent} detail={device.memoryUsedMb === undefined || device.memoryTotalMb === undefined ? 'Unavailable' : `${formatMegabytes(device.memoryUsedMb)} / ${formatMegabytes(device.memoryTotalMb)}`} />
                <dl>
                  <div><dt>Temperature</dt><dd>{device.temperatureC === undefined ? 'Unavailable' : `${device.temperatureC.toFixed(0)} °C`}</dd></div>
                  <div><dt>Power</dt><dd>{device.powerWatts === undefined ? 'Unavailable' : `${device.powerWatts.toFixed(0)} W`}</dd></div>
                  <div><dt>Current model</dt><dd>{device.activeModel ?? 'Unavailable'}</dd></div>
                  <div><dt>Local process</dt><dd>{device.processName ?? 'Unavailable'}</dd></div>
                </dl>
              </article>
            )
          })}
        </div>
      )}
      {snapshot?.warnings.length ? <ul className="td-warnings">{snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
    </section>
  )
}

export default function TelemetryDashboardPage({ api, gpuPollIntervalMs = 5_000 }: TelemetryDashboardPageProps): JSX.Element {
  const service = useMemo(() => api === undefined ? resolveDefaultApi() : api, [api])
  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [heatmapMode, setHeatmapMode] = useState<DashboardHeatmapMode>('daily')
  const [heatmap, setHeatmap] = useState<DashboardHeatmapView | null>(null)
  const [gpu, setGpu] = useState<DashboardGpuSnapshot | null>(null)
  const [loading, setLoading] = useState(Boolean(service))
  const [heatmapLoading, setHeatmapLoading] = useState(Boolean(service))
  const [gpuLoading, setGpuLoading] = useState(Boolean(service))
  const [error, setError] = useState<string | null>(null)

  const loadOverview = useCallback(async (): Promise<void> => {
    if (!service) return
    setLoading(true)
    setError(null)
    try { setOverview(await service.loadOverview()) }
    catch (loadError) { setError(safeError(loadError)) }
    finally { setLoading(false) }
  }, [service])

  const loadGpu = useCallback(async (): Promise<void> => {
    if (!service) return
    setGpuLoading(true)
    try { setGpu(await service.loadGpuSnapshot()) }
    catch (loadError) {
      setGpu({ status: 'unavailable', observedAt: Date.now(), reason: safeError(loadError), devices: [], warnings: [] })
    } finally { setGpuLoading(false) }
  }, [service])

  useEffect(() => { void loadOverview() }, [loadOverview])
  useEffect(() => {
    if (!service) return
    let disposed = false
    setHeatmapLoading(true)
    service.loadHeatmap(heatmapMode)
      .then((view) => { if (!disposed) setHeatmap(view) })
      .catch((loadError) => { if (!disposed) setError(safeError(loadError)) })
      .finally(() => { if (!disposed) setHeatmapLoading(false) })
    return () => { disposed = true }
  }, [heatmapMode, service])

  useEffect(() => {
    if (!service) return
    void loadGpu()
    if (gpuPollIntervalMs <= 0) return
    const handle = window.setInterval(() => { void loadGpu() }, Math.max(2_000, gpuPollIntervalMs))
    return () => window.clearInterval(handle)
  }, [gpuPollIntervalMs, loadGpu, service])

  if (!service) {
    return (
      <main className="telemetry-dashboard td-state">
        <span className="td-kicker">Telemetry</span>
        <h1>Dashboard</h1>
        <p>The dashboard telemetry service is not available in this application build.</p>
        <small>No sample metrics are shown.</small>
      </main>
    )
  }

  if (loading && !overview) {
    return <main className="telemetry-dashboard td-state" aria-busy="true"><span className="td-spinner" /><h1>Dashboard</h1><p>Loading recorded activity…</p></main>
  }

  if (!overview) {
    return (
      <main className="telemetry-dashboard td-state" role="alert">
        <span className="td-kicker">Telemetry</span><h1>Dashboard unavailable</h1><p>{error ?? 'Recorded activity could not be loaded.'}</p>
        <button type="button" className="td-refresh" onClick={() => void loadOverview()}>Try again</button>
      </main>
    )
  }

  const { summary, activity, models, plugins, tasks } = overview
  const hasActivity = summary.lifetimeTokens > 0 || activity.totalTasks > 0 || models.some((model) => model.runs > 0) || plugins.some((plugin) => plugin.runs > 0)
  const usedTasks = tasks.filter((task) => task.runs > 0).slice(0, 5)

  return (
    <main className="telemetry-dashboard">
      <header className="td-page-heading">
        <div><span className="td-kicker">Telemetry overview</span><h1>Dashboard</h1><p>{formatRecordedSince(summary.recordedSince)}</p></div>
        <button type="button" className="td-refresh" onClick={() => void loadOverview()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh data'}</button>
      </header>

      {error ? <div className="td-alert" role="alert">{error}</div> : null}
      {!hasActivity ? <div className="td-empty-banner"><strong>No recorded activity yet</strong><span>Metrics will populate after Akorith completes model tasks, invokes plugins, or records token usage.</span></div> : null}

      <section className="td-metrics-strip" aria-label="Telemetry summary">
        <Metric label="Lifetime tokens" value={formatTokens(summary.lifetimeTokens)} definition={METRIC_DEFINITIONS.lifetime} />
        <Metric label="Peak tokens" value={formatTokens(summary.peakDailyTokens)} definition={METRIC_DEFINITIONS.peak} />
        <Metric label="Longest task" value={formatDuration(summary.longestTaskDurationMs)} definition={METRIC_DEFINITIONS.longestTask} />
        <Metric label="Current streak" value={`${summary.currentStreakDays} days`} definition={METRIC_DEFINITIONS.currentStreak} />
        <Metric label="Longest streak" value={`${summary.longestStreakDays} days`} definition={METRIC_DEFINITIONS.longestStreak} />
      </section>

      <section className="td-activity-section" aria-labelledby="td-activity-title">
        <header className="td-section-heading">
          <h2 id="td-activity-title">Token activity</h2>
          <div className="td-mode-tabs" role="tablist" aria-label="Token activity grouping">
            {(['daily', 'weekly', 'cumulative'] as const).map((mode) => (
              <button key={mode} type="button" role="tab" aria-selected={heatmapMode === mode} onClick={() => setHeatmapMode(mode)}>{mode[0].toUpperCase() + mode.slice(1)}</button>
            ))}
          </div>
        </header>
        <div className="td-heatmap-scroll" aria-busy={heatmapLoading}>
          {heatmapLoading && (!heatmap || heatmap.mode !== heatmapMode) ? <div className="td-heatmap-loading">Loading activity…</div> : heatmap ? <Heatmap view={heatmap} /> : <div className="td-inline-empty">Token activity is unavailable.</div>}
        </div>
        <div className="td-heatmap-legend" aria-label="Token activity intensity"><span>Less</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`is-level-${level}`} />)}<span>More</span></div>
      </section>

      <div className="td-insights-grid">
        <section className="td-section" aria-labelledby="td-insights-title">
          <header className="td-section-heading"><h2 id="td-insights-title">Activity insights</h2></header>
          <div className="td-insight-rows">
            <InsightRow label="Fast Mode" value={formatPercent(activity.fastModeUsagePercent)} />
            <InsightRow label="Most used reasoning" value={activity.mostUsedReasoningMode?.replace(/_/g, ' ') ?? 'Unavailable'} />
            <InsightRow label="Skills explored" value={fullNumber.format(activity.skillsExplored)} />
            <InsightRow label="Total skill invocations" value={fullNumber.format(activity.totalSkillInvocations)} />
            <InsightRow label="Total tasks" value={fullNumber.format(activity.totalTasks)} />
            <InsightRow label="Successful tasks" value={fullNumber.format(activity.successfulTasks)} />
            <InsightRow label="Failed tasks" value={fullNumber.format(activity.failedTasks)} />
            <InsightRow label="Average task duration" value={formatDuration(activity.averageTaskDurationMs)} />
          </div>
          {usedTasks.length ? <div className="td-task-mix" aria-label="Task type activity">{usedTasks.map((task) => <span key={task.taskType}><strong>{task.taskType.replace(/_/g, ' ')}</strong><small>{task.runs} runs · {formatTokens(task.totalTokens)} tokens</small></span>)}</div> : null}
        </section>

        <section className="td-section" aria-labelledby="td-models-title">
          <header className="td-section-heading"><h2 id="td-models-title">Most used models</h2></header>
          <ModelInsights models={models} />
        </section>

        <section className="td-section" aria-labelledby="td-plugins-title">
          <header className="td-section-heading"><h2 id="td-plugins-title">Most used plugins</h2></header>
          <PluginInsights plugins={plugins} />
        </section>

        <GpuPanel snapshot={gpu} loading={gpuLoading} onRefresh={() => void loadGpu()} />
      </div>
    </main>
  )
}
