import { useEffect, useMemo, useState } from 'react'
import type { DailyUsageRow, UsageSummary } from '../../../preload/index.d'

// Reads ONLY usage_events (via the usage IPC).
// TODO(phase 6): the router consumes the same data to pick providers.

// Provider-identity colors (Phase 13.2): Claude = orange, ChatGPT/Codex = blue,
// Local/Ollama = purple. Anything else falls back to a neutral gray.
function providerColor(id: string): string {
  const n = id.toLowerCase()
  if (n.includes('claude')) return '#d08a4f'
  if (n.includes('chatgpt') || n.includes('codex') || n.includes('openai') || n.includes('gpt')) return '#5a93d8'
  if (n.includes('local') || n.includes('ollama')) return '#9a8fe0'
  return '#8a8893'
}
const HEATMAP_DAYS = 270
const BAR_DAYS = 30

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
  const colorOf = (id: string): string => providerColor(id)
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
  const maxBarTotal = useMemo(
    () =>
      Math.max(
        0,
        ...barData.map((row) => providerIds.reduce((sum, id) => sum + Number(row[id] ?? 0), 0))
      ),
    [barData, providerIds]
  )
  const donutTotal = donutData.reduce((sum, d) => sum + d.value, 0)
  const donutSlices = useMemo(() => {
    let cursor = 0
    return donutData.map((d) => {
      const span = donutTotal > 0 ? (d.value / donutTotal) * 360 : 0
      const slice = { ...d, startAngle: cursor, endAngle: Math.min(cursor + span, 359.99) }
      cursor += span
      return slice
    })
  }, [donutData, donutTotal])

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
              <line x1={0} y1={0} x2={0} y2={6} stroke="rgba(11, 11, 16, 0.68)" strokeWidth={3} />
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
                      <rect
                        key={id}
                        x={x}
                        y={y}
                        width={width}
                        height={height}
                        rx={2}
                        fill={fillOf(id)}
                      >
                        <title>
                          {row.day} — {id}: {fmtTokens(value)} tokens
                        </title>
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
                {isEstimated(id) && <span className="chat-estimated">≈</span>}
              </span>
            ))}
          </div>
        </section>

        <section className="dash-section">
          <h2>Provider distribution — by tokens</h2>
          {donutData.length === 0 ? (
            <div className="dash-empty-hint">no usage recorded yet</div>
          ) : (
            <div className="dash-donut-wrap">
              <svg className="dash-donut" viewBox="0 0 240 240" role="img" aria-label="Provider token distribution">
                {donutSlices.map((d) => (
                  <path
                    key={d.providerId}
                    d={donutSlicePath(120, 120, 94, 58, d.startAngle, d.endAngle)}
                    fill={fillOf(d.providerId)}
                    stroke="#0b0b10"
                    strokeWidth={2}
                  >
                    <title>
                      {d.name}: {fmtTokens(d.value)} tokens
                    </title>
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
                {donutData.map((d) => (
                  <span key={d.providerId} className="dash-chip">
                    <span className="dash-chip-dot" style={{ background: colorOf(d.providerId) }} />
                    {d.name} {fmtTokens(d.value)}
                  </span>
                ))}
              </div>
            </div>
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
