import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AutonomousLoopApi,
  AutonomousLoopDetail,
  AutonomousLoopRecord,
  CatalogDiscoveryView,
  CatalogModelView,
  CreateAutonomousLoopInput
} from '../../src/preload/index.d'
import AutonomousLoopPage, { modelIsFreshAndEligible } from '../../src/renderer/src/components/AutonomousLoopPage'

const capabilityNames = [
  'file_read', 'file_edit', 'file_create', 'file_delete', 'command_execution', 'tool_use',
  'multi_file_reasoning', 'code_generation', 'test_execution', 'debugging', 'iterative_repair', 'streaming_status'
]

function loop(overrides: Partial<AutonomousLoopRecord> = {}): AutonomousLoopRecord {
  return {
    id: 'loop-1',
    projectName: 'Atlas',
    status: 'running',
    stage: 'validating',
    repositoryId: 'github.com/example/atlas',
    workspacePath: 'C:\\Projects\\Atlas',
    remoteUrl: 'https://github.com/example/atlas.git',
    branch: 'main',
    executor: { catalogId: 'ollama:coder', providerId: 'ollama', model: 'coder:14b', location: 'local', capabilityProbeId: 'probe-1' },
    planner: { catalogId: 'akorith:evidence-planner', providerId: 'akorith', model: 'evidence-planner', location: 'local' },
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    startedAt: Date.now() - 50_000,
    stoppedAt: null,
    lastActivityAt: Date.now() - 1_000,
    nextCycleAt: Date.now() + 60_000,
    tokenUsage: { input: 1200, output: 340, cached: 60, costUsd: 0 },
    commitCount: 3,
    pushCount: 2,
    successfulTasks: 2,
    failedTasks: 0,
    stopReason: null,
    error: null,
    ...overrides
  }
}

function model(overrides: Partial<CatalogModelView> = {}): CatalogModelView {
  const verifiedAt = Date.now() - 1_000
  return {
    id: 'ollama:coder',
    providerId: 'ollama',
    providerLabel: 'Ollama',
    source: 'local',
    modelName: 'coder:14b',
    displayLabel: 'Coder 14B',
    nodeId: 'this-device',
    nodeName: 'This device',
    availability: { status: 'available', reason: null },
    contextWindowTokens: 32_768,
    quantization: 'Q4_K_M',
    vramRequirementMb: 10_240,
    currentLoadPercent: 37,
    pingMs: 5,
    effectiveCapabilities: Object.fromEntries(capabilityNames.map((name) => [name, { support: 'supported', source: 'probe', verifiedAt }])),
    latestProbe: { id: 'probe-1', status: 'succeeded', freshUntil: Date.now() + 3_600_000 },
    ...overrides
  }
}

function catalog(models: CatalogModelView[]): CatalogDiscoveryView {
  return { catalog: { generatedAt: Date.now(), models, collisions: [] }, warnings: [] }
}

function api(overrides: Partial<AutonomousLoopApi> = {}): AutonomousLoopApi {
  return {
    list: vi.fn(async () => []),
    detail: vi.fn(async () => null),
    catalog: vi.fn(async (_requestId: string) => ({ ok: true as const, value: catalog([]) })),
    probe: vi.fn(async (_requestId: string, _catalogModelId: string) => ({ ok: true as const, value: { id: 'probe-new', status: 'succeeded' } })),
    create: vi.fn(async (_requestId: string, _input: CreateAutonomousLoopInput) => ({ ok: true as const, value: { loop: loop(), plannerLabel: 'Evidence planner', remoteAccess: { canPush: true, message: 'Ready' }, initialIdentity: null } })),
    cancelRequest: vi.fn(async () => true),
    pause: vi.fn(async (_loopId: string) => ({ ok: true as const, value: loop({ status: 'paused' }) })),
    resume: vi.fn(async (_loopId: string) => ({ ok: true as const, value: loop({ status: 'running' }) })),
    stop: vi.fn(async (_loopId: string) => ({ ok: true as const, value: loop({ status: 'stopped' }) })),
    openRepository: vi.fn(async () => ({ ok: true })),
    openGitHub: vi.fn(async () => ({ ok: true })),
    onChanged: vi.fn(() => () => undefined),
    ...overrides
  }
}

function installApi(value: AutonomousLoopApi): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { autonomousLoop: value }
  })
}

beforeEach(() => installApi(api()))

describe('AutonomousLoopPage', () => {
  it('groups live records and wires only valid state actions', async () => {
    const pause = vi.fn(async () => ({ ok: true as const, value: loop({ status: 'paused' }) }))
    installApi(api({
      list: vi.fn(async () => [
        loop(),
        loop({ id: 'loop-2', projectName: 'Beacon', status: 'paused', stage: 'idle' }),
        loop({ id: 'loop-3', projectName: 'Comet', status: 'completed', stage: 'idle' })
      ]),
      pause
    }))
    const user = userEvent.setup()
    render(<AutonomousLoopPage active />)

    expect(await screen.findByRole('heading', { name: 'Active' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Paused' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument()
    const atlas = screen.getByRole('article', { name: 'Atlas' })
    expect(within(atlas).getByText('3')).toBeInTheDocument()
    expect(within(atlas).getByText('coder:14b')).toBeInTheDocument()
    expect(within(atlas).getByText('Validating')).toBeInTheDocument()

    await user.click(within(atlas).getByRole('button', { name: 'Pause' }))
    expect(pause).toHaveBeenCalledWith('loop-1')
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'Atlas' })).getByRole('button', { name: 'Resume' })).toBeInTheDocument())
    expect(within(screen.getByRole('article', { name: 'Atlas' })).queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
  })

  it('keeps setup to source, executor, and review while selecting only fresh probe-verified models', async () => {
    const eligible = model()
    const stale = model({ id: 'ollama:stale', modelName: 'stale:7b', displayLabel: 'Stale 7B', latestProbe: { id: 'probe-stale', status: 'succeeded', freshUntil: Date.now() - 1 } })
    const create = vi.fn(async (_requestId: string, _input: CreateAutonomousLoopInput) => ({ ok: true as const, value: { loop: loop(), plannerLabel: 'Evidence planner', remoteAccess: { canPush: true, message: 'Ready' }, initialIdentity: null } }))
    installApi(api({ catalog: vi.fn(async (_requestId: string) => ({ ok: true as const, value: catalog([eligible, stale]) })), create }))
    const user = userEvent.setup()
    render(<AutonomousLoopPage active />)

    await user.click(await screen.findByRole('button', { name: 'Create Loop' }))
    expect(screen.getByRole('dialog', { name: 'Create Loop' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/task/i)).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Parent folder'), 'C:\\Projects')
    await user.type(screen.getByLabelText('Project name'), 'Atlas')
    await user.type(screen.getByLabelText('GitHub remote URL'), 'https://github.com/example/atlas.git')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Coder 14B')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Coder 14B/ })).toBeEnabled()
    expect(screen.getByRole('radio', { name: /Stale 7B/ })).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: /Coder 14B/ }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByRole('heading', { name: 'Review and start' })).toBeInTheDocument()
    expect(screen.getByText(/There is no task prompt/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start Loop' }))
    await waitFor(() => expect(create).toHaveBeenCalledOnce())
    const input = create.mock.calls[0][1]
    expect(input.source).toMatchObject({ kind: 'new', projectName: 'Atlas' })
    expect(input.executor).toMatchObject({ catalogId: 'ollama:coder', capabilityProbeId: 'probe-1' })
  })

  it('renders persistent cycle evidence and opens real repository destinations', async () => {
    const record = loop()
    const detailValue: AutonomousLoopDetail = {
      loop: record,
      cycles: [{
        id: 'cycle-1', index: 1, status: 'completed', stage: 'pushing',
        plannedTask: { title: 'Improve parser', reason: 'A failing fixture identifies a bounded defect.', kind: 'repair', acceptanceCriteria: ['Regression test passes'] },
        repairAttempts: 1, startedAt: Date.now() - 10_000, finishedAt: Date.now(), durationMs: 10_000,
        changedFiles: ['src/parser.ts', 'tests/parser.test.ts'], commitSha: 'abc123def456', commitMessage: 'fix: improve parser', pushed: true,
        summary: 'Parser and regression fixture passed.', error: null
      }],
      events: [{
        id: 'event-1', loopId: record.id, cycleId: 'cycle-1', occurredAt: Date.now(), stage: 'validating', level: 'success',
        kind: 'validation_completed', title: 'Validation passed', summary: 'Typecheck and focused tests passed.', details: { commands: 2 }
      }]
    }
    const detail = vi.fn(async (_loopId: string) => detailValue)
    const openRepository = vi.fn(async () => ({ ok: true }))
    const openGitHub = vi.fn(async () => ({ ok: true }))
    installApi(api({ list: vi.fn(async () => [record]), detail, openRepository, openGitHub }))
    const user = userEvent.setup()
    render(<AutonomousLoopPage active />)

    await user.click(await screen.findByRole('button', { name: 'Atlas' }))
    expect(await screen.findByRole('heading', { name: 'Atlas' })).toBeInTheDocument()
    expect(screen.getByText('Validation passed')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Improve parser' })).toBeInTheDocument()
    expect(screen.getByText('abc123de')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open repository' }))
    await user.click(screen.getByRole('button', { name: 'Open GitHub' }))
    expect(openRepository).toHaveBeenCalledWith('loop-1')
    expect(openGitHub).toHaveBeenCalledWith('loop-1')
  })

  it('runs capability probes and refreshes discovery evidence', async () => {
    const unprobed = model({ latestProbe: null, effectiveCapabilities: {} })
    const catalogCall = vi.fn<AutonomousLoopApi['catalog']>()
      .mockResolvedValueOnce({ ok: true, value: catalog([unprobed]) })
      .mockResolvedValue({ ok: true, value: catalog([model()]) })
    const probe = vi.fn(async () => ({ ok: true as const, value: { id: 'probe-1', status: 'succeeded' } }))
    installApi(api({ catalog: catalogCall, probe }))
    const user = userEvent.setup()
    render(<AutonomousLoopPage active />)

    await user.click(await screen.findByRole('button', { name: 'Create Loop' }))
    await user.type(screen.getByLabelText('Parent folder'), 'C:\\Projects')
    await user.type(screen.getByLabelText('Project name'), 'Atlas')
    await user.type(screen.getByLabelText('GitHub remote URL'), 'https://github.com/example/atlas.git')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(await screen.findByRole('button', { name: 'Run capability probe' }))

    await waitFor(() => expect(probe).toHaveBeenCalledWith(expect.stringMatching(/^probe-/), 'ollama:coder'))
    await waitFor(() => expect(catalogCall).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Probe verified')).toBeInTheDocument()
  })
})

describe('modelIsFreshAndEligible', () => {
  it('rejects stale or declaration-only capability evidence', () => {
    expect(modelIsFreshAndEligible(model())).toBe(true)
    expect(modelIsFreshAndEligible(model({ latestProbe: { id: 'old', status: 'succeeded', freshUntil: Date.now() - 1 } }))).toBe(false)
    expect(modelIsFreshAndEligible(model({ effectiveCapabilities: { file_read: { support: 'supported', source: 'provider', verifiedAt: null } } }))).toBe(false)
  })
})
