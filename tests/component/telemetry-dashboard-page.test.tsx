import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import TelemetryDashboardPage, {
  type DashboardHeatmapMode,
  type DashboardHeatmapView,
  type DashboardOverview,
  type DashboardTelemetryApi
} from '../../src/renderer/src/components/TelemetryDashboardPage'

const overview: DashboardOverview = {
  summary: {
    lifetimeTokens: 1_800_000_000,
    peakDailyTokens: 88_600_000,
    longestTaskDurationMs: 4_260_000,
    currentStreakDays: 3,
    longestStreakDays: 9,
    recordedSince: Date.UTC(2026, 0, 2)
  },
  activity: {
    fastModeUsagePercent: 2,
    mostUsedReasoningMode: 'extra_high',
    skillsExplored: 24,
    totalSkillInvocations: 86,
    totalTasks: 531,
    successfulTasks: 497,
    failedTasks: 34,
    averageTaskDurationMs: 92_000
  },
  models: [
    { providerId: 'ollama', model: 'qwen3-coder:30b', location: 'local', runs: 40, successfulRuns: 37, failedRuns: 3, totalTokens: 340_000, totalDurationMs: 70_000 },
    { providerId: 'openai', model: 'codex-1', location: 'cloud', runs: 33, successfulRuns: 31, failedRuns: 2, totalTokens: 520_000, totalDurationMs: 112_000 },
    { providerId: 'remote', model: 'deepseek-coder', location: 'remote', nodeLabel: 'RTX workstation', runs: 21, successfulRuns: 18, failedRuns: 3, totalTokens: 290_000, totalDurationMs: 60_000 }
  ],
  plugins: [
    { pluginId: 'vercel', label: 'Vercel', icon: '▲', runs: 33, successfulRuns: 32, failedRuns: 1 },
    { pluginId: 'github', label: 'GitHub', icon: 'GH', runs: 14, successfulRuns: 14, failedRuns: 0 },
    { pluginId: 'unused', label: 'Unused plugin', runs: 0, successfulRuns: 0, failedRuns: 0 }
  ],
  tasks: [
    { taskType: 'code_edit', runs: 221, successfulRuns: 209, failedRuns: 12, totalTokens: 680_000, totalDurationMs: 460_000 },
    { taskType: 'debugging', runs: 80, successfulRuns: 72, failedRuns: 8, totalTokens: 210_000, totalDurationMs: 190_000 }
  ]
}

function heatmap(mode: DashboardHeatmapMode): DashboardHeatmapView {
  const cells = mode === 'cumulative'
    ? [{ key: '2026-07', label: 'Jul', startDay: '2026-07-01', endDay: '2026-07-31', tokens: 9000, tasks: 7, primaryModel: 'codex-1', intensity: 4 as const }]
    : [
        { key: `${mode}-1`, label: 'Jul 11', startDay: '2026-07-11', endDay: mode === 'weekly' ? '2026-07-17' : '2026-07-11', tokens: 1200, tasks: 2, primaryModel: 'qwen3-coder:30b', intensity: 2 as const },
        { key: `${mode}-2`, label: 'Jul 12', startDay: '2026-07-12', endDay: mode === 'weekly' ? '2026-07-24' : '2026-07-12', tokens: 4100, tasks: 5, primaryModel: 'codex-1', intensity: 4 as const }
      ]
  return { mode, startDay: '2026-07-01', endDay: '2026-07-31', cells }
}

function api(overrides: Partial<DashboardTelemetryApi> = {}): DashboardTelemetryApi {
  return {
    loadOverview: vi.fn().mockResolvedValue(overview),
    loadHeatmap: vi.fn(async (mode: DashboardHeatmapMode) => heatmap(mode)),
    loadGpuSnapshot: vi.fn().mockResolvedValue({
      status: 'observed', observedAt: Date.UTC(2026, 6, 12, 19, 0), warnings: [],
      devices: [{ id: 'gpu-0', nodeId: 'node-3090', nodeLabel: 'RTX workstation', location: 'remote', name: 'NVIDIA GeForce RTX 3090', utilizationPercent: 76, memoryUsedMb: 18_432, memoryTotalMb: 24_576, temperatureC: 68, powerWatts: 286, activeModel: 'qwen3-coder:30b', processName: 'ollama.exe' }]
    }),
    ...overrides
  }
}

describe('TelemetryDashboardPage', () => {
  it('states honestly when the secure dashboard bridge is unavailable', () => {
    render(<TelemetryDashboardPage api={null} gpuPollIntervalMs={0} />)

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByText(/telemetry service is not available/i)).toBeInTheDocument()
    expect(screen.getByText(/No sample metrics are shown/i)).toBeInTheDocument()
  })

  it('renders persisted summary, insight, model, plugin, heatmap, and live GPU values', async () => {
    render(<TelemetryDashboardPage api={api()} gpuPollIntervalMs={0} />)

    expect(await screen.findByText('1.8B')).toBeInTheDocument()
    expect(screen.getByText('88.6M')).toBeInTheDocument()
    expect(screen.getByText('1h 11m')).toBeInTheDocument()
    expect(screen.getByTitle(/Total recorded input and output tokens/)).toHaveTextContent('Lifetime tokens')
    expect(screen.getByText('extra high')).toBeInTheDocument()
    expect(screen.getAllByText('qwen3-coder:30b').length).toBeGreaterThan(0)
    expect(screen.getByText('Vercel')).toBeInTheDocument()
    expect(screen.queryByText('Unused plugin')).not.toBeInTheDocument()

    expect(await screen.findByRole('button', { name: /2026-07-11: 1,200 tokens, 2 tasks/ })).toHaveAttribute('title', expect.stringContaining('Primary model: qwen3-coder:30b'))
    const gpu = screen.getByRole('article', { name: 'NVIDIA GeForce RTX 3090' })
    expect(within(gpu).getByText('18.0 GB / 24.0 GB')).toBeInTheDocument()
    expect(within(gpu).getByText('qwen3-coder:30b')).toBeInTheDocument()
    expect(within(gpu).getByRole('meter', { name: 'GPU utilization' })).toHaveAttribute('aria-valuenow', '76')
  })

  it('requests persisted weekly and cumulative views from the API', async () => {
    const service = api()
    const user = userEvent.setup()
    render(<TelemetryDashboardPage api={service} gpuPollIntervalMs={0} />)
    await screen.findByText('1.8B')

    await user.click(screen.getByRole('tab', { name: 'Weekly' }))
    await waitFor(() => expect(service.loadHeatmap).toHaveBeenCalledWith('weekly'))
    expect(screen.getByRole('tab', { name: 'Weekly' })).toHaveAttribute('aria-selected', 'true')

    await user.click(screen.getByRole('tab', { name: 'Cumulative' }))
    await waitFor(() => expect(service.loadHeatmap).toHaveBeenCalledWith('cumulative'))
    expect(await screen.findByText('Jul')).toBeInTheDocument()
  })

  it('shows measured empty and unsupported-GPU states without synthesizing activity', async () => {
    const emptyOverview: DashboardOverview = {
      summary: { lifetimeTokens: 0, peakDailyTokens: 0, longestTaskDurationMs: null, currentStreakDays: 0, longestStreakDays: 0, recordedSince: null },
      activity: { fastModeUsagePercent: null, mostUsedReasoningMode: null, skillsExplored: 0, totalSkillInvocations: 0, totalTasks: 0, successfulTasks: 0, failedTasks: 0, averageTaskDurationMs: null },
      models: [], plugins: [], tasks: []
    }
    render(<TelemetryDashboardPage api={api({
      loadOverview: vi.fn().mockResolvedValue(emptyOverview),
      loadHeatmap: vi.fn(async (mode: DashboardHeatmapMode) => ({ ...heatmap(mode), cells: [] })),
      loadGpuSnapshot: vi.fn().mockResolvedValue({ status: 'unsupported', observedAt: Date.now(), reason: 'No supported GPU adapter was detected on this device.', devices: [], warnings: [] })
    })} gpuPollIntervalMs={0} />)

    expect(await screen.findByText('No recorded activity yet')).toBeInTheDocument()
    expect(screen.getByText('No token activity has been recorded for this range.')).toBeInTheDocument()
    expect(screen.getByText('No supported GPU adapter was detected on this device.')).toBeInTheDocument()
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
  })

  it('offers a retry when the core telemetry read fails', async () => {
    const loadOverview = vi.fn()
      .mockRejectedValueOnce(new Error('Database temporarily busy'))
      .mockResolvedValueOnce(overview)
    const user = userEvent.setup()
    render(<TelemetryDashboardPage api={api({ loadOverview })} gpuPollIntervalMs={0} />)

    expect(await screen.findByText('Database temporarily busy')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('1.8B')).toBeInTheDocument()
    expect(loadOverview).toHaveBeenCalledTimes(2)
  })
})
