import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type {
  DailyUsageRow,
  GpuDevice,
  GpuStatusResult,
  ProjectRow,
  RemoteTelemetryProfileView,
  TelemetryStatus,
  TestRunRow,
  UsageSummary
} from '../../../preload/index.d'
import { useProfileIdentity } from '../profileIdentity'
import { ProfileAvatar } from './ProfileAvatar'

const ACTIVITY_WEEKS = 53

interface DashboardProps {
  activeProject: ProjectRow | null
}

interface ActivityDay {
  date: Date
  key: string
  tokens: number
  events: number
  future: boolean
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localDate(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

function formatDuration(value: number): string {
  if (value <= 0) return '—'
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function activityLevel(tokens: number, peak: number): number {
  if (tokens <= 0 || peak <= 0) return 0
  const ratio = tokens / peak
  if (ratio >= 0.72) return 4
  if (ratio >= 0.42) return 3
  if (ratio >= 0.16) return 2
  return 1
}

function calculateStreaks(tokensByDay: Map<string, number>): { current: number; longest: number } {
  const activeDays = [...tokensByDay.entries()]
    .filter(([, tokens]) => tokens > 0)
    .map(([key]) => localDate(key))
    .sort((a, b) => a.getTime() - b.getTime())

  let longest = 0
  let run = 0
  let previous: Date | undefined
  for (const activeDay of activeDays) {
    const expected = previous ? new Date(previous) : undefined
    expected?.setDate(expected.getDate() + 1)
    run = expected && dayKey(activeDay) === dayKey(expected) ? run + 1 : 1
    longest = Math.max(longest, run)
    previous = activeDay
  }

  let current = 0
  const cursor = new Date()
  cursor.setHours(0, 0, 0, 0)
  while ((tokensByDay.get(dayKey(cursor)) ?? 0) > 0) {
    current += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return { current, longest }
}

function machineMemory(devices: GpuDevice[]): { used: number; total: number } {
  return devices.reduce(
    (sum, device) => ({
      used: sum.used + (device.memoryUsedMb ?? 0),
      total: sum.total + (device.memoryTotalMb ?? 0)
    }),
    { used: 0, total: 0 }
  )
}

function memoryLabel(value?: number): string {
  if (!value) return '—'
  return value >= 1024 ? `${(value / 1024).toFixed(1)}G` : `${Math.round(value)}M`
}

function averageMetric(devices: GpuDevice[], key: 'utilizationPercent' | 'temperatureC'): string {
  const observed = devices.map((device) => device[key]).filter((value): value is number => typeof value === 'number')
  if (!observed.length) return '—'
  return `${Math.round(observed.reduce((sum, value) => sum + value, 0) / observed.length)}${key === 'temperatureC' ? '°' : '%'}`
}

function smoothWavePath(values: number[]): string {
  const safeValues = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0]
  const points = safeValues.map((value, index) => ({
    x: (index / Math.max(1, safeValues.length - 1)) * 640,
    y: 58 - (Math.max(0, Math.min(100, value)) / 100) * 50
  }))
  let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const point = points[index]
    const midpoint = (previous.x + point.x) / 2
    path += ` C ${midpoint.toFixed(1)} ${previous.y.toFixed(1)}, ${midpoint.toFixed(1)} ${point.y.toFixed(1)}, ${point.x.toFixed(1)} ${point.y.toFixed(1)}`
  }
  return path
}

function CpuUsageWave({ values, current }: { values: number[]; current: number }): JSX.Element {
  const samples = values.length ? values : [current, current]
  const path = smoothWavePath(samples)
  const id = useId().replace(/:/g, '')
  const strokeId = `compute-wave-stroke-${id}`
  const areaId = `compute-wave-area-${id}`
  return (
    <div className="compute-wave" role="img" aria-label={`CPU utilization history, currently ${Math.round(current)} percent`}>
      <svg viewBox="0 0 640 64" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={strokeId} x1="0" x2="1">
            <stop offset="0" stopColor="#6fda9d" />
            <stop offset="1" stopColor="#9a6cf0" />
          </linearGradient>
          <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#906ce8" stopOpacity=".22" />
            <stop offset="1" stopColor="#65d49a" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path className="compute-wave-area" d={`${path} L 640 64 L 0 64 Z`} style={{ fill: `url(#${areaId})` }} />
        <path className="compute-wave-line" d={path} style={{ stroke: `url(#${strokeId})` }} />
      </svg>
    </div>
  )
}

interface MachineGpuPanelProps {
  eyebrow: string
  name: string
  status: GpuStatusResult | null
  note?: string
  cpuHistory?: number[]
}

function MachineGpuPanel({ eyebrow, name, status, note, cpuHistory = [] }: MachineGpuPanelProps): JSX.Element {
  const devices = status?.gpus ?? []
  const cpu = status?.cpu
  const memory = machineMemory(devices)
  const observed = status?.status === 'observed' && devices.length > 0

  return (
    <section className="gpu-machine" aria-label={`${name} compute telemetry`}>
      <header className="gpu-machine-head">
        <div>
          <span>{eyebrow}</span>
          <strong>{name}</strong>
        </div>
        <div className="gpu-machine-summary">
          <span>CPU <strong>{cpu ? `${Math.round(cpu.utilizationPercent)}%` : '—'}</strong></span>
          <span>GPUS <strong>{devices.length || '—'}</strong></span>
          <span>VRAM <strong>{memory.total ? `${memoryLabel(memory.used)}/${memoryLabel(memory.total)}` : '—'}</strong></span>
          <span>UTIL <strong>{averageMetric(devices, 'utilizationPercent')}</strong></span>
          <span>TEMP <strong>{averageMetric(devices, 'temperatureC')}</strong></span>
        </div>
      </header>

      {cpu || observed ? (
        <div className="gpu-device-list">
          {cpu && (
            <div className="gpu-device-row cpu-device-row">
              <span className="gpu-device-index">CPU</span>
              <span className="gpu-device-name" title={cpu.name}>{cpu.name}</span>
              <CpuUsageWave values={cpuHistory} current={cpu.utilizationPercent} />
              <span className="gpu-device-memory">{cpu.logicalCores} cores</span>
              <span className="gpu-device-util">{Math.round(cpu.utilizationPercent)}%</span>
              <span className="gpu-device-temp">—</span>
            </div>
          )}
          {devices.map((device, index) => {
            const utilization = Math.max(0, Math.min(100, device.utilizationPercent ?? 0))
            const memoryRatio = device.memoryTotalMb
              ? Math.max(0, Math.min(100, ((device.memoryUsedMb ?? 0) / device.memoryTotalMb) * 100))
              : 0
            const barValue = typeof device.utilizationPercent === 'number' ? utilization : memoryRatio
            return (
              <div className="gpu-device-row" key={`${device.name}-${index}`}>
                <span className="gpu-device-index">G{index}</span>
                <span className="gpu-device-name" title={device.name}>{device.name}</span>
                <span className="gpu-device-track" aria-hidden="true">
                  <span style={{ width: `${barValue}%` }} />
                </span>
                <span className="gpu-device-memory">
                  {device.memoryTotalMb ? `${memoryLabel(device.memoryUsedMb)}/${memoryLabel(device.memoryTotalMb)}` : 'shared'}
                </span>
                <span className="gpu-device-util">{typeof device.utilizationPercent === 'number' ? `${Math.round(utilization)}%` : '—'}</span>
                <span className="gpu-device-temp">{typeof device.temperatureC === 'number' ? `${Math.round(device.temperatureC)}°` : '—'}</span>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="gpu-machine-empty">
          <span className="gpu-device-index">G—</span>
          <span>{status?.reason ?? note ?? 'GPU telemetry is not connected.'}</span>
        </div>
      )}

      {(note || status?.reason || status?.ollama.note) && <p className="gpu-machine-note">{note ?? status?.reason ?? status?.ollama.note}</p>}
    </section>
  )
}

export default function Dashboard(_props: DashboardProps): JSX.Element {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [daily, setDaily] = useState<DailyUsageRow[]>([])
  const [runs, setRuns] = useState<TestRunRow[]>([])
  const [localGpu, setLocalGpu] = useState<GpuStatusResult | null>(null)
  const [remoteTelemetry, setRemoteTelemetry] = useState<TelemetryStatus | null>(null)
  const [remoteProfiles, setRemoteProfiles] = useState<RemoteTelemetryProfileView[]>([])
  const [gpuBusy, setGpuBusy] = useState(false)
  const [cpuHistory, setCpuHistory] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const { identity } = useProfileIdentity()

  const loadGpu = useCallback(async (): Promise<void> => {
    setGpuBusy(true)
    try {
      const [local, remote, profiles] = await Promise.all([
        window.api.gpu.getStatus(),
        window.api.telemetry.getStatus(),
        window.api.telemetry.getProfiles()
      ])
      setLocalGpu(local)
      const initialCpu = local.cpu
      if (initialCpu) {
        setCpuHistory((current) => [...current, initialCpu.utilizationPercent].slice(-56))
      }
      setRemoteTelemetry(remote)
      setRemoteProfiles(profiles)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setGpuBusy(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void Promise.all([window.api.usage.summary(), window.api.usage.daily(370), window.api.test.listRuns(250)])
      .then(([nextSummary, nextDaily, nextRuns]) => {
        if (cancelled) return
        setSummary(nextSummary)
        setDaily(nextDaily)
        setRuns(nextRuns)
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    void loadGpu()
    return () => {
      cancelled = true
    }
  }, [loadGpu])

  useEffect(() => {
    let cancelled = false
    const sampleCpu = async (): Promise<void> => {
      const cpu = await window.api.gpu.getCpuStatus().catch(() => undefined)
      if (cancelled || !cpu) return
      setCpuHistory((current) => [...current, cpu.utilizationPercent].slice(-56))
      setLocalGpu((current) => current ? { ...current, cpu } : current)
    }
    const timer = window.setInterval(() => void sampleCpu(), 1800)
    void sampleCpu()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const dailyTotals = useMemo(() => {
    const totals = new Map<string, { tokens: number; events: number }>()
    for (const row of daily) {
      const current = totals.get(row.day) ?? { tokens: 0, events: 0 }
      current.tokens += row.tokens
      current.events += row.events
      totals.set(row.day, current)
    }
    return totals
  }, [daily])

  const activityDays = useMemo<ActivityDay[]>(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const start = new Date(today)
    start.setDate(start.getDate() - (ACTIVITY_WEEKS * 7 - 1))
    start.setDate(start.getDate() - start.getDay())
    return Array.from({ length: ACTIVITY_WEEKS * 7 }, (_, index) => {
      const date = new Date(start)
      date.setDate(start.getDate() + index)
      const key = dayKey(date)
      const value = dailyTotals.get(key)
      return { date, key, tokens: value?.tokens ?? 0, events: value?.events ?? 0, future: date > today }
    })
  }, [dailyTotals])

  const tokensByDay = useMemo(
    () => new Map([...dailyTotals.entries()].map(([key, value]) => [key, value.tokens])),
    [dailyTotals]
  )
  const peakTokens = useMemo(() => Math.max(0, ...activityDays.map((day) => day.tokens)), [activityDays])
  const streaks = useMemo(() => calculateStreaks(tokensByDay), [tokensByDay])
  const longestTask = useMemo(() => Math.max(0, ...runs.map((run) => run.durationMs ?? 0)), [runs])
  const monthLabels = useMemo(() => {
    const labels: { column: number; label: string }[] = []
    let previousMonth = -1
    for (let column = 0; column < ACTIVITY_WEEKS; column += 1) {
      const date = activityDays[column * 7]
      if (!date || date.date.getMonth() === previousMonth) continue
      previousMonth = date.date.getMonth()
      labels.push({ column, label: date.date.toLocaleDateString(undefined, { month: 'short' }) })
    }
    return labels
  }, [activityDays])

  const connectedProfile = remoteTelemetry?.source === 'remote' ? remoteTelemetry.profile : undefined
  const configuredRemote = remoteProfiles.find((profile) => profile.enabled)
  const remoteName = connectedProfile?.name ?? configuredRemote?.name ?? 'Connected computer'
  const remoteNote = remoteTelemetry?.source === 'remote'
    ? connectedProfile?.baseUrl
    : configuredRemote?.lastError ?? remoteTelemetry?.remoteError ?? 'Connect a computer from Settings → Telemetry.'

  return (
    <main className="dashboard profile-dashboard">
      <section className="profile-overview">
        <header className="profile-heading">
          <span>Profile</span>
          <ProfileAvatar name={identity.displayName} photo={identity.profilePhoto} size="large" />
          <h1>{identity.displayName}</h1>
          <div>@local · <strong>Akorith</strong></div>
        </header>

        <div className="profile-stats" aria-label="Profile usage summary">
          <div><strong>{formatTokens(summary?.totalTokens ?? 0)}</strong><span>Lifetime tokens</span></div>
          <div><strong>{formatTokens(peakTokens)}</strong><span>Peak tokens</span></div>
          <div><strong>{formatDuration(longestTask)}</strong><span>Longest task</span></div>
          <div><strong>{streaks.current} {streaks.current === 1 ? 'day' : 'days'}</strong><span>Current streak</span></div>
          <div><strong>{streaks.longest} {streaks.longest === 1 ? 'day' : 'days'}</strong><span>Longest streak</span></div>
        </div>

        <div className="token-activity">
          <div className="token-activity-head">
            <h2>Token activity</h2>
            <span>Daily</span>
          </div>
          <div className="heatmap-shell">
            <div className="heatmap-grid" role="grid" aria-label="Daily token activity">
              {activityDays.map((day) => {
                const tooltip = `${day.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · ${formatTokens(day.tokens)} tokens · ${day.events} ${day.events === 1 ? 'request' : 'requests'}`
                return (
                  <span
                    className={`hm-cell hm-l${day.future ? 0 : activityLevel(day.tokens, peakTokens)} ${day.future ? 'is-future' : ''}`}
                    key={day.key}
                    role="gridcell"
                    aria-label={tooltip}
                    data-tooltip={tooltip}
                  />
                )
              })}
            </div>
            <div className="heatmap-months" aria-hidden="true">
              {monthLabels.map((month) => (
                <span key={`${month.column}-${month.label}`} style={{ gridColumn: month.column + 1 }}>{month.label}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="gpu-console">
        <header className="gpu-console-head">
          <div>
            <span>COMPUTE TELEMETRY</span>
            <h2>Compute usage</h2>
          </div>
          <button type="button" className="dash-refresh" disabled={gpuBusy} onClick={() => void loadGpu()}>
            {gpuBusy ? 'Refreshing…' : 'Refresh'}
          </button>
        </header>

        <MachineGpuPanel eyebrow="CURRENT COMPUTER" name="This Mac" status={localGpu} cpuHistory={cpuHistory} />
        <MachineGpuPanel
          eyebrow="CONNECTED COMPUTER"
          name={remoteName}
          status={remoteTelemetry?.source === 'remote' ? remoteTelemetry.gpu : null}
          note={remoteNote}
        />
      </section>

      {error && <div className="dashboard-error">{error}</div>}
    </main>
  )
}
