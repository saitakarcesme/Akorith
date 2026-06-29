import { useEffect, useMemo, useState } from 'react'
import type {
  AgentAdapterInfo,
  AgentRuntimeSnapshot,
  DailyUsageRow,
  EvaluationRow,
  MacroSessionRow,
  ProjectRow,
  SessionRow,
  TestRunRow,
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
  const [error, setError] = useState<string | null>(null)

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
        sessionsResult
      ] = await Promise.allSettled([
        window.api.usage.summary(),
        window.api.usage.daily(HEATMAP_DAYS),
        window.api.agent.getRuntimeSnapshot(),
        window.api.agent.list(),
        window.api.test.listRuns(5),
        window.api.evaluate.list(3),
        window.api.macro.list(5),
        window.api.history.list()
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

      const failures = [
        summaryResult,
        dailyResult,
        runtimeResult,
        agentsResult,
        testsResult,
        evaluationsResult,
        loopsResult,
        sessionsResult
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
          {!hasUsage && <div className="dash-empty-state">No usage yet. Send a provider chat message to populate activity.</div>}
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
                    d={donutSlicePath(120, 120, 94, 58, slice.startAngle, slice.endAngle)}
                    fill={fillOf(slice.providerId)}
                    stroke="var(--bg-panel)"
                    strokeWidth={2}
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
            const width = Math.max(5, step * 0.62)
            const x = 48 + index * step + (step - width) / 2
            let stackBottom = 206
            return (
              <g key={String(row.day)}>
                {providerIds.map((id) => {
                  const value = Number(row[id] ?? 0)
                  if (value <= 0 || maxBarTotal <= 0) return null
                  const height = Math.max(1, (value / maxBarTotal) * 188)
                  const y = stackBottom - height
                  stackBottom = y
                  return (
                    <rect key={id} x={x} y={y} width={width} height={height} rx={2} fill={fillOf(id)}>
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
