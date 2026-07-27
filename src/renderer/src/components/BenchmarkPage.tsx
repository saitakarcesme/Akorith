import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BenchmarkCategory,
  BenchmarkEntry,
  BenchmarkMediaType,
  BenchmarkRun,
  BenchmarkUpdateRunItemInput,
  ProjectRow,
  ProviderInfo,
  TestDetection,
  TestRepoContext,
  TestRunRow
} from '../../../preload/index.d'
import { useDocumentVisible } from '../documentVisibility'
import {
  canonicalTokenTotal,
  estimateRunDuration,
  runBoundedBenchmarkQueue
} from '../benchmark-core'
import BenchmarkExperience, {
  type BenchmarkChallengeView,
  type BenchmarkLibraryView,
  type BenchmarkModelGroupView,
  type BenchmarkQueueView,
  type BenchmarkRecentRunView,
  type BenchmarkResultView,
  type BenchmarkSettingsView
} from './BenchmarkExperience'

interface BenchmarkPageProps {
  active: boolean
  activeProject: ProjectRow | null
}

type ChallengeMetric = 'tests' | 'latency' | 'efficiency' | 'artifact'

interface BenchmarkChallenge {
  id: string
  label: string
  description: string
  category: BenchmarkCategory
  metric: ChallengeMetric
  metricLabel: string
  prompt?: string
  focus?: string
  deliverables?: string[]
  mediaType?: BenchmarkMediaType
}

interface ModelOption {
  key: string
  providerId: string
  providerLabel: string
  model: string
  available: boolean
  reason?: string
}

interface RunResult {
  key: string
  providerId: string
  providerLabel: string
  requestedModel: string
  run?: TestRunRow
  error?: string
  cancelled?: boolean
}

interface QueueItem {
  id: string
  modelKey: string
  providerId: string
  providerLabel: string
  modelLabel: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  detail?: string
  startedAt?: number
  endedAt?: number
  error?: string
}

interface RepoRunContext {
  sourcePath: string
  detection: TestDetection
  context: TestRepoContext | null
}

interface RankedResult {
  result: RunResult
  rank: number | null
  score: number | null
}

const PROVIDER_ORDER = ['local', 'chatgpt', 'claude', 'opencode']
const SETTINGS_KEY = 'akorith.benchmark.settings.v2'
const MODELS_KEY = 'akorith.benchmark.models.v2'
const CHALLENGE_KEY = 'akorith.benchmark.challenge.v2'

const CHALLENGES: BenchmarkChallenge[] = [
  {
    id: 'speed',
    label: 'Coding speed',
    description: 'A fixed TypeScript implementation task ranked by sustained throughput and total time.',
    category: 'general',
    metric: 'latency',
    metricLabel: 'Tokens per second',
    prompt:
      'Write a self-contained TypeScript function `debounce(fn, waitMs)` that delays calling `fn` until `waitMs` has elapsed since the last call, cancels the pending call on each new call, preserves `this` and arguments, and includes a concise explanation.',
    deliverables: ['TypeScript implementation', 'Cancellation behavior', 'Context and argument preservation']
  },
  {
    id: 'token-efficiency',
    label: 'Token efficiency',
    description: 'The same compact coding task for every model, ranked by the leanest complete answer.',
    category: 'general',
    metric: 'efficiency',
    metricLabel: 'Total tokens',
    prompt:
      'Implement `parseEnvFlag(value)` in TypeScript. Accept booleans, numbers, and strings; map true/1/yes/on/enabled to true, false/0/no/off/disabled/empty to false, return null for unknown values, and include five compact examples.',
    deliverables: ['TypeScript implementation', 'Boolean and null behavior', 'Five examples']
  },
  {
    id: 'instruction-following',
    label: 'Instruction following',
    description: 'Measures whether a model can satisfy a precise multi-part engineering brief without omitting constraints.',
    category: 'general',
    metric: 'artifact',
    metricLabel: 'Rubric coverage',
    prompt:
      'Design a small offline-first task tracker. Return exactly these sections: Architecture, File tree, TypeScript interfaces, Two React components, Persistence, Accessibility, and Validation commands. Keep it implementable in one sitting.',
    deliverables: ['Architecture', 'File tree', 'Interfaces', 'Components', 'Persistence', 'Accessibility', 'Validation']
  },
  {
    id: 'backend-api',
    label: 'Backend coding',
    description: 'Compares API design, validation, persistence, failure handling, and focused test coverage.',
    category: 'general',
    metric: 'artifact',
    metricLabel: 'Engineering rubric',
    prompt:
      'Design a Node/TypeScript endpoint `POST /runs` for storing local benchmark runs. Include request and response schemas, validation rules, persistence model, handler pseudocode, error paths, and six focused tests.',
    deliverables: ['Schemas', 'Validation', 'Persistence', 'Handler', 'Error paths', 'Six tests'],
    mediaType: 'artifact'
  },
  {
    id: 'research-brief',
    label: 'Research synthesis',
    description: 'Tests source planning, claim discipline, uncertainty handling, and concise synthesis structure.',
    category: 'general',
    metric: 'artifact',
    metricLabel: 'Research rubric',
    prompt:
      'Create a research plan for comparing local LLM inference runtimes. Include scope, primary-source strategy, measurable criteria, evidence table schema, uncertainty rules, and a concise final-report outline. Do not invent findings.',
    deliverables: ['Scope', 'Source strategy', 'Criteria', 'Evidence schema', 'Uncertainty rules', 'Report outline']
  },
  {
    id: 'ui-system',
    label: 'UI product design',
    description: 'Compares concrete desktop/mobile structure, states, accessibility, and visual regression planning.',
    category: 'ui',
    metric: 'artifact',
    metricLabel: 'Product UI rubric',
    prompt:
      'Design a desktop and mobile benchmark screen for an AI developer tool. Include information hierarchy, component states, keyboard behavior, accessibility checks, responsive rules, and a Playwright screenshot checklist.',
    deliverables: ['Desktop layout', 'Mobile layout', 'States', 'Keyboard behavior', 'Accessibility', 'Screenshot checklist'],
    mediaType: 'image'
  },
  {
    id: 'agentic-task',
    label: 'Agentic task plan',
    description: 'Evaluates decomposition, safety boundaries, validation, recovery, and completion evidence.',
    category: 'general',
    metric: 'artifact',
    metricLabel: 'Execution-plan rubric',
    prompt:
      'Plan an autonomous coding-agent run that upgrades a React application dependency safely. Include discovery, compatibility analysis, bounded edits, verification, rollback triggers, evidence, and stop conditions.',
    deliverables: ['Discovery', 'Compatibility', 'Bounded edits', 'Verification', 'Rollback', 'Evidence', 'Stop conditions']
  },
  {
    id: 'repo-regression',
    label: 'Repository regression tests',
    description: 'Generates focused tests from a real repository and executes them in Akorith’s disposable sandbox.',
    category: 'repo',
    metric: 'tests',
    metricLabel: 'Tests passed',
    focus:
      'Find likely regressions and fragile logic. Write focused tests against real exported behavior, with correct imports and deterministic assertions.',
    deliverables: ['Real imports', 'Deterministic assertions', 'Runnable tests']
  }
]

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function modelKey(providerId: string, model: string): string {
  return `${providerId}::${model || 'default'}`
}

function providerSort(providerId: string): number {
  const index = PROVIDER_ORDER.indexOf(providerId)
  return index === -1 ? PROVIDER_ORDER.length : index
}

function providerLabel(provider: ProviderInfo): string {
  return provider.id === 'chatgpt' ? 'Codex CLI' : provider.label
}

function isLocalStarting(provider: ProviderInfo): boolean {
  return provider.id === 'local' &&
    !provider.available.ok &&
    /Akorith (is starting Ollama|tried to auto-start it)/i.test(provider.available.reason ?? '')
}

function loadSettings(): BenchmarkSettingsView {
  const fallback: BenchmarkSettingsView = {
    maxTokens: 4096,
    temperature: 0.2,
    timeoutMs: 60_000,
    parallel: false
  }
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '') as Partial<BenchmarkSettingsView>
    return {
      maxTokens: typeof stored.maxTokens === 'number' ? Math.min(1_000_000, Math.max(64, stored.maxTokens)) : fallback.maxTokens,
      temperature: typeof stored.temperature === 'number' ? Math.min(2, Math.max(0, stored.temperature)) : fallback.temperature,
      timeoutMs: typeof stored.timeoutMs === 'number' ? Math.min(1_800_000, Math.max(1_000, stored.timeoutMs)) : fallback.timeoutMs,
      parallel: stored.parallel === true
    }
  } catch {
    return fallback
  }
}

function loadStringArray(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function extractCode(text: string): string | null {
  const match = text.match(/```[^\n`]*\n([\s\S]*?)```/)
  return match ? match[1].replace(/\n$/, '') : null
}

function artifactScore(run: TestRunRow, challenge: BenchmarkChallenge): number {
  const text = (run.rawOutput ?? '').toLowerCase()
  if (!text.trim()) return 0
  const deliverables = challenge.deliverables ?? []
  const coverage = deliverables.length === 0
    ? 0
    : deliverables.filter((item) => {
        const meaningfulWords = item.toLowerCase().split(/\W+/).filter((word) => word.length >= 4)
        return meaningfulWords.some((word) => text.includes(word))
      }).length / deliverables.length
  const structureSignals = ['```', 'test', 'valid', 'command', 'interface', 'schema', 'state', 'risk']
  const structure = structureSignals.filter((signal) => text.includes(signal)).length / structureSignals.length
  const lengthDiscipline = Math.min(1, Math.max(0.2, 2400 / Math.max(run.tokens ?? 2400, 1)))
  return Math.round(Math.min(100, coverage * 65 + structure * 25 + lengthDiscipline * 10))
}

function testScore(run: TestRunRow): number {
  const passed = run.passed ?? 0
  const failed = run.failed ?? 0
  const errored = run.errored ?? 0
  const total = passed + failed + errored
  if (total === 0 || ['error', 'install-failed', 'aborted', 'timeout'].includes(run.status ?? '')) return 0
  const volume = Math.min(1, Math.log10(1 + total) / Math.log10(11))
  return Math.round((passed / total) * 90 + volume * 10)
}

function rankResults(results: RunResult[], challenge: BenchmarkChallenge): RankedResult[] {
  const finished = results.filter((result): result is RunResult & { run: TestRunRow } => Boolean(result.run))
  const values = finished.map((result) => {
    const run = result.run
    let raw = challenge.metric === 'tests' ? testScore(run) : challenge.metric === 'artifact' ? artifactScore(run, challenge) : 0
    return { result, raw }
  })
  if (challenge.metric === 'latency') {
    const throughputs = values.map((item) => {
      const seconds = Math.max((item.result.run!.durationMs ?? 0) / 1000, 0)
      return seconds > 0 ? (item.result.run!.tokens ?? 0) / seconds : 0
    })
    const best = Math.max(1, ...throughputs)
    values.forEach((item, index) => {
      item.raw = Math.round((throughputs[index] / best) * 100)
    })
  }
  if (challenge.metric === 'efficiency') {
    const tokenCounts = values.map((item) => item.result.run!.tokens ?? 0)
    const minimum = Math.min(...tokenCounts.filter((tokens) => tokens > 0), Number.POSITIVE_INFINITY)
    values.forEach((item, index) => {
      item.raw = tokenCounts[index] > 0 && Number.isFinite(minimum)
        ? Math.round((minimum / tokenCounts[index]) * 100)
        : 0
    })
  }
  values.sort((left, right) =>
    right.raw - left.raw ||
    (left.result.run!.durationMs ?? Number.MAX_SAFE_INTEGER) - (right.result.run!.durationMs ?? Number.MAX_SAFE_INTEGER)
  )
  const ranked = new Map(values.map((item, index) => [item.result.key, { rank: index + 1, score: item.raw }]))
  return results.map((result) => ({
    result,
    rank: ranked.get(result.key)?.rank ?? null,
    score: ranked.get(result.key)?.score ?? null
  }))
}

function primaryMetric(run: TestRunRow, challenge: BenchmarkChallenge): { label: string; value: string } {
  if (challenge.metric === 'tests') {
    const passed = run.passed ?? 0
    const total = passed + (run.failed ?? 0) + (run.errored ?? 0)
    return { label: 'tests passed', value: total > 0 ? `${passed}/${total}` : 'No tests' }
  }
  if (challenge.metric === 'latency') {
    const seconds = (run.durationMs ?? 0) / 1000
    const throughput = seconds > 0 ? Math.round((run.tokens ?? 0) / seconds) : 0
    return { label: 'tokens/sec', value: String(throughput) }
  }
  if (challenge.metric === 'efficiency') return { label: 'total tokens', value: String(run.tokens ?? 0) }
  return { label: 'rubric coverage', value: 'Structured output' }
}

function runStatus(run: BenchmarkRun): BenchmarkRecentRunView['status'] {
  if (run.status === 'cancelled') return 'cancelled'
  if (run.status === 'failed') return 'failed'
  if (run.status === 'interrupted' || run.items.some((item) => item.status !== 'completed')) return 'partial'
  return 'completed'
}

export default function BenchmarkPage({ active, activeProject }: BenchmarkPageProps): JSX.Element {
  const documentVisible = useDocumentVisible()
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [selectedModelKeys, setSelectedModelKeys] = useState<string[]>(() => loadStringArray(MODELS_KEY))
  const [selectedChallengeId, setSelectedChallengeId] = useState(() => localStorage.getItem(CHALLENGE_KEY) ?? '')
  const [runSettings, setRunSettings] = useState<BenchmarkSettingsView>(loadSettings)
  const [sourceMode, setSourceMode] = useState<'folder' | 'github'>('folder')
  const [sourceRepo, setSourceRepo] = useState('')
  const [installDeps, setInstallDeps] = useState(true)
  const [detection, setDetection] = useState<TestDetection | null>(null)
  const [sourceNotice, setSourceNotice] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [results, setResults] = useState<RunResult[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [libraryEntries, setLibraryEntries] = useState<BenchmarkEntry[]>([])
  const [recentRuns, setRecentRuns] = useState<BenchmarkRun[]>([])
  const [clock, setClock] = useState(() => Date.now())

  const activeRequestIds = useRef(new Set<string>())
  const activeTestRunIds = useRef(new Set<string>())
  const batchController = useRef<AbortController | null>(null)
  const activeBatchId = useRef<string | null>(null)
  const stopRequested = useRef(false)

  const selectedChallenge = CHALLENGES.find((challenge) => challenge.id === selectedChallengeId) ?? null
  const requiresRepository = selectedChallenge?.metric === 'tests'

  const refreshProviders = useCallback(async (force = false) => {
    try {
      setProviders(await window.api.chat.listProviders(force))
    } catch {
      setProviders([])
    }
  }, [])

  const refreshHistory = useCallback(async () => {
    const [entries, runs] = await Promise.all([
      window.api.benchmark.list(160).catch(() => [] as BenchmarkEntry[]),
      window.api.benchmark.listRuns(8).catch(() => [] as BenchmarkRun[])
    ])
    setLibraryEntries(entries)
    setRecentRuns(runs)
  }, [])

  useEffect(() => {
    void refreshProviders()
    void refreshHistory()
    void window.api.projects.list().then(setProjects).catch(() => setProjects([]))
    void window.api.test.getSettings().then((settings) => {
      setInstallDeps(settings.installDeps)
      setRunSettings((current) => (
        localStorage.getItem(SETTINGS_KEY)
          ? current
          : { ...current, timeoutMs: settings.timeoutMs }
      ))
    })
  }, [refreshHistory, refreshProviders])

  useEffect(() => {
    if (!active) return
    void window.api.projects.list().then(setProjects).catch(() => setProjects([]))
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.benchmark-experience')?.scrollTo({ top: 0 })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active])

  useEffect(() => {
    if (!active || !providers.some(isLocalStarting)) return
    const timer = window.setTimeout(() => void refreshProviders(true), 3_000)
    return () => window.clearTimeout(timer)
  }, [active, providers, refreshProviders])

  useEffect(() => {
    if (!active || !running || !documentVisible) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active, documentVisible, running])

  useEffect(() => {
    if (activeProject?.path) setSourceRepo((current) => current || activeProject.path || '')
  }, [activeProject?.path])

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(runSettings))
  }, [runSettings])

  useEffect(() => {
    localStorage.setItem(MODELS_KEY, JSON.stringify(selectedModelKeys))
  }, [selectedModelKeys])

  useEffect(() => {
    if (selectedChallengeId) localStorage.setItem(CHALLENGE_KEY, selectedChallengeId)
    else localStorage.removeItem(CHALLENGE_KEY)
  }, [selectedChallengeId])

  const modelGroups = useMemo<BenchmarkModelGroupView[]>(() =>
    providers
      .filter((provider) => provider.kind.includes('chat'))
      .sort((left, right) => providerSort(left.id) - providerSort(right.id) || left.label.localeCompare(right.label))
      .map((provider) => {
        const available = provider.available.ok || isLocalStarting(provider)
        const models = provider.models.length > 0 ? provider.models : ['default']
        return {
          id: provider.id,
          label: providerLabel(provider),
          available,
          reason: provider.available.reason,
          models: models.map((model) => ({
            key: modelKey(provider.id, model),
            label: model || 'default',
            available,
            reason: provider.available.reason
          }))
        }
      }), [providers])

  const modelOptions = useMemo<ModelOption[]>(() =>
    modelGroups.flatMap((group) => group.models.map((model) => ({
      key: model.key,
      providerId: group.id,
      providerLabel: group.label,
      model: model.label,
      available: group.available && model.available,
      reason: model.reason ?? group.reason
    }))), [modelGroups])

  const modelOptionsByKey = useMemo(
    () => new Map(modelOptions.map((option) => [option.key, option])),
    [modelOptions]
  )
  const selectedModels = useMemo(() =>
    selectedModelKeys
      .map((key) => modelOptionsByKey.get(key))
      .filter((option): option is ModelOption => Boolean(option)), [modelOptionsByKey, selectedModelKeys])

  useEffect(() => {
    const validKeys = new Set(modelOptions.filter((option) => option.available).map((option) => option.key))
    setSelectedModelKeys((current) => current.filter((key) => validKeys.has(key)))
  }, [modelOptions.map((option) => `${option.key}:${option.available ? 1 : 0}`).join('|')])

  const historyCountsByChallenge = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of libraryEntries) {
      counts.set(entry.challengeId, (counts.get(entry.challengeId) ?? 0) + 1)
    }
    return counts
  }, [libraryEntries])
  const challengeViews = useMemo<BenchmarkChallengeView[]>(() => CHALLENGES.map((challenge) => ({
    id: challenge.id,
    label: challenge.label,
    category: challenge.category === 'repo' ? 'Repository' : challenge.category === 'ui' ? 'UI' : 'General',
    description: challenge.description,
    metricLabel: challenge.metricLabel,
    deliverables: challenge.deliverables,
    requiresRepository: challenge.metric === 'tests',
    historicalRuns: historyCountsByChallenge.get(challenge.id) ?? 0
  })), [historyCountsByChallenge])

  const estimatedMs = useMemo(() => {
    if (!selectedChallenge) return null
    return estimateRunDuration(
      selectedModels.map((option) => option.key),
      libraryEntries
        .filter((entry) => entry.challengeId === selectedChallenge.id && entry.durationMs != null)
        .map((entry) => ({
          modelKey: modelKey(entry.providerId ?? 'unknown', entry.model),
          durationMs: entry.durationMs as number
        })),
      { parallel: runSettings.parallel, concurrency: 3 }
    ).totalMs
  }, [libraryEntries, runSettings.parallel, selectedChallenge, selectedModels])

  const validationMessage = useMemo(() => {
    if (selectedModels.some((model) => !model.available)) return 'One or more selected models are unavailable.'
    if (requiresRepository && !sourceRepo.trim()) return 'Choose a repository for this benchmark.'
    if (runSettings.maxTokens < 64 || runSettings.maxTokens > 1_000_000) return 'Max tokens must be between 64 and 1,000,000.'
    if (runSettings.temperature < 0 || runSettings.temperature > 2) return 'Temperature must be between 0 and 2.'
    if (runSettings.timeoutMs < 1_000 || runSettings.timeoutMs > 1_800_000) return 'Timeout must be between 1 and 1,800 seconds.'
    return error
  }, [error, requiresRepository, runSettings, selectedModels, sourceRepo])

  const patchQueue = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueue((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item))
  }, [])

  const persistQueueItem = useCallback(async (
    batchId: string,
    itemId: string,
    patch: Omit<BenchmarkUpdateRunItemInput, 'runId' | 'itemId'>
  ) => {
    try {
      await window.api.benchmark.updateRunItem({ ...patch, runId: batchId, itemId })
    } catch {
      // The benchmark result remains visible even if history persistence fails.
    }
  }, [])

  const chooseFolder = useCallback(async () => {
    setError(null)
    const result = await window.api.projects.pickDirectory()
    if (!result.ok) {
      if (!result.cancelled) setError(result.error)
      return
    }
    setSourceMode('folder')
    setSourceRepo(result.path)
    setDetection(null)
    setSourceNotice(null)
  }, [])

  const prepareRepository = useCallback(async (): Promise<RepoRunContext | null> => {
    setError(null)
    const input = sourceRepo.trim()
    if (!input) {
      setError('Choose a repository for this benchmark.')
      return null
    }
    let resolved: Awaited<ReturnType<typeof window.api.test.resolveSource>>
    try {
      resolved = await window.api.test.resolveSource(input)
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : String(resolveError))
      return null
    }
    if (!resolved.ok) {
      setError(resolved.error)
      return null
    }
    setSourceRepo(resolved.path)
    setSourceNotice(resolved.path === input ? null : `${resolved.cloned ? 'Cloned' : 'Using cached clone'} ${resolved.label}`)
    let detected: Awaited<ReturnType<typeof window.api.test.detect>>
    try {
      detected = await window.api.test.detect(resolved.path)
    } catch (detectError) {
      setError(detectError instanceof Error ? detectError.message : String(detectError))
      return null
    }
    if ('error' in detected) {
      setError(detected.error)
      return null
    }
    setDetection(detected)
    const contextResult = await window.api.test.context(resolved.path).catch(() => null)
    return {
      sourcePath: resolved.path,
      detection: detected,
      context: contextResult && !('error' in contextResult) ? contextResult : null
    }
  }, [sourceRepo])

  const challengePrompt = useCallback((challenge: BenchmarkChallenge, settings: BenchmarkSettingsView): string => {
    const deliverables = challenge.deliverables?.length
      ? `\n\nRequired deliverables:\n- ${challenge.deliverables.join('\n- ')}`
      : ''
    return `${challenge.prompt ?? ''}${deliverables}

Run constraints:
- Keep the response within ${settings.maxTokens} output tokens.
- Be concrete, implementation-ready, and easy to verify.
- Do not use paid APIs or invent completed validation.
- Do not mention the benchmark or compare yourself with other models.`
  }, [])

  const repositoryPrompt = useCallback((
    challenge: BenchmarkChallenge,
    repo: RepoRunContext,
    settings: BenchmarkSettingsView
  ): string => {
    const samples = repo.context?.samples
      .map((sample) => `--- FILE: ${sample.path} ---\n${sample.content}`)
      .join('\n\n') ?? ''
    const testPath = repo.detection.suggestedTestPath
    return `Generate one automated test file for this existing repository.

Framework: ${repo.detection.framework}
Focus: ${challenge.focus}
File path: ${testPath}
Test command: ${repo.detection.testCommand}
Maximum output: ${settings.maxTokens} tokens

Use exact imports and exported names from the real repository context. Write at least three deterministic tests with concrete assertions. Do not require network access or packages absent from the repository.

Repository tree:
${repo.context?.tree ?? '(tree unavailable)'}

${samples ? `Representative source files:\n${samples}\n` : ''}
Respond with only the complete test file in one fenced code block.`
  }, [])

  const executeModel = useCallback(async (
    option: ModelOption,
    queueItem: QueueItem,
    batchId: string,
    challenge: BenchmarkChallenge,
    settings: BenchmarkSettingsView,
    repo: RepoRunContext | null
  ): Promise<RunResult> => {
    const startedAt = Date.now()
    patchQueue(queueItem.id, { status: 'running', startedAt, detail: 'Starting model' })
    await persistQueueItem(batchId, queueItem.id, { status: 'running', phase: 'model' })
    if (stopRequested.current) {
      return { key: option.key, providerId: option.providerId, providerLabel: option.providerLabel, requestedModel: option.model, error: 'Cancelled', cancelled: true }
    }

    const requestId = newId()
    activeRequestIds.current.add(requestId)
    patchQueue(queueItem.id, { detail: repo ? 'Generating repository tests' : 'Generating response' })
    let response: Awaited<ReturnType<typeof window.api.chat.send>>
    try {
      response = await window.api.chat.send({
        requestId,
        providerId: option.providerId,
        model: option.model === 'default' ? undefined : option.model,
        prompt: repo ? repositoryPrompt(challenge, repo, settings) : challengePrompt(challenge, settings),
        generation: {
          maxTokens: settings.maxTokens,
          temperature: settings.temperature,
          timeoutMs: settings.timeoutMs
        },
        usageSource: { kind: 'benchmark', id: queueItem.id }
      })
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : String(sendError)
      const cancelled = stopRequested.current || /abort|cancel/i.test(message)
      return {
        key: option.key,
        providerId: option.providerId,
        providerLabel: option.providerLabel,
        requestedModel: option.model,
        error: cancelled ? 'Cancelled' : message,
        cancelled
      }
    } finally {
      activeRequestIds.current.delete(requestId)
    }

    if (!response.ok) {
      const cancelled = stopRequested.current || /abort|cancel/i.test(response.error)
      return {
        key: option.key,
        providerId: option.providerId,
        providerLabel: option.providerLabel,
        requestedModel: option.model,
        error: cancelled ? 'Cancelled' : response.error,
        cancelled
      }
    }

    const tokens = canonicalTokenTotal(response.result.usage)
    if (!repo) {
      let run: TestRunRow = {
        id: newId(),
        ts: Date.now(),
        sourceRepo: 'local-benchmark-preset',
        targetDesc: challenge.label,
        providerId: option.providerId,
        model: response.result.model,
        framework: challenge.metric,
        passed: null,
        failed: null,
        errored: null,
        durationMs: Date.now() - startedAt,
        exitCode: 0,
        tokens,
        attempts: 1,
        sandboxPath: null,
        generatedFiles: null,
        rawOutput: response.result.text,
        status: 'passed'
      }
      const persisted = await window.api.test.persistRun(run)
      if (persisted.ok) run = persisted.run
      return {
        key: option.key,
        providerId: option.providerId,
        providerLabel: option.providerLabel,
        requestedModel: option.model,
        run
      }
    }

    const code = extractCode(response.result.text)
    if (!code) {
      return {
        key: option.key,
        providerId: option.providerId,
        providerLabel: option.providerLabel,
        requestedModel: option.model,
        error: 'The model did not return a fenced test file.'
      }
    }
    if (stopRequested.current) {
      return { key: option.key, providerId: option.providerId, providerLabel: option.providerLabel, requestedModel: option.model, error: 'Cancelled', cancelled: true }
    }

    const testRunId = newId()
    activeTestRunIds.current.add(testRunId)
    patchQueue(queueItem.id, { detail: `Running ${repo.detection.framework} in sandbox` })
    await persistQueueItem(batchId, queueItem.id, { status: 'running', phase: 'sandbox' })
    try {
      const runResponse = await window.api.test.run({
        runId: testRunId,
        sourceRepo: repo.sourcePath,
        targetDesc: challenge.focus,
        providerId: option.providerId,
        model: response.result.model,
        framework: repo.detection.framework,
        testCommand: repo.detection.testCommand,
        installCommand: repo.detection.installCommand || undefined,
        installDeps,
        files: [{ path: repo.detection.suggestedTestPath, content: code }],
        tokens: tokens ?? undefined,
        attempts: 1,
        timeoutMs: settings.timeoutMs
      })
      if (!runResponse.ok) {
        const cancelled = stopRequested.current || /abort|cancel/i.test(runResponse.error)
        return {
          key: option.key,
          providerId: option.providerId,
          providerLabel: option.providerLabel,
          requestedModel: option.model,
          error: cancelled ? 'Cancelled' : runResponse.error,
          cancelled
        }
      }
      return {
        key: option.key,
        providerId: option.providerId,
        providerLabel: option.providerLabel,
        requestedModel: option.model,
        run: runResponse.run
      }
    } finally {
      activeTestRunIds.current.delete(testRunId)
    }
  }, [challengePrompt, installDeps, patchQueue, persistQueueItem, repositoryPrompt])

  const finalizeResult = useCallback(async (
    result: RunResult,
    queueItem: QueueItem,
    batchId: string
  ) => {
    const endedAt = Date.now()
    if (result.run) {
      patchQueue(queueItem.id, { status: 'completed', endedAt, detail: 'Scored' })
      await persistQueueItem(batchId, queueItem.id, {
        status: 'completed',
        phase: 'scored',
        testRunId: result.run.id,
        durationMs: result.run.durationMs,
        tokens: result.run.tokens
      })
      return
    }
    const status = result.cancelled ? 'cancelled' : 'failed'
    patchQueue(queueItem.id, { status, endedAt, detail: result.error, error: result.error })
    await persistQueueItem(batchId, queueItem.id, {
      status,
      phase: status,
      error: result.error ?? status
    })
  }, [patchQueue, persistQueueItem])

  const handleStart = useCallback(async () => {
    if (!selectedChallenge || selectedModels.length === 0 || validationMessage) return
    setError(null)
    setResults([])
    setRunning(true)
    stopRequested.current = false

    const settingsSnapshot = { ...runSettings }
    const modelsSnapshot = [...selectedModels]
    const challengeSnapshot = { ...selectedChallenge }
    const repo = challengeSnapshot.metric === 'tests' ? await prepareRepository() : null
    if (challengeSnapshot.metric === 'tests' && !repo) {
      setRunning(false)
      return
    }

    const requestedBatchId = newId()
    const plannedItems = modelsSnapshot.map((option) => ({ id: newId(), providerId: option.providerId, model: option.model }))
    let persistedRun: BenchmarkRun
    try {
      persistedRun = await window.api.benchmark.createRun({
        id: requestedBatchId,
        challengeId: challengeSnapshot.id,
        challengeLabel: challengeSnapshot.label,
        category: challengeSnapshot.category,
        metric: challengeSnapshot.metric,
        source: repo?.sourcePath ?? 'local preset',
        parallelExecution: settingsSnapshot.parallel,
        config: {
          maxTokens: settingsSnapshot.maxTokens,
          temperature: settingsSnapshot.temperature,
          timeoutMs: settingsSnapshot.timeoutMs,
          installDeps,
          scoringVersion: 1
        },
        items: plannedItems
      })
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError))
      setRunning(false)
      return
    }
    const batchId = persistedRun.id
    activeBatchId.current = batchId
    const initialQueue: QueueItem[] = modelsSnapshot.map((option, index) => ({
      id: persistedRun.items[index]?.id ?? plannedItems[index].id,
      modelKey: option.key,
      providerId: option.providerId,
      providerLabel: option.providerLabel,
      modelLabel: option.model,
      status: 'queued'
    }))
    setQueue(initialQueue)

    const controller = new AbortController()
    batchController.current = controller
    const completedByKey = new Map<string, RunResult>()
    await runBoundedBenchmarkQueue(
      modelsSnapshot,
      async (option, index, signal) => {
        if (signal.aborted || stopRequested.current) {
          const abortError = new Error('Benchmark cancelled')
          abortError.name = 'AbortError'
          throw abortError
        }
        let result: RunResult
        try {
          result = await executeModel(
            option,
            initialQueue[index],
            batchId,
            challengeSnapshot,
            settingsSnapshot,
            repo
          )
        } catch (runError) {
          const message = runError instanceof Error ? runError.message : String(runError)
          const cancelled = stopRequested.current || /abort|cancel/i.test(message)
          result = {
            key: option.key,
            providerId: option.providerId,
            providerLabel: option.providerLabel,
            requestedModel: option.model,
            error: cancelled ? 'Cancelled' : message,
            cancelled
          }
        }
        completedByKey.set(option.key, result)
        setResults((current) => [...current.filter((item) => item.key !== result.key), result])
        await finalizeResult(result, initialQueue[index], batchId)
        return result
      },
      {
        concurrency: settingsSnapshot.parallel ? Math.min(3, modelsSnapshot.length) : 1,
        signal: controller.signal,
        idForItem: (option) => option.key
      }
    )

    const completedResults = modelsSnapshot.map((option) => completedByKey.get(option.key) ?? ({
      key: option.key,
      providerId: option.providerId,
      providerLabel: option.providerLabel,
      requestedModel: option.model,
      error: 'Cancelled',
      cancelled: true
    }))
    setResults(completedResults)
    const ranked = rankResults(completedResults, challengeSnapshot)

    if (!stopRequested.current) {
      for (const item of ranked) {
        if (!item.result.run) continue
        const run = item.result.run
        try {
          const entry = await window.api.benchmark.upsert({
            challengeId: challengeSnapshot.id,
            challengeLabel: challengeSnapshot.label,
            category: challengeSnapshot.category,
            metric: challengeSnapshot.metric,
            model: run.model || item.result.requestedModel,
            providerId: run.providerId ?? item.result.providerId,
            score: item.score,
            rank: item.rank,
            status: run.status,
            durationMs: run.durationMs,
            tokens: run.tokens,
            runId: run.id,
            source: repo?.sourcePath ?? 'local preset',
            summary: `${challengeSnapshot.label} · ${item.result.providerLabel} · ${run.model ?? item.result.requestedModel}`,
            prompt: challengeSnapshot.metric === 'tests'
              ? challengeSnapshot.focus ?? null
              : challengePrompt(challengeSnapshot, settingsSnapshot),
            artifactPreview: run.rawOutput,
            mediaType: challengeSnapshot.mediaType ?? 'none',
            mediaUrl: null,
            signature: `${challengeSnapshot.id}::${item.result.providerId}::${(run.model ?? item.result.requestedModel).toLowerCase()}`
          })
          const queueItem = initialQueue.find((candidate) => candidate.modelKey === item.result.key)
          if (queueItem) {
            await persistQueueItem(batchId, queueItem.id, {
              score: item.score,
              rank: item.rank,
              benchmarkEntryId: entry.id
            })
          }
        } catch {
          // A local artifact/export failure does not invalidate the measured run.
        }
      }
    }

    const successful = completedResults.filter((result) => result.run).length
    const finalStatus = stopRequested.current
      ? 'cancelled'
      : successful === 0
        ? 'failed'
        : 'completed'
    try {
      await window.api.benchmark.finishRun({
        runId: batchId,
        status: finalStatus,
        error: successful === 0 && !stopRequested.current ? 'No model completed successfully.' : null
      })
    } catch {
      // History reconciliation will mark an unfinished run as interrupted after restart.
    }
    activeBatchId.current = null
    batchController.current = null
    setRunning(false)
    await refreshHistory()
  }, [
    challengePrompt,
    executeModel,
    finalizeResult,
    installDeps,
    persistQueueItem,
    prepareRepository,
    refreshHistory,
    runSettings,
    selectedChallenge,
    selectedModels,
    validationMessage
  ])

  const handleStop = useCallback(() => {
    stopRequested.current = true
    batchController.current?.abort()
    for (const requestId of activeRequestIds.current) window.api.chat.cancel(requestId)
    for (const runId of activeTestRunIds.current) window.api.test.stop(runId)
    setQueue((current) => current.map((item) =>
      item.status === 'queued' || item.status === 'running'
        ? { ...item, status: 'cancelled', endedAt: Date.now(), detail: 'Cancelled', error: 'Cancelled' }
        : item
    ))
  }, [])

  const handleToggleModel = useCallback((key: string) => {
    setError(null)
    setSelectedModelKeys((current) => current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key])
  }, [])

  const handleChallengeChange = useCallback((challengeId: string) => {
    setError(null)
    setSelectedChallengeId(challengeId)
    setResults([])
    setQueue([])
  }, [])

  const handleSettingsChange = useCallback((patch: Partial<BenchmarkSettingsView>) => {
    setError(null)
    setRunSettings((current) => {
      const next = {
        maxTokens: Math.min(1_000_000, Math.max(64, patch.maxTokens ?? current.maxTokens)),
        temperature: Math.min(2, Math.max(0, patch.temperature ?? current.temperature)),
        timeoutMs: Math.min(1_800_000, Math.max(1_000, patch.timeoutMs ?? current.timeoutMs)),
        parallel: patch.parallel ?? current.parallel
      }
      if (patch.timeoutMs != null) void window.api.test.setSettings({ timeoutMs: next.timeoutMs })
      return next
    })
  }, [])

  const rankedResults = useMemo(() =>
    selectedChallenge ? rankResults(results, selectedChallenge) : results.map((result) => ({ result, rank: null, score: null })),
    [results, selectedChallenge])

  const resultViews = useMemo<BenchmarkResultView[]>(() => rankedResults.map(({ result, rank, score }) => {
    const metric = result.run && selectedChallenge ? primaryMetric(result.run, selectedChallenge) : null
    return {
      id: result.run?.id ?? result.key,
      modelKey: result.key,
      providerLabel: result.providerLabel,
      modelLabel: result.run?.model ?? result.requestedModel,
      status: result.run ? 'completed' : result.cancelled ? 'cancelled' : 'failed',
      rank,
      score,
      durationMs: result.run?.durationMs,
      tokens: result.run?.tokens,
      primaryMetricLabel: metric?.label,
      primaryMetricValue: metric?.value
    }
  }), [rankedResults, selectedChallenge])

  const queueViews = useMemo<BenchmarkQueueView[]>(() => queue.map((item) => ({
    id: item.id,
    modelKey: item.modelKey,
    providerLabel: item.providerLabel,
    modelLabel: item.modelLabel,
    status: item.status,
    detail: item.error ?? item.detail,
    durationMs: item.startedAt ? (item.endedAt ?? clock) - item.startedAt : null
  })), [clock, queue])

  const recentRunViews = useMemo<BenchmarkRecentRunView[]>(() => recentRuns.map((run) => {
    const rankedItems = run.items.filter((item) => item.score != null).sort((left, right) => (left.rank ?? 99) - (right.rank ?? 99))
    const best = rankedItems[0]
    const bestProvider = providers.find((provider) => provider.id === best?.providerId)
    const startedAt = run.startedAt ?? run.createdAt
    const endedAt = run.completedAt ?? run.updatedAt
    return {
      id: run.id,
      createdAt: run.createdAt,
      challengeLabel: run.challengeLabel,
      modelCount: run.totalItems,
      status: runStatus(run),
      bestModelLabel: best ? `${bestProvider ? providerLabel(bestProvider) : best.providerId} · ${best.model}` : undefined,
      bestScore: best?.score,
      durationMs: endedAt >= startedAt ? endedAt - startedAt : null
    }
  }), [providers, recentRuns])

  const libraryViews = useMemo<BenchmarkLibraryView[]>(() => libraryEntries.slice(0, 12).map((entry) => {
    const provider = providers.find((candidate) => candidate.id === entry.providerId)
    return {
      id: entry.id,
      updatedAt: entry.updatedAt,
      challengeLabel: entry.challengeLabel,
      providerLabel: provider ? providerLabel(provider) : entry.providerId ?? 'Unknown provider',
      modelLabel: entry.model,
      status: entry.status === 'aborted' ? 'cancelled' : entry.status === 'passed' ? 'completed' : entry.status ? 'failed' : undefined,
      score: entry.score,
      durationMs: entry.durationMs
    }
  }), [libraryEntries, providers])

  const repositorySetup = requiresRepository ? (
    <section className="benchmark-experience__repository" aria-labelledby="benchmark-repository-title">
      <div className="benchmark-experience__repository-head">
        <div>
          <span>Repository source</span>
          <h2 id="benchmark-repository-title">Run against a disposable project copy</h2>
        </div>
        <span>{detection ? `${detection.framework} detected` : 'Required'}</span>
      </div>
      <div className="benchmark-experience__repository-grid">
        <div className="benchmark-experience__source-tabs" role="group" aria-label="Repository source type">
          <button type="button" className={sourceMode === 'folder' ? 'is-selected' : ''} disabled={running} onClick={() => setSourceMode('folder')}>
            Local folder
          </button>
          <button type="button" className={sourceMode === 'github' ? 'is-selected' : ''} disabled={running} onClick={() => setSourceMode('github')}>
            GitHub URL
          </button>
        </div>
        {sourceMode === 'folder' ? (
          <>
            <label>
              <span>Saved project</span>
              <select
                value={projects.some((project) => project.path === sourceRepo) ? sourceRepo : ''}
                disabled={running}
                onChange={(event) => {
                  setSourceRepo(event.target.value)
                  setDetection(null)
                  setError(null)
                }}
              >
                <option value="">Choose a project…</option>
                {projects.filter((project) => project.path).map((project) => (
                  <option key={project.id} value={project.path ?? ''}>{project.name}</option>
                ))}
              </select>
            </label>
            <label className="benchmark-experience__source-path">
              <span>Folder</span>
              <div>
                <input value={sourceRepo} readOnly placeholder="No folder selected" />
                <button type="button" disabled={running} onClick={() => void chooseFolder()}>Browse…</button>
              </div>
            </label>
          </>
        ) : (
          <label className="benchmark-experience__source-path">
            <span>GitHub repository URL</span>
            <div>
              <input
                value={sourceRepo}
                disabled={running}
                placeholder="https://github.com/owner/repository"
                spellCheck={false}
                onChange={(event) => {
                  setSourceRepo(event.target.value)
                  setDetection(null)
                  setSourceNotice(null)
                  setError(null)
                }}
              />
              <button type="button" disabled={running || !sourceRepo.trim()} onClick={() => void prepareRepository()}>Detect</button>
            </div>
          </label>
        )}
        <label className="benchmark-experience__repo-toggle">
          <span>
            <strong>Install dependencies</strong>
            <small>Only inside the disposable sandbox.</small>
          </span>
          <input type="checkbox" role="switch" checked={installDeps} disabled={running} onChange={(event) => setInstallDeps(event.target.checked)} />
        </label>
      </div>
      {(sourceNotice || detection) && (
        <p className="benchmark-experience__repository-note">
          {sourceNotice ? `${sourceNotice} · ` : ''}
          {detection ? `${detection.framework} · ${detection.testCommand}` : ''}
        </p>
      )}
    </section>
  ) : undefined

  return (
    <BenchmarkExperience
      modelGroups={modelGroups}
      selectedModelKeys={selectedModelKeys}
      onToggleModel={handleToggleModel}
      challenges={challengeViews}
      selectedChallengeId={selectedChallengeId}
      onSelectChallenge={handleChallengeChange}
      settings={runSettings}
      onSettingsChange={handleSettingsChange}
      running={running}
      onStart={handleStart}
      onStop={handleStop}
      queue={queueViews}
      results={resultViews}
      recentRuns={recentRunViews}
      library={libraryViews}
      estimatedMs={estimatedMs}
      validationMessage={validationMessage}
      repositorySetup={repositorySetup}
    />
  )
}
