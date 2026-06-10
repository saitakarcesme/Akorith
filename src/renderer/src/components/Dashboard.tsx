import { useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { DailyUsageRow, UsageSummary } from '../../../preload/index.d'

// Reads ONLY usage_events (via the usage IPC).
// TODO(phase 6): the router consumes the same data to pick providers.

const PALETTE = ['#3fb950', '#58a6ff', '#a371f7', '#e3b341', '#f85149', '#2dd4bf']
const HEATMAP_DAYS = 270
const BAR_DAYS = 30

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)

const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const TOOLTIP_STYLE = {
  backgroundColor: '#161c24',
  border: '1px solid #232b36',
  borderRadius: 6,
  fontSize: 12
} as const

export default function Dashboard(): JSX.Element {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [daily, setDaily] = useState<DailyUsageRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([window.api.usage.summary(), window.api.usage.daily(HEATMAP_DAYS)])
      .then(([s, d]) => {
        setSummary(s)
        setDaily(d)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  // Stable provider order/colors from the summary (largest first).
  const providerIds = useMemo(() => summary?.byProvider.map((p) => p.providerId) ?? [], [summary])
  const colorOf = (id: string): string => PALETTE[providerIds.indexOf(id) % PALETTE.length] ?? PALETTE[0]
  const isEstimated = (id: string): boolean => summary?.byProvider.find((p) => p.providerId === id)?.estimated ?? false
  const fillOf = (id: string): string => (isEstimated(id) ? `url(#hatch-${id})` : colorOf(id))
  const estimatedIds = providerIds.filter(isEstimated)

  // ---- heatmap: trailing HEATMAP_DAYS, one cell per day ----
  const heatmap = useMemo(() => {
    const perDay = new Map<string, { events: number; tokens: number }>()
    for (const r of daily) {
      const e = perDay.get(r.day) ?? { events: 0, tokens: 0 }
      e.events += r.events
      e.tokens += r.tokens
      perDay.set(r.day, e)
    }
    const cells: { key: string; events: number; tokens: number }[] = []
    const start = new Date()
    start.setDate(start.getDate() - (HEATMAP_DAYS - 1))
    for (let i = 0; i < HEATMAP_DAYS; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      const key = dayKey(d)
      const e = perDay.get(key)
      cells.push({ key, events: e?.events ?? 0, tokens: e?.tokens ?? 0 })
    }
    return { cells, leadingPad: start.getDay() }
  }, [daily])

  const level = (events: number): number => (events === 0 ? 0 : events <= 2 ? 1 : events <= 5 ? 2 : 3)

  // ---- daily stacked bars: last BAR_DAYS, one row per day, key per provider ----
  const barData = useMemo(() => {
    const rows = new Map<string, Record<string, number | string>>()
    const start = new Date()
    start.setDate(start.getDate() - (BAR_DAYS - 1))
    for (let i = 0; i < BAR_DAYS; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      rows.set(dayKey(d), { day: dayKey(d).slice(5) })
    }
    for (const r of daily) {
      const row = rows.get(r.day)
      if (row) row[r.providerId] = ((row[r.providerId] as number) ?? 0) + r.tokens
    }
    return [...rows.values()]
  }, [daily])

  const donutData = useMemo(
    () =>
      (summary?.byProvider ?? [])
        .map((p) => ({
          name: `${p.providerId}${p.estimated ? ' ≈' : ''}`,
          providerId: p.providerId,
          value: p.promptTokens + p.completionTokens
        }))
        .filter((d) => d.value > 0),
    [summary]
  )

  const hasData = (summary?.byProvider.length ?? 0) > 0

  return (
    <main className="dashboard">
      <h1 className="dash-title">Usage Dashboard</h1>
      {error && <div className="chat-notice">Failed to load usage data: {error}</div>}

      {/* hatch patterns for providers with estimated counts */}
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
              <line x1={0} y1={0} x2={0} y2={6} stroke="rgba(13, 17, 23, 0.65)" strokeWidth={3} />
            </pattern>
          ))}
        </defs>
      </svg>

      <div className="dash-cards">
        <div className="dash-card">
          <div className="dash-card-value">{fmtTokens(summary?.totalTokens ?? 0)}</div>
          <div className="dash-card-label">total tokens{estimatedIds.length > 0 ? ' (incl. ≈)' : ''}</div>
        </div>
        <div className="dash-card">
          <div className="dash-card-value">${(summary?.totalCostUsd ?? 0).toFixed(2)}</div>
          <div className="dash-card-label">total cost</div>
        </div>
        <div className="dash-card">
          <div className="dash-card-value">{summary?.sessionCount ?? 0}</div>
          <div className="dash-card-label">sessions</div>
        </div>
        <div className="dash-card dash-card-wide">
          <div className="dash-card-providers">
            {(summary?.byProvider ?? []).map((p) => (
              <span key={p.providerId} className="dash-chip">
                <span className="dash-chip-dot" style={{ background: colorOf(p.providerId) }} />
                {p.providerId} {fmtTokens(p.promptTokens + p.completionTokens)}
                {p.estimated && <span className="chat-estimated">≈</span>}
              </span>
            ))}
            {!hasData && <span className="dash-empty-hint">no usage recorded yet</span>}
          </div>
          <div className="dash-card-label">tokens by provider</div>
        </div>
      </div>

      <section className="dash-section">
        <h2>Activity — trailing {HEATMAP_DAYS} days</h2>
        <div className="heatmap">
          {Array.from({ length: heatmap.leadingPad }).map((_, i) => (
            <span key={`pad-${i}`} className="hm-cell hm-pad" />
          ))}
          {heatmap.cells.map((c) => (
            <span
              key={c.key}
              className={`hm-cell hm-l${level(c.events)}`}
              title={`${c.key} — ${c.events} send${c.events === 1 ? '' : 's'}, ${fmtTokens(c.tokens)} tokens`}
            />
          ))}
        </div>
      </section>

      <div className="dash-grid">
        <section className="dash-section">
          <h2>Daily token usage — last {BAR_DAYS} days</h2>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={barData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <XAxis dataKey="day" tick={{ fill: '#7d8590', fontSize: 10 }} interval={4} />
              <YAxis tick={{ fill: '#7d8590', fontSize: 10 }} tickFormatter={fmtTokens} width={44} />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(63, 185, 80, 0.06)' }} />
              <Legend formatter={(v: string) => `${v}${isEstimated(v) ? ' ≈' : ''}`} />
              {providerIds.map((id) => (
                <Bar key={id} dataKey={id} stackId="tokens" fill={fillOf(id)} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </section>

        <section className="dash-section">
          <h2>Provider distribution — by tokens</h2>
          {donutData.length === 0 ? (
            <div className="dash-empty-hint">no usage recorded yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={donutData} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95} paddingAngle={2}>
                  {donutData.map((d) => (
                    <Cell key={d.providerId} fill={fillOf(d.providerId)} stroke="#0d1117" />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v) => (typeof v === 'number' ? fmtTokens(v) : String(v ?? ''))}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </section>
      </div>

      <p className="dash-footnote">
        Claude and Local token counts are exact; ChatGPT usage is estimated
        {estimatedIds.length > 0 ? ` (≈ / hatched: ${estimatedIds.join(', ')})` : ''}. Estimated numbers are
        approximations, never precise.
      </p>
    </main>
  )
}
