import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import BenchmarkLabPage, {
  BENCHMARK_CATEGORIES,
  type BenchmarkCatalog,
  type BenchmarkLabApi,
  type BenchmarkRun
} from '../../src/renderer/src/components/BenchmarkLabPage'

const catalog: BenchmarkCatalog = {
  suites: [
    {
      id: 'core-v1',
      label: 'Core engineering v1',
      description: 'Versioned offline engineering cases.',
      categoryIds: BENCHMARK_CATEGORIES.map((category) => category.id)
    }
  ],
  models: [
    { id: 'local-a', label: 'Local A', providerLabel: 'Local node', available: true },
    { id: 'remote-b', label: 'Remote B', providerLabel: 'Remote node', available: true },
    { id: 'offline-c', label: 'Offline C', providerLabel: 'Remote node', available: false, unavailableReason: 'Node offline' }
  ]
}

const completedRun: BenchmarkRun = {
  id: 'run-1',
  status: 'completed',
  createdAt: Date.UTC(2026, 6, 12, 16, 30),
  completedAt: Date.UTC(2026, 6, 12, 16, 34),
  setup: { suiteId: 'core-v1', modelIds: ['local-a', 'remote-b'], seed: 42, repetitions: 3 },
  results: [
    {
      modelId: 'local-a',
      modelLabel: 'Local A',
      rank: 1,
      qualityScore: 91.4,
      speedTokensPerSecond: 78.2,
      totalTokens: 14_220,
      costUsd: 0,
      hardwareUtilizationPct: 82,
      categoryScores: {
        'repo-repair': 94,
        'multi-language': 89,
        'code-generation': 92,
        debugging: 91,
        'repo-understanding': 93,
        'tool-agent': 88,
        'long-context': 90,
        'akorith-fixtures': 94
      },
      evidence: [
        {
          id: 'case-1',
          categoryId: 'repo-repair',
          caseName: 'Repair a failing migration',
          status: 'passed',
          qualityScore: 94,
          durationMs: 2_450,
          promptTokens: 800,
          completionTokens: 320,
          costUsd: 0,
          hardwareLabel: 'RTX 3090 · 82%',
          summary: 'Patch applied and validation passed.'
        }
      ]
    },
    {
      modelId: 'remote-b',
      modelLabel: 'Remote B',
      rank: 2,
      qualityScore: 86,
      speedTokensPerSecond: 44,
      totalTokens: 17_100,
      costUsd: null,
      hardwareUtilizationPct: null,
      categoryScores: { 'repo-repair': 85 },
      evidence: []
    }
  ],
  recommendations: [
    { id: 'fit-1', useCase: 'Repository repair', modelLabel: 'Local A', rationale: 'Highest verified repair score in this run.' }
  ]
}

function api(overrides: Partial<BenchmarkLabApi> = {}): BenchmarkLabApi {
  return {
    getCatalog: vi.fn().mockResolvedValue(catalog),
    listRuns: vi.fn().mockResolvedValue([]),
    start: vi.fn().mockResolvedValue({ ...completedRun, id: 'new-run', status: 'running', results: [], recommendations: [] }),
    cancel: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

describe('BenchmarkLabPage', () => {
  it('states honestly when the production service is unavailable', () => {
    render(<BenchmarkLabPage />)

    expect(screen.getByRole('heading', { name: 'Benchmark' })).toBeInTheDocument()
    expect(screen.getByText(/service is not available/i)).toBeInTheDocument()
    expect(screen.getByText(/no results have been generated/i)).toBeInTheDocument()
  })

  it('configures and starts a reproducible multi-model run', async () => {
    const service = api()
    const user = userEvent.setup()
    render(<BenchmarkLabPage api={service} />)

    await screen.findByRole('option', { name: 'Core engineering v1' })
    expect(screen.getByRole('checkbox', { name: /Offline C/ })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /Local A/ }))
    await user.click(screen.getByRole('checkbox', { name: /Remote B/ }))
    await user.clear(screen.getByRole('spinbutton', { name: /^Seed/ }))
    await user.type(screen.getByRole('spinbutton', { name: /^Seed/ }), '109')
    await user.clear(screen.getByRole('spinbutton', { name: /^Repetitions/ }))
    await user.type(screen.getByRole('spinbutton', { name: /^Repetitions/ }), '5')
    await user.click(screen.getByRole('button', { name: 'Start benchmark' }))

    await waitFor(() => {
      expect(service.start).toHaveBeenCalledWith({ suiteId: 'core-v1', modelIds: ['local-a', 'remote-b'], seed: 109, repetitions: 5 })
    })
    expect(await screen.findByRole('button', { name: 'Cancel active run' })).toBeEnabled()
  })

  it('renders measured charts, rankings, recommendations, and secondary evidence', async () => {
    const service = api({ listRuns: vi.fn().mockResolvedValue([completedRun]) })
    const user = userEvent.setup()
    render(<BenchmarkLabPage api={service} />)

    expect(await screen.findByText('91.4 / 100')).toBeInTheDocument()
    const categoryRegion = screen.getByRole('heading', { name: 'Category overview' }).closest('section')
    expect(categoryRegion).not.toBeNull()
    for (const category of BENCHMARK_CATEGORIES) expect(within(categoryRegion!).getByText(category.label)).toBeInTheDocument()

    expect(screen.getAllByRole('meter', { name: 'Quality' })[0]).toHaveAttribute('aria-valuenow', '91.4')
    const ranking = screen.getByRole('heading', { name: 'Ranking' }).closest('section')
    expect(within(ranking!).getByText('Local A')).toBeInTheDocument()
    expect(screen.getByText('Highest verified repair score in this run.')).toBeInTheDocument()

    await user.click(screen.getByText(/Inspect evidence/))
    expect(screen.getByRole('table', { name: /Secondary benchmark evidence/ })).toBeInTheDocument()
    expect(screen.getByText('Repair a failing migration')).toBeInTheDocument()
    expect(screen.getByText('Patch applied and validation passed.')).toBeInTheDocument()
  })

  it('shows an honest empty result state without synthesizing measurements', async () => {
    render(<BenchmarkLabPage api={api()} />)

    expect(await screen.findByText('No benchmark results yet')).toBeInTheDocument()
    expect(screen.getAllByText('Not measured')).toHaveLength(BENCHMARK_CATEGORIES.length)
    expect(screen.queryByText(/tok\/s/)).not.toBeInTheDocument()
  })
})
