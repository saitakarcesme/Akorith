import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentAdapterInfo,
  AgentRuntimeSnapshot,
  ControllerStatus,
  DailyUsageRow,
  EvaluationRow,
  MacroSessionRow,
  PluginInfo,
  TelemetryStatus,
  Mission,
  MissionTemplate,
  ProjectRow,
  RuntimeStatus,
  SessionRow,
  TestRunRow,
  UpdateStatus,
  UsageLimitView,
  UsageSummary
} from '../../../preload/index.d'

// Reads existing local data only. No polling, no provider sends, no PTY control.

const HEATMAP_DAYS = 270
const BAR_DAYS = 30

interface DashboardProps {
  activeProject: ProjectRow | null
}

function providerColor(id: string): string {
  const n = id.toLowerCase()
  if (n.includes('claude')) return '#f1f1f1'
  if (n.includes('chatgpt') || n.includes('codex') || n.includes('openai') || n.includes('gpt')) return '#b9b9bd'
  if (n.includes('local') || n.includes('ollama')) return '#d8d8dc'
  return '#88888f'
}

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)

const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const chartTicks = (max: number): number[] => {
  if (max <= 0) return [0]
  return [max, max * 0.66, max * 0.33, 0]
}

const polar = (cx: number, cy: number, radius: number, angle: number): { x: number; y: number } => {
  const radians = ((angle - 90) * Math.PI) / 180
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) }
}

const donutSlicePath = (
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number
): string => {
  const largeArc = endAngle - startAngle > 180 ? 1 : 0
  const outerStart = polar(cx, cy, outerRadius, startAngle)
  const outerEnd = polar(cx, cy, outerRadius, endAngle)
  const innerStart = polar(cx, cy, innerRadius, endAngle)
  const innerEnd = polar(cx, cy, innerRadius, startAngle)
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerStart.x} ${innerStart.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerEnd.x} ${innerEnd.y}`,
    'Z'
  ].join(' ')
}

function statusLabel(value?: string | null): string {
  return value ? value.replace(/_/g, ' ') : 'none'
}

function relativeTime(ts?: number | null): string {
  if (!ts) return 'no activity'
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function resultText(run?: TestRunRow): string {
  if (!run) return 'No test runs yet'
  if (run.passed !== null || run.failed !== null || run.errored !== null) {
    return `${run.passed ?? 0} passed / ${run.failed ?? 0} failed / ${run.errored ?? 0} errored`
  }
  return statusLabel(run.status)
}

function loopIsActive(loop: MacroSessionRow): boolean {
  return !['completed', 'failed', 'stopped', 'archived', 'error'].includes(loop.status)
}

export default function Dashboard({ activeProject }: DashboardProps): JSX.Element {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [daily, setDaily] = useState<DailyUsageRow[]>([])
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<AgentRuntimeSnapshot | null>(null)
  const [agentAdapters, setAgentAdapters] = useState<AgentAdapterInfo[]>([])
  const [testRuns, setTestRuns] = useState<TestRunRow[]>([])
  const [evaluations, setEvaluations] = useState<EvaluationRow[]>([])
  const [loops, setLoops] = useState<MacroSessionRow[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [missionTemplates, setMissionTemplates] = useState<MissionTemplate[]>([])
  const [draftMissions, setDraftMissions] = useState<Mission[]>([])
  const [telemetry, setTelemetry] = useState<TelemetryStatus | null>(null)
  const [hasRemoteProfiles, setHasRemoteProfiles] = useState(false)
  const [gpuBusy, setGpuBusy] = useState(false)
  const [controller, setController] = useState<ControllerStatus | null>(null)
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [usageLimits, setUsageLimits] = useState<UsageLimitView | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Phase 42 (Remote Ollama): active local-model runtime source + presentation readiness.
  const loadRuntime = useCallback(async (): Promise<void> => {
    setRuntimeBusy(true)
    try {
      setRuntime(await window.api.ollama.runtimeStatus())
    } catch {
      setRuntime(null)
    } finally {
      setRuntimeBusy(false)
    }
  }, [])
  useEffect(() => {
    void loadRuntime()
  }, [loadRuntime])

  // Phase 35: read-only controller status + plugin registry for the Dashboard.
  // Phase 39: usage-limit view + source-update status.
  useEffect(() => {
    void window.api.controller.getStatus().then(setController).catch(() => setController(null))
    void window.api.plugins.list().then(setPlugins).catch(() => setPlugins(null))
    void window.api.usageLimits.get().then(setUsageLimits).catch(() => setUsageLimits(null))
    void window.api.update.status().then(setUpdate).catch(() => setUpdate(null))
  }, [])

  // Phase 36.8: source-aware GPU telemetry — prefers a healthy remote controller
  // (the PC running Ollama), else honest local. Load + manual refresh; no polling.
  const loadGpu = useCallback(async (): Promise<void> => {
    setGpuBusy(true)
    try {
      setTelemetry(await window.api.telemetry.getStatus())
    } catch {
      setTelemetry(null)
    } finally {
      setGpuBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadGpu()
    void window.api.telemetry
      .getProfiles()
      .then((profiles) => setHasRemoteProfiles(profiles.length > 0))
      .catch(() => setHasRemoteProfiles(false))
  }, [loadGpu])

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      const [
        summaryResult,
        dailyResult,
        runtimeResult,
        agentsResult,
        testsResult,
        evaluationsResult,
        loopsResult,
        sessionsResult,
        missionTemplatesResult,
        missionsResult
      ] = await Promise.allSettled([
        window.api.usage.summary(),
        window.api.usage.daily(HEATMAP_DAYS),
        window.api.agent.getRuntimeSnapshot(),
        window.api.agent.list(),
        window.api.test.listRuns(5),
        window.api.evaluate.list(3),
        window.api.macro.list(5),
        window.api.history.list(),
        window.api.mission.listTemplates(),
        window.api.mission.list()
      ])

      if (cancelled) return
      if (summaryResult.status === 'fulfilled') setSummary(summaryResult.value)
      if (dailyResult.status === 'fulfilled') setDaily(dailyResult.value)
      if (runtimeResult.status === 'fulfilled') setRuntimeSnapshot(runtimeResult.value)
      if (agentsResult.status === 'fulfilled') setAgentAdapters(agentsResult.value)
      if (testsResult.status === 'fulfilled') setTestRuns(testsResult.value)
      if (evaluationsResult.status === 'fulfilled') setEvaluations(evaluationsResult.value)
      if (loopsResult.status === 'fulfilled') setLoops(loopsResult.value)
      if (sessionsResult.status === 'fulfilled') setSessions(sessionsResult.value)
      if (missionTemplatesResult.status === 'fulfilled') setMissionTemplates(missionTemplatesResult.value)
      if (missionsResult.status === 'fulfilled') setDraftMissions(missionsResult.value)

      const failures = [
        summaryResult,
        dailyResult,
        runtimeResult,
        agentsResult,
        testsResult,
        evaluationsResult,
        loopsResult,
        sessionsResult,
        missionTemplatesResult,
        missionsResult
      ].filter((result): result is PromiseRejectedResult => result.status === 'rejected')

      setError(failures.length ? `Some dashboard data could not load: ${failures[0].reason}` : null)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const providerIds = useMemo(() => summary?.byProvider.map((p) => p.providerId) ?? [], [summary])
  const colorOf = (id: string): string => providerColor(id)
  const isEstimated = (id: string): boolean => summary?.byProvider.find((p) => p.providerId === id)?.estimated ?? false
  const fillOf = (id: string): string => (isEstimated(id) ? `url(#hatch-${id})` : colorOf(id))
  const estimatedIds = providerIds.filter(isEstimated)

  const heatmap = useMemo(() => {
    const perDay = new Map<string, { events: number; tokens: number }>()
    for (const row of daily) {
      const entry = perDay.get(row.day) ?? { events: 0, tokens: 0 }
      entry.events += row.events
      entry.tokens += row.tokens
      perDay.set(row.day, entry)
    }
    const cells: { key: string; events: number; tokens: number }[] = []
    const start = new Date()
    start.setDate(start.getDate() - (HEATMAP_DAYS - 1))
    for (let i = 0; i < HEATMAP_DAYS; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      const key = dayKey(d)
      const entry = perDay.get(key)
      cells.push({ key, events: entry?.events ?? 0, tokens: entry?.tokens ?? 0 })
    }
    return { cells, leadingPad: start.getDay() }
  }, [daily])

  const level = (events: number): number => (events === 0 ? 0 : events <= 2 ? 1 : events <= 5 ? 2 : 3)

  // Phase 34.5: summary stats from the same day cells, shown beneath the heatmap
  // so the Usage Activity card is dense and balanced instead of half-empty.
  const usageStats = useMemo(() => {
    let activeDays = 0
    let totalSends = 0
    let peak = { key: '', events: 0 }
    let lastActive = ''
    for (const cell of heatmap.cells) {
      if (cell.events > 0) {
        activeDays += 1
        totalSends += cell.events
        lastActive = cell.key
        if (cell.events > peak.events) peak = { key: cell.key, events: cell.events }
      }
    }
    return { activeDays, totalSends, peak, lastActive }
  }, [heatmap])

  const shortDay = (key: string): string => (key ? key.slice(5) : '—')

  const barData = useMemo(() => {
    const rows = new Map<string, Record<string, number | string>>()
    const start = new Date()
    start.setDate(start.getDate() - (BAR_DAYS - 1))
    for (let i = 0; i < BAR_DAYS; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      rows.set(dayKey(d), { day: dayKey(d).slice(5) })
    }
    for (const row of daily) {
      const entry = rows.get(row.day)
      if (entry) entry[row.providerId] = ((entry[row.providerId] as number) ?? 0) + row.tokens
    }
    return [...rows.values()]
  }, [daily])

  const donutData = useMemo(
    () =>
      (summary?.byProvider ?? [])
        .map((provider) => ({
          name: `${provider.providerId}${provider.estimated ? ' approx' : ''}`,
          providerId: provider.providerId,
          value: provider.promptTokens + provider.completionTokens
        }))
        .filter((item) => item.value > 0),
    [summary]
  )

  const maxBarTotal = useMemo(
    () =>
      Math.max(
        0,
        ...barData.map((row) => providerIds.reduce((sum, id) => sum + Number(row[id] ?? 0), 0))
      ),
    [barData, providerIds]
  )

  const donutTotal = donutData.reduce((sum, item) => sum + item.value, 0)
  const donutSlices = useMemo(() => {
    let cursor = 0
    return donutData.map((item) => {
      const span = donutTotal > 0 ? (item.value / donutTotal) * 360 : 0
      const slice = { ...item, startAngle: cursor, endAngle: Math.min(cursor + span, 359.99) }
      cursor += span
      return slice
    })
  }, [donutData, donutTotal])

  const hasUsage = (summary?.byProvider.length ?? 0) > 0
  const connectedAdapters = agentAdapters.filter((agent) => agent.integrationStage === 'runtime-connected-existing-provider').length
  const observedSessions = runtimeSnapshot?.observedSessions.length ?? 0
  const activeRuntime = (runtimeSnapshot?.activeProviderCalls.length ?? 0) + (runtimeSnapshot?.activePtySessions.length ?? 0)
  const activeLoops = loops.filter(loopIsActive).length
  const latestSession = sessions[0]
  const latestTest = testRuns[0]
  const latestEvaluation = evaluations[0]

  return (
    <main className="dashboard">
      <div className="dash-hero">
        <div>
          <span className="dash-kicker">Agent OS command surface</span>
          <h1>Dashboard</h1>
          <p>Local usage, runtime observation, loops, and test signal in one read-only overview.</p>
        </div>
        <span className="dash-observation-pill">Observation only</span>
      </div>

      {error && <div className="chat-notice">{error}</div>}

      <svg width={0} height={0} style={{ position: 'absolute' }}>
        <defs>
          {providerIds.map((id) => (
            <pattern
              key={id}
              id={`hatch-${id}`}
              patternUnits="userSpaceOnUse"
              width={6}
              height={6}
              patternTransform="rotate(45)"
            >
              <rect width={6} height={6} fill={colorOf(id)} />
              <line x1={0} y1={0} x2={0} y2={6} stroke="rgba(0, 0, 0, 0.42)" strokeWidth={3} />
            </pattern>
          ))}
        </defs>
      </svg>

      <section className="dash-overview-grid" aria-label="Dashboard overview">
        <div className="dash-command-card">
          <span>Active workspace</span>
          <strong>{activeProject?.name ?? 'No project'}</strong>
          <em>{activeProject?.path ?? 'Open a project to bind terminals and workspace chat.'}</em>
        </div>
        <div className="dash-command-card">
          <span>Runtime observed</span>
          <strong>{activeRuntime}</strong>
          <em>{observedSessions} sessions / {runtimeSnapshot?.activePtySessions.length ?? 0} PTYs</em>
        </div>
        <div className="dash-command-card">
          <span>Provider usage</span>
          <strong>{fmtTokens(summary?.totalTokens ?? 0)}</strong>
          <em>{summary?.sessionCount ?? 0} recorded sessions</em>
        </div>
        <div className="dash-command-card">
          <span>Test signal</span>
          <strong>{testRuns.length ? statusLabel(latestTest?.status) : 'No runs'}</strong>
          <em>{resultText(latestTest)}</em>
        </div>
        <div className="dash-command-card">
          <span>Loop activity</span>
          <strong>{activeLoops}</strong>
          <em>{loops.length ? `${loops.length} recent loops loaded` : 'No loop activity yet'}</em>
        </div>
      </section>

      <section className="dash-section dash-agent-os">
        <div className="dash-section-head">
          <div>
            <h2>Agent OS visibility</h2>
            <p>Read-only status from the Agent Hub foundation. Open Settings, then Agents, for session detail inspection.</p>
          </div>
          <span>{runtimeSnapshot ? `checked ${relativeTime(runtimeSnapshot.checkedAt)}` : 'not checked'}</span>
        </div>
        <div className="dash-agent-grid">
          <div>
            <span>Registered agents</span>
            <strong>{agentAdapters.length}</strong>
            <em>{connectedAdapters} connected through existing runtime paths</em>
          </div>
          <div>
            <span>Observed sessions</span>
            <strong>{observedSessions}</strong>
            <em>{runtimeSnapshot?.activeProviderCalls.length ?? 0} active provider calls</em>
          </div>
          <div>
            <span>Local runtime</span>
            <strong>{runtimeSnapshot?.ollamaStatus?.status ?? 'unknown'}</strong>
            <em>Ollama status uses conservative local detection</em>
          </div>
          <div>
            <span>Recent chat activity</span>
            <strong>{latestSession ? relativeTime(latestSession.updatedAt) : 'none'}</strong>
            <em>{latestSession?.title ?? 'No chat history recorded yet'}</em>
          </div>
        </div>
        {!activeRuntime && !observedSessions && (
          <div className="dash-empty-state">
            No observed runtime yet. Run a chat provider call or open a project terminal, then inspect it in Settings, then Agents.
          </div>
        )}
      </section>

      <section className="dash-section dash-mission-os">
        <div className="dash-section-head">
          <div>
            <h2>Mission Engine skeleton</h2>
            <p>Preview-only planning structure for future planner, executor, reviewer, tester, and committer flows.</p>
          </div>
          <span>Phase 32</span>
        </div>
        <div className="dash-mission-grid">
          <div>
            <span>Templates</span>
            <strong>{missionTemplates.length}</strong>
            <em>Preview workflows registered in main memory</em>
          </div>
          <div>
            <span>Draft missions</span>
            <strong>{draftMissions.length}</strong>
            <em>{draftMissions[0]?.title ?? 'Create previews in Settings, then Missions'}</em>
          </div>
          <div>
            <span>Execution state</span>
            <strong>Preview only</strong>
            <em>No providers, terminals, tests, commits, or pushes are controlled here</em>
          </div>
          <div>
            <span>Next direction</span>
            <strong>Persistence</strong>
            <em>Read-only mission history is the safest next layer</em>
          </div>
        </div>
        {draftMissions.length === 0 && (
          <div className="dash-empty-state">
            No draft missions yet. Open Settings, then Missions, to create a preview mission without executing anything.
          </div>
        )}
      </section>

      <section className="dash-section dash-runtime">
        <div className="dash-section-head">
          <div>
            <h2>Local model runtime</h2>
            <p>Where your local models come from right now — this Mac, or the PC over LAN / Tailscale / Akorith Controller. Resolved automatically.</p>
          </div>
          <button type="button" className="dash-refresh" disabled={runtimeBusy} onClick={() => void loadRuntime()}>
            {runtimeBusy ? 'Checking…' : 'Refresh'}
          </button>
        </div>
        {runtime ? (
          <>
            <div className={`runtime-readiness is-${runtime.readiness}`}>
              <span className="runtime-dot" />
              <strong>
                {runtime.readiness === 'ready'
                  ? 'Ready'
                  : runtime.readiness === 'attention'
                    ? 'Needs attention'
                    : runtime.readiness === 'offline'
                      ? 'Offline'
                      : 'Setup required'}
              </strong>
              {runtime.ok && runtime.label && <span className="runtime-source">{runtime.label}</span>}
            </div>
            <div className="ctrl-grid">
              <div className="ctrl-field">
                <span>Source</span>
                <code>{runtime.ok ? runtime.label ?? '—' : 'unavailable'}</code>
              </div>
              <div className="ctrl-field">
                <span>Models</span>
                <code>{runtime.modelCount}</code>
              </div>
              <div className="ctrl-field">
                <span>Endpoint</span>
                <code>{runtime.baseUrl ?? runtime.lastSuccessfulBaseUrl ?? '—'}</code>
              </div>
              <div className="ctrl-field">
                <span>Tailscale</span>
                <code>
                  {runtime.tailscale.installed
                    ? runtime.tailscale.running
                      ? `connected · ${runtime.tailscale.peerCount} peer(s)`
                      : 'installed, off'
                    : 'not installed'}
                </code>
              </div>
            </div>
            <div className="dash-gpu-note">{runtime.reason}</div>
            {!runtime.ok && (
              <div className="dash-gpu-note">
                Open <strong>Settings → Providers</strong> to add a Remote Runtime profile (LAN, Tailscale, or Akorith
                Controller). Last working endpoint: <code>{runtime.lastSuccessfulBaseUrl ?? 'none yet'}</code>.
              </div>
            )}
            {runtime.ok && runtime.source !== 'controller' && (
              <div className="dash-gpu-note">
                Direct Ollama does not expose GPU telemetry. Enable the Akorith Controller on the PC for live GPU data.
              </div>
            )}
          </>
        ) : (
          <div className="dash-gpu-note">{runtimeBusy ? 'Resolving runtime…' : 'Runtime status unavailable.'}</div>
        )}
      </section>

      <section className="dash-section dash-gpu">
        <div className="dash-section-head">
          <div>
            <h2>GPU / Local model runtime</h2>
            <p>Shows the GPU of the machine running your local models — the remote PC controller if configured, else this Mac. Never fabricated.</p>
          </div>
          <button type="button" className="dash-refresh" disabled={gpuBusy} onClick={() => void loadGpu()}>
            {gpuBusy ? 'Reading…' : 'Refresh'}
          </button>
        </div>
        <div className="dash-gpu-source">
          <span className={`dash-gpu-chip is-${telemetry?.source === 'remote' ? 'remote' : 'local'}`}>
            {telemetry
              ? telemetry.source === 'remote'
                ? `Remote PC: ${telemetry.profile?.name ?? 'controller'}`
                : 'Local Mac'
              : '—'}
          </span>
          {telemetry?.source === 'remote' && <em>{telemetry.profile?.baseUrl}</em>}
          {telemetry?.source === 'local' && telemetry.gpu.ollama?.configuredBaseUrl && (
            <em>{telemetry.gpu.ollama.configuredBaseUrl}</em>
          )}
          {telemetry && <span className="dash-gpu-checked">checked {relativeTime(telemetry.checkedAt)}</span>}
        </div>
        {telemetry?.remoteError && <div className="dash-gpu-note is-error">Remote telemetry failed: {telemetry.remoteError}</div>}
        {telemetry && telemetry.gpu.status === 'observed' && telemetry.gpu.gpus.length > 0 ? (
          <div className="dash-gpu-grid">
            {telemetry.gpu.gpus.map((device, index) => (
              <div className="dash-gpu-card" key={`${device.name}-${index}`}>
                <div className="dash-gpu-name" title={device.name}>{device.name}</div>
                <div className="dash-gpu-util">
                  <strong>{device.utilizationPercent ?? '—'}</strong>
                  <span>% GPU</span>
                </div>
                {device.utilizationPercent !== undefined && (
                  <div className="dash-gpu-bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(0, Math.min(100, device.utilizationPercent))}%` }} />
                  </div>
                )}
                <div className="dash-gpu-meta">
                  <span>
                    VRAM{' '}
                    {device.memoryUsedMb !== undefined && device.memoryTotalMb !== undefined
                      ? `${(device.memoryUsedMb / 1024).toFixed(1)} / ${(device.memoryTotalMb / 1024).toFixed(1)} GB`
                      : '—'}
                  </span>
                  {device.temperatureC !== undefined && <span>{device.temperatureC}°C</span>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="dash-empty-hint dash-gpu-unavailable">
            {telemetry?.gpu.reason ?? 'GPU telemetry has not been read yet.'}
            {!hasRemoteProfiles && (
              <span className="dash-gpu-note">
                Your local models run on the PC, not this Mac. Configure a remote telemetry profile in Settings → API to
                show the PC&apos;s GPU here (enable the Controller API on the PC over Tailscale/VPN, then add its URL + token).
              </span>
            )}
            {telemetry?.gpu.ollama?.note && <span className="dash-gpu-note">{telemetry.gpu.ollama.note}</span>}
          </div>
        )}
      </section>

      <section className="dash-section dash-limits">
        <div className="dash-section-head">
          <div>
            <h2>Usage limits (Claude / Codex)</h2>
            <p>Akorith&apos;s recorded in-app usage and the limits you configure. Exact remaining subscription limits are not exposed by the CLIs.</p>
          </div>
          {update && update.mode === 'git' && (
            <span className={update.hasUpdate ? 'dash-update-badge has-update' : 'dash-update-badge'}>
              {update.hasUpdate ? `Update available (${update.behindBy} behind)` : 'Akorith up to date'}
            </span>
          )}
        </div>
        {(() => {
          const win = (rows: { providerId: string; events: number; tokens: number }[] | undefined, pid: string) =>
            rows?.find((r) => r.providerId === pid)
          const cards: { provider: string; pid: string; cfg5h?: string; cfgWk?: string }[] = [
            { provider: 'Claude', pid: 'claude', cfg5h: usageLimits?.config.claude5h, cfgWk: usageLimits?.config.claudeWeekly },
            { provider: 'Codex / ChatGPT', pid: 'chatgpt', cfg5h: usageLimits?.config.codex5h, cfgWk: usageLimits?.config.codexWeekly }
          ]
          return (
            <div className="dash-limit-grid">
              {cards.map((c) => {
                const f = win(usageLimits?.windows.fiveHour, c.pid)
                const w = win(usageLimits?.windows.weekly, c.pid)
                return (
                  <div className="dash-limit-card" key={c.pid}>
                    <div className="dash-limit-name">{c.provider}</div>
                    <div className="dash-limit-rows">
                      <div className="dash-limit-row">
                        <span>Last 5h (in-app)</span>
                        <strong>{f ? `${f.events} calls · ${fmtTokens(f.tokens)}` : '0 calls'}</strong>
                        {c.cfg5h && <em>limit: {c.cfg5h}</em>}
                      </div>
                      <div className="dash-limit-row">
                        <span>Last 7 days (in-app)</span>
                        <strong>{w ? `${w.events} calls · ${fmtTokens(w.tokens)}` : '0 calls'}</strong>
                        {c.cfgWk && <em>limit: {c.cfgWk}</em>}
                      </div>
                    </div>
                    {!c.cfg5h && !c.cfgWk && (
                      <div className="dash-limit-cta">Set your subscription limits in Settings → Profile to compare.</div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })()}
        {usageLimits?.note && <div className="dash-limit-note">{usageLimits.note}</div>}
      </section>

      <section className="dash-section dash-control-os">
        <div className="dash-section-head">
          <div>
            <h2>Controller API and plugins</h2>
            <p>Optional local API (read-only, loopback by default) and the plugin foundation. Manage both in Settings.</p>
          </div>
          <span>{controller ? (controller.running ? `running · ${controller.baseUrl}` : 'stopped') : 'not checked'}</span>
        </div>
        <div className="dash-agent-grid">
          <div>
            <span>Controller</span>
            <strong>{controller ? (controller.running ? 'Running' : controller.enabled ? 'Enabled' : 'Disabled') : '—'}</strong>
            <em>{controller ? `${controller.readOnly ? 'Read-only' : 'Read/write'} · ${controller.allowLan ? 'LAN allowed' : 'loopback only'}` : 'Open Settings, then API'}</em>
          </div>
          <div>
            <span>SSE clients</span>
            <strong>{controller?.connectedClients ?? 0}</strong>
            <em>{controller?.sseEnabled ? 'Event stream enabled' : 'Event stream off'}</em>
          </div>
          <div>
            <span>Plugins ready</span>
            <strong>{plugins ? plugins.filter((p) => p.effectiveStatus === 'available' || p.effectiveStatus === 'built_in').length : 0}</strong>
            <em>{plugins ? `of ${plugins.length} registered` : 'Loading…'}</em>
          </div>
          <div>
            <span>Plugin foundation</span>
            <strong>Read-only</strong>
            <em>No plugin executes or loads remote code yet</em>
          </div>
        </div>
      </section>

      <div className="dash-grid">
        <section className="dash-section">
          <div className="dash-section-head">
            <div>
              <h2>Usage activity</h2>
              <p>Trailing {HEATMAP_DAYS} days, one cell per day.</p>
            </div>
          </div>
          <div className="heatmap" aria-label="Usage heatmap">
            {Array.from({ length: heatmap.leadingPad }).map((_, index) => (
              <span key={`pad-${index}`} className="hm-cell hm-pad" />
            ))}
            {heatmap.cells.map((cell) => (
              <span
                key={cell.key}
                className={`hm-cell hm-l${level(cell.events)}`}
                title={`${cell.key} - ${cell.events} send${cell.events === 1 ? '' : 's'}, ${fmtTokens(cell.tokens)} tokens`}
              />
            ))}
          </div>
          <div className="hm-legend">
            <span>Less</span>
            <span className="hm-cell hm-l0" />
            <span className="hm-cell hm-l1" />
            <span className="hm-cell hm-l2" />
            <span className="hm-cell hm-l3" />
            <span>More</span>
          </div>
          {hasUsage ? (
            <div className="usage-stat-row">
              <div className="usage-stat">
                <span>Active days</span>
                <strong>{usageStats.activeDays}</strong>
              </div>
              <div className="usage-stat">
                <span>Total sends</span>
                <strong>{usageStats.totalSends}</strong>
              </div>
              <div className="usage-stat">
                <span>Total tokens</span>
                <strong>{fmtTokens(summary?.totalTokens ?? 0)}</strong>
              </div>
              <div className="usage-stat">
                <span>Peak day</span>
                <strong>{shortDay(usageStats.peak.key)}</strong>
                <em>{usageStats.peak.events ? `${usageStats.peak.events} sends` : ''}</em>
              </div>
              <div className="usage-stat">
                <span>Last active</span>
                <strong>{shortDay(usageStats.lastActive)}</strong>
              </div>
            </div>
          ) : (
            <div className="dash-empty-state">No usage yet. Send a provider chat message to populate activity.</div>
          )}
        </section>

        <section className="dash-section">
          <div className="dash-section-head">
            <div>
              <h2>Provider mix</h2>
              <p>Token distribution by recorded provider.</p>
            </div>
          </div>
          {donutData.length === 0 ? (
            <div className="dash-empty-state">No provider usage recorded yet.</div>
          ) : (
            <div className="dash-donut-wrap">
              <svg className="dash-donut" viewBox="0 0 240 240" role="img" aria-label="Provider token distribution">
                {donutSlices.map((slice) => (
                  <path
                    key={slice.providerId}
                    d={donutSlicePath(120, 120, 100, 50, slice.startAngle, slice.endAngle)}
                    fill={fillOf(slice.providerId)}
                    stroke="var(--bg-panel)"
                    strokeWidth={1.5}
                  >
                    <title>{slice.name}: {fmtTokens(slice.value)} tokens</title>
                  </path>
                ))}
                <text x={120} y={114} textAnchor="middle" className="dash-donut-value">
                  {fmtTokens(donutTotal)}
                </text>
                <text x={120} y={136} textAnchor="middle" className="dash-donut-label">
                  tokens
                </text>
              </svg>
              <div className="dash-chart-legend">
                {donutData.map((item) => (
                  <span key={item.providerId} className="dash-chip">
                    <span className="dash-chip-dot" style={{ background: colorOf(item.providerId) }} />
                    {item.name} {fmtTokens(item.value)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      <section className="dash-section">
        <div className="dash-section-head">
          <div>
            <h2>Daily token usage</h2>
            <p>Last {BAR_DAYS} days, stacked by provider.</p>
          </div>
        </div>
        <svg className="dash-bar-chart" viewBox="0 0 640 260" role="img" aria-label="Daily token usage">
          {chartTicks(maxBarTotal).map((tick) => {
            const y = 18 + (1 - (maxBarTotal > 0 ? tick / maxBarTotal : 0)) * 188
            return (
              <g key={tick}>
                <line x1={48} x2={628} y1={y} y2={y} className="dash-chart-grid" />
                <text x={0} y={y + 4} className="dash-chart-axis">
                  {fmtTokens(Math.round(tick))}
                </text>
              </g>
            )
          })}
          {barData.map((row, index) => {
            const step = 580 / Math.max(barData.length, 1)
            // Phase 33.12: thicker bars (OpenCode-style chunky usage columns).
            const width = Math.max(7, step * 0.82)
            const x = 48 + index * step + (step - width) / 2
            let stackBottom = 206
            return (
              <g key={String(row.day)}>
                {providerIds.map((id) => {
                  const value = Number(row[id] ?? 0)
                  if (value <= 0 || maxBarTotal <= 0) return null
                  const height = Math.max(2, (value / maxBarTotal) * 188)
                  const y = stackBottom - height
                  stackBottom = y
                  return (
                    <rect key={id} x={x} y={y} width={width} height={height} rx={1} fill={fillOf(id)}>
                      <title>{row.day} - {id}: {fmtTokens(value)} tokens</title>
                    </rect>
                  )
                })}
                {index % 5 === 0 && (
                  <text x={x + width / 2} y={232} textAnchor="middle" className="dash-chart-axis">
                    {String(row.day)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        <div className="dash-chart-legend">
          {providerIds.map((id) => (
            <span key={id} className="dash-chip">
              <span className="dash-chip-dot" style={{ background: colorOf(id) }} />
              {id}
              {isEstimated(id) && <span className="chat-estimated">approx</span>}
            </span>
          ))}
          {!providerIds.length && <span className="dash-empty-hint">No providers with recorded usage yet.</span>}
        </div>
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <div>
            <h2>Loop and Test Lab signal</h2>
            <p>Lightweight visibility from existing local records. Execution behavior is unchanged.</p>
          </div>
        </div>
        <div className="dash-ops-grid">
          <div>
            <span>Latest loop</span>
            <strong>{loops[0]?.title ?? loops[0]?.goal ?? 'No loops yet'}</strong>
            <em>{loops[0] ? `${statusLabel(loops[0].status)} - ${relativeTime(loops[0].updatedAt)}` : 'Create a loop to populate this card.'}</em>
          </div>
          <div>
            <span>Latest test run</span>
            <strong>{latestTest?.targetDesc ?? latestTest?.sourceRepo ?? 'No test run yet'}</strong>
            <em>{resultText(latestTest)}</em>
          </div>
          <div>
            <span>Latest report</span>
            <strong>{latestEvaluation ? `${latestEvaluation.totalScore.toFixed(1)} score` : 'No reports yet'}</strong>
            <em>{latestEvaluation ? `${latestEvaluation.kind} - ${relativeTime(latestEvaluation.ts)}` : 'Evaluate a run to create a report.'}</em>
          </div>
        </div>
      </section>

      <p className="dash-footnote">
        Claude and Local token counts are exact when reported by the provider. Codex/ChatGPT usage can be estimated
        {estimatedIds.length > 0 ? `; estimated providers: ${estimatedIds.join(', ')}` : ''}. Runtime observation is in-memory and read-only.
      </p>
    </main>
  )
}
