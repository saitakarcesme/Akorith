import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BenchmarkCategory,
  BenchmarkEntry,
  BenchmarkMediaType,
  EvaluationRow,
  IsaDimensionName,
  ProviderInfo,
  ProjectRow,
  TestDetection,
  TestRepoContext,
  TestRunRow,
  TestSettings
} from '../../../preload/index.d'
import { formatModelLabel } from '../modelLabels'
import TestTerminal from './TestTerminal'

interface TestPageProps {
  active: boolean
  activeProject: ProjectRow | null
}

interface ResultItem {
  model: string
  providerId?: string
  providerLabel?: string
  pending: boolean
  run?: TestRunRow
  error?: string
}

interface BenchmarkModelOption {
  key: string
  providerId: string
  providerLabel: string
  model: string
  available: boolean
  reason?: string
}

interface BenchmarkProviderGroup {
  provider: ProviderInfo
  available: boolean
  options: BenchmarkModelOption[]
}

interface BenchmarkPerformance {
  key: string
  label: string
  runs: number
  averageScore: number
  bestScore: number
  averageDurationMs: number | null
  averageTokens: number | null
}

interface RunConfig {
  framework: string
  testCommand: string
  installCommand: string
  testPath: string
}

interface DetectionResult {
  detection: TestDetection
  context: TestRepoContext | null
  sourceRepo: string
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** First fenced code block's body, or null. */
function extractCode(text: string): string | null {
  const m = text.match(/```[^\n`]*\n([\s\S]*?)```/)
  return m ? m[1].replace(/\n$/, '') : null
}

function statusColor(status: string | null | undefined): string {
  switch (status) {
    case 'passed':
      return 'is-pass'
    case 'failed':
      return 'is-fail'
    case 'install-failed':
    case 'error':
      return 'is-error'
    case 'timeout':
    case 'aborted':
      return 'is-warn'
    default:
      return ''
  }
}

const SCORE_DIMS: IsaDimensionName[] = ['tests', 'speed', 'tokens', 'quality']

function isLocalAutoStarting(provider?: ProviderInfo): boolean {
  return Boolean(
    provider?.id === 'local' &&
      !provider.available.ok &&
      /Akorith (is starting Ollama|tried to auto-start it)/i.test(provider.available.reason ?? '')
  )
}

const BENCHMARK_PROVIDER_ORDER = ['local', 'chatgpt', 'claude', 'opencode']
const BENCHMARK_PROVIDER_IDS = new Set(BENCHMARK_PROVIDER_ORDER)

function benchmarkModelKey(providerId: string, model: string): string {
  return `${providerId}::${model || 'default'}`
}

function providerDisplayName(providerId: string, providers: ProviderInfo[] = []): string {
  const info = providers.find((p) => p.id === providerId)
  if (info?.label) return info.label
  if (providerId === 'chatgpt') return 'Codex/GPT'
  if (providerId === 'opencode') return 'OpenCode'
  if (providerId === 'claude') return 'Claude'
  if (providerId === 'local') return 'Ollama'
  return providerId || 'Provider'
}

function benchmarkOptionLabel(option: Pick<BenchmarkModelOption, 'providerLabel' | 'model'>): string {
  return `${option.providerLabel} · ${option.model || 'default'}`
}

function resultLabel(item: ResultItem, providers: ProviderInfo[] = []): string {
  const providerLabel = item.providerLabel ?? providerDisplayName(item.providerId ?? item.run?.providerId ?? '', providers)
  return `${providerLabel} · ${item.model || item.run?.model || 'default'}`
}

// Benchmark challenge types. Every selected provider/model receives the exact
// same prompt and is ranked by objective metrics. Most challenges do not need
// a user repo; the optional "repo sandbox" challenge still uses Test Lab's
// disposable copy runner for users who want real codebase tests.
type TestMetric = 'tests' | 'latency' | 'efficiency' | 'artifact'
interface TestType {
  id: string
  label: string
  blurb: string
  category: BenchmarkCategory
  metric: TestMetric
  mediaType?: BenchmarkMediaType
  focus?: string
  prompt?: string
  deliverables?: string[]
  scoreHint?: string
}
const TEST_TYPES: TestType[] = [
  {
    id: 'speed',
    label: 'Speed test',
    blurb: 'Fixed implementation task ranked by tokens/sec and total time.',
    category: 'general',
    metric: 'latency',
    scoreHint: 'Fastest sustained token throughput wins.',
    prompt:
      'Write a single self-contained TypeScript function `debounce(fn, waitMs)` that delays calling `fn` until `waitMs` has elapsed since the last call, cancels pending calls on each new call, preserves `this` and arguments, and includes a 3-sentence explanation. Respond concisely.',
    deliverables: ['TypeScript function', 'Cancellation behavior', '3-sentence explanation']
  },
  {
    id: 'token',
    label: 'Token efficiency',
    blurb: 'Same coding task, but the leanest complete answer wins.',
    category: 'general',
    metric: 'efficiency',
    scoreHint: 'Fewest total prompt + completion tokens wins.',
    prompt:
      'Implement `parseEnvFlag(value)` in TypeScript. It should accept booleans, numbers, and strings; treat true/1/yes/on/enabled as true; false/0/no/off/disabled/empty as false; return null for unknown values; include 5 compact examples.',
    deliverables: ['TypeScript implementation', 'Boolean/null behavior', '5 examples']
  },
  {
    id: 'project-builder',
    label: 'Project build',
    blurb: 'Generate a compact app scaffold plan with files and validation.',
    category: 'general',
    metric: 'artifact',
    mediaType: 'artifact',
    scoreHint: 'Scores completeness, structure, validation plan, speed, and token discipline.',
    prompt:
      'Design a small offline-first task tracker project. Return: architecture, file tree, key TypeScript interfaces, 2 core React components, persistence approach, and validation commands. Keep it implementable in one sitting.',
    deliverables: ['Architecture', 'File tree', 'Interfaces', 'Components', 'Validation commands']
  },
  {
    id: 'game-builder',
    label: 'Game build',
    blurb: 'Ask each model for a playable browser game blueprint.',
    category: 'game',
    metric: 'artifact',
    mediaType: 'interactive',
    scoreHint: 'Scores gameplay loop, state model, controls, assets, validation, and clarity.',
    prompt:
      'Create a Phaser-style 2D browser game spec for a 90-second arcade survival game. Include gameplay loop, player controls, enemy waves, scoring, state objects, asset list, and 3 implementation risks with mitigations.',
    deliverables: ['Gameplay loop', 'Controls', 'Enemy waves', 'Scoring', 'Risks']
  },
  {
    id: 'game-visual',
    label: 'Game visual pass',
    blurb: 'Compare models on a playable scene, HUD, and recording plan.',
    category: 'game',
    metric: 'artifact',
    mediaType: 'video',
    scoreHint: 'Scores visual specificity, game loop, capture plan, and implementation clarity.',
    prompt:
      'Design a playable browser mini-game scene for a model benchmark. Include the game loop, a 16:9 first-screen layout, HUD states, player/enemy visuals, keyboard controls, scoring, and a Playwright screen-recording plan that would capture a 20-second clip.',
    deliverables: ['Game loop', '16:9 layout', 'HUD states', 'Visuals', 'Recording plan']
  },
  {
    id: 'ui-visual',
    label: 'UI visual build',
    blurb: 'Generate an inspectable product UI with visual QA criteria.',
    category: 'ui',
    metric: 'artifact',
    mediaType: 'image',
    scoreHint: 'Scores visual hierarchy, responsive states, accessibility, and screenshot readiness.',
    prompt:
      'Design a desktop + mobile UI benchmark for an AI productivity dashboard. Include screen structure, component states, accessibility checks, responsive rules, and a Playwright screenshot checklist. The output should be specific enough to visually compare two model-built UIs.',
    deliverables: ['Desktop layout', 'Mobile layout', 'Component states', 'Accessibility checks', 'Screenshot checklist']
  },
  {
    id: 'ui-flow',
    label: 'UI behavior flow',
    blurb: 'Ask models for interaction states and visual regression coverage.',
    category: 'ui',
    metric: 'artifact',
    mediaType: 'video',
    scoreHint: 'Scores interaction clarity, state coverage, visual test plan, and edge cases.',
    prompt:
      'Specify a visual UI benchmark for a settings workflow: navigation, form edits, validation errors, save success, keyboard focus, and reduced-motion behavior. Include exact screenshots/video moments to capture and what should be asserted.',
    deliverables: ['Navigation', 'Form states', 'Validation errors', 'Save success', 'Visual captures']
  },
  {
    id: 'backend',
    label: 'Backend coding',
    blurb: 'Design a local API endpoint with tests and failure handling.',
    category: 'general',
    metric: 'artifact',
    scoreHint: 'Scores API shape, data validation, error paths, tests, and operational clarity.',
    prompt:
      'Design a Node/TypeScript API endpoint `POST /runs` for storing local benchmark runs. Include request/response schemas, validation rules, persistence model, handler pseudocode, and 6 focused tests.',
    deliverables: ['Schemas', 'Validation', 'Persistence model', 'Handler', '6 tests']
  },
  {
    id: 'python-tests',
    label: 'Python test writing',
    blurb: 'Generate pytest coverage for a described utility module.',
    category: 'general',
    metric: 'artifact',
    scoreHint: 'Scores edge coverage, concrete assertions, maintainability, and brevity.',
    prompt:
      'Write pytest tests for a Python module `slugify.py` with function `slugify(text, max_length=80)`. Cover whitespace, accents, punctuation, duplicate separators, empty input, max length, and idempotence. Return only the test file and a short rationale.',
    deliverables: ['Pytest file', 'Edge cases', 'Concrete assertions', 'Short rationale']
  },
  {
    id: 'repo-bug',
    label: 'Custom repo sandbox',
    blurb: 'Optional: use a folder or GitHub repo, generate tests, run in temp sandbox.',
    category: 'repo',
    metric: 'tests',
    scoreHint: 'Scores pass rate, generated test count, and execution speed.',
    focus:
      'Find likely regressions and fragile logic; write focused tests that reproduce bugs or edge-case failures, and cover the most valuable stable behavior with correct assertions.'
  },
  {
    id: 'repo-ui',
    label: 'Repo UI behavior',
    blurb: 'For React/UI repos: visible behavior, state, interactions.',
    category: 'ui',
    metric: 'tests',
    mediaType: 'image',
    scoreHint: 'Scores runnable behavior tests in a disposable repo copy.',
    focus:
      'For React/UI repos, test visible behavior, state changes, and user interactions without brittle snapshots.'
  },
  {
    id: 'repo-unit',
    label: 'Repo unit logic',
    blurb: 'Small deterministic tests over pure utility & domain logic.',
    category: 'repo',
    metric: 'tests',
    scoreHint: 'Scores executable unit tests against real source files.',
    focus: 'Cover pure utility and domain logic with small deterministic unit tests.'
  }
]

// A benchmark result carries an objective 0–100 score and rank, computed
// client-side from sandbox metrics — never from a model's opinion.
interface Ranked {
  score: number
  rank: number
}

// Score a finished test-generation run: mostly pass rate, with a completion
// gate so a model that produced no runnable tests can't out-rank one that did.
function scoreTestsRun(run: TestRunRow): number {
  const p = run.passed ?? 0
  const f = run.failed ?? 0
  const e = run.errored ?? 0
  const total = p + f + e
  if (run.status === 'install-failed' || run.status === 'error' || run.status === 'aborted') return 0
  if (total === 0) return 0
  const passRate = p / total
  // 90% of the score is honest pass rate; 10% rewards writing more real tests
  // (log-scaled so a huge count doesn't dominate), capped at 100.
  const volume = Math.min(1, Math.log10(1 + total) / Math.log10(11)) // 10 tests ≈ full
  return Math.round(Math.min(100, passRate * 90 + volume * 10))
}

function scoreArtifactRun(run: TestRunRow, challenge: TestType): number {
  const text = (run.rawOutput ?? '').toLowerCase()
  if (!text.trim()) return 0
  const deliverables = challenge.deliverables ?? []
  const covered = deliverables.length
    ? deliverables.filter((item) => text.includes(item.toLowerCase().split(/\s+/)[0])).length / deliverables.length
    : 0.7
  const structureSignals = ['```', 'test', 'validate', 'command', 'interface', 'schema', 'state', 'risk']
  const structure = structureSignals.filter((signal) => text.includes(signal)).length / structureSignals.length
  const durationScore = run.durationMs ? Math.max(0, 1 - run.durationMs / 120000) : 0.5
  const tokenScore = run.tokens ? Math.max(0.2, Math.min(1, 1800 / run.tokens)) : 0.5
  return Math.round(Math.min(100, covered * 45 + structure * 25 + durationScore * 15 + tokenScore * 15))
}

// Rank a cohort. Higher score wins; ties broken by speed (lower durationMs).
function rankResults(items: ResultItem[], metric: TestMetric, challenge: TestType): Map<string, Ranked> {
  const scored = items
    .filter((it) => it.run)
    .map((it) => {
      const run = it.run as TestRunRow
      const raw = metric === 'tests' ? scoreTestsRun(run) : metric === 'artifact' ? scoreArtifactRun(run, challenge) : 0
      return { id: run.id, run, raw }
    })
  if (metric === 'efficiency') {
    // Fewest tokens for the fixed task wins; scaled so the leanest gets 100.
    const withTok = scored.map((s) => ({ ...s, tok: s.run.tokens ?? 0 }))
    const min = Math.min(...withTok.map((t) => t.tok).filter((n) => n > 0), Infinity)
    for (const t of withTok) t.raw = t.tok > 0 && min !== Infinity ? Math.round((min / t.tok) * 100) : 0
    scored.length = 0
    scored.push(...withTok)
  }
  if (metric === 'latency') {
    // Rank by tokens/sec (throughput); fastest gets 100, others scaled to it.
    const tput = scored.map((s) => {
      const secs = (s.run.durationMs ?? 0) / 1000
      return { ...s, tps: secs > 0 ? (s.run.tokens ?? 0) / secs : 0 }
    })
    const best = Math.max(1, ...tput.map((t) => t.tps))
    for (const t of tput) t.raw = Math.round((t.tps / best) * 100)
    scored.length = 0
    scored.push(...tput)
  }
  scored.sort((a, b) => b.raw - a.raw || (a.run.durationMs ?? 0) - (b.run.durationMs ?? 0))
  const out = new Map<string, Ranked>()
  scored.forEach((s, i) => out.set(s.id, { score: s.raw, rank: i + 1 }))
  return out
}

function scoreLabel(score: number | null): string {
  return score === null ? 'omitted' : score.toFixed(1)
}

function categoryLabel(category: BenchmarkCategory): string {
  switch (category) {
    case 'ui':
      return 'Visual UI tests'
    case 'game':
      return 'Game tests'
    case 'repo':
      return 'Repo sandbox'
    default:
      return 'General tests'
  }
}

function mediaLabel(mediaType: BenchmarkMediaType): string {
  switch (mediaType) {
    case 'image':
      return 'screenshot'
    case 'video':
      return 'video'
    case 'interactive':
      return 'playable'
    case 'artifact':
      return 'artifact'
    default:
      return 'metrics'
  }
}

function benchmarkMediaUrl(challenge: TestType): string | null {
  void challenge
  return null
}

function summarizeBenchmarkPerformance(
  entries: BenchmarkEntry[],
  providers: ProviderInfo[]
): BenchmarkPerformance[] {
  const grouped = new Map<
    string,
    {
      providerId: string
      model: string
      runs: number
      scoreTotal: number
      scoreCount: number
      bestScore: number
      durationTotal: number
      durationCount: number
      tokenTotal: number
      tokenCount: number
    }
  >()

  for (const entry of entries) {
    const providerId = entry.providerId ?? 'unknown'
    const key = benchmarkModelKey(providerId, entry.model)
    const current = grouped.get(key) ?? {
      providerId,
      model: entry.model,
      runs: 0,
      scoreTotal: 0,
      scoreCount: 0,
      bestScore: 0,
      durationTotal: 0,
      durationCount: 0,
      tokenTotal: 0,
      tokenCount: 0
    }
    current.runs += 1
    if (entry.score != null) {
      current.scoreTotal += entry.score
      current.scoreCount += 1
      current.bestScore = Math.max(current.bestScore, entry.score)
    }
    if (entry.durationMs != null) {
      current.durationTotal += entry.durationMs
      current.durationCount += 1
    }
    if (entry.tokens != null) {
      current.tokenTotal += entry.tokens
      current.tokenCount += 1
    }
    grouped.set(key, current)
  }

  return [...grouped.entries()]
    .map(([key, group]) => ({
      key,
      label: `${providerDisplayName(group.providerId, providers)} · ${group.model}`,
      runs: group.runs,
      averageScore: group.scoreCount ? Math.round(group.scoreTotal / group.scoreCount) : 0,
      bestScore: group.bestScore,
      averageDurationMs: group.durationCount ? group.durationTotal / group.durationCount : null,
      averageTokens: group.tokenCount ? Math.round(group.tokenTotal / group.tokenCount) : null
    }))
    .sort((a, b) => b.averageScore - a.averageScore || b.bestScore - a.bestScore || b.runs - a.runs)
    .slice(0, 10)
}

function evaluationWarning(evaluation: EvaluationRow): string | null {
  const scores = evaluation.dimensionScores
  if (scores.qualityRequested && !scores.qualityIncluded) {
    return scores.qualityFailure ? `Quality omitted: ${scores.qualityFailure}` : 'Quality omitted; objective dimensions re-normalized.'
  }
  return null
}

export default function TestPage({ active, activeProject }: TestPageProps): JSX.Element {
  const [settings, setSettings] = useState<TestSettings | null>(null)
  const [sourceRepo, setSourceRepo] = useState('')
  const [sourceMode, setSourceMode] = useState<'folder' | 'github'>('folder')
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [selectedModels, setSelectedModels] = useState<string[]>([])

  // Resolved/overridable run config (seeded by Detect).
  const [detection, setDetection] = useState<TestDetection | null>(null)
  // Phase 14.1: bounded read-only repo structure + samples, so the generator
  // imports real modules with real export names instead of guessing.
  const [repoContext, setRepoContext] = useState<TestRepoContext | null>(null)
  const [framework, setFramework] = useState('')
  const [testCommand, setTestCommand] = useState('')
  const [installCommand, setInstallCommand] = useState('')
  const [installDeps, setInstallDeps] = useState(true)
  const [testPath, setTestPath] = useState('')

  const [testTypeId, setTestTypeId] = useState('speed')
  const testType = TEST_TYPES.find((t) => t.id === testTypeId) ?? TEST_TYPES[0]
  const presetFocus = testType.focus ?? ''

  const [running, setRunning] = useState(false)
  const [repairingIdx, setRepairingIdx] = useState<number | null>(null)
  const [phase, setPhase] = useState('')
  const [clearKey, setClearKey] = useState(0)
  const [results, setResults] = useState<ResultItem[]>([])
  const [ranMetric, setRanMetric] = useState<TestMetric>('tests')
  const [sandboxOpen, setSandboxOpen] = useState(false)
  const [recent, setRecent] = useState<TestRunRow[]>([])
  const [benchmarks, setBenchmarks] = useState<BenchmarkEntry[]>([])
  const [benchmarkExportNotice, setBenchmarkExportNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sourceNotice, setSourceNotice] = useState<string | null>(null)

  // Phase 8: evaluate persisted test_runs without re-running them.
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([])
  const [judgeProviderId, setJudgeProviderId] = useState('')
  const [judgeModel, setJudgeModel] = useState('')
  const [evaluating, setEvaluating] = useState(false)
  const [evalError, setEvalError] = useState<string | null>(null)
  const [latestEvaluation, setLatestEvaluation] = useState<EvaluationRow | null>(null)
  const [evaluations, setEvaluations] = useState<EvaluationRow[]>([])
  const [pdfBusyId, setPdfBusyId] = useState<string | null>(null)
  const [pdfNotice, setPdfNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const currentRunId = useRef<string | null>(null)
  const currentReqId = useRef<string | null>(null)

  const localProvider = providers.find((p) => p.id === 'local')
  const selected = providers.find((p) => p.id === providerId)
  const benchmarkProviderGroups = useMemo<BenchmarkProviderGroup[]>(() => {
    return providers
      .filter((provider) => BENCHMARK_PROVIDER_IDS.has(provider.id))
      .sort((a, b) => BENCHMARK_PROVIDER_ORDER.indexOf(a.id) - BENCHMARK_PROVIDER_ORDER.indexOf(b.id))
      .map((provider) => {
        const available = provider.available.ok || isLocalAutoStarting(provider)
        const models = provider.models.length > 0 ? provider.models : ['default']
        const providerLabel = provider.id === 'chatgpt' ? 'Codex/GPT' : provider.label
        return {
          provider,
          available,
          options: models.map((modelName) => ({
            key: benchmarkModelKey(provider.id, modelName),
            providerId: provider.id,
            providerLabel,
            model: modelName,
            available,
            reason: provider.available.reason
          }))
        }
      })
  }, [providers])
  const benchmarkOptions = useMemo(
    () => benchmarkProviderGroups.flatMap((group) => group.options),
    [benchmarkProviderGroups]
  )
  const availableBenchmarkOptions = benchmarkOptions.filter((option) => option.available)
  const selectedBenchmarkOptions = selectedModels
    .map((key) => benchmarkOptions.find((option) => option.key === key))
    .filter((option): option is BenchmarkModelOption => Boolean(option))
  const unavailableSelected = selectedBenchmarkOptions.find((option) => !option.available)
  const judgeProviders = providers.filter((p) => p.available.ok && (p.id === 'local' || p.id === 'claude' || p.id === 'chatgpt'))
  const judgeSelected = judgeProviders.find((p) => p.id === judgeProviderId)
  const projectOptions = projects.filter((project) => Boolean(project.path))
  const selectedProjectPath = projectOptions.find((project) => project.path === sourceRepo)?.path ?? ''

  const refreshRecent = useCallback(() => {
    void window.api.test.listRuns(12).then(setRecent).catch(() => setRecent([]))
  }, [])

  const refreshBenchmarks = useCallback(() => {
    void window.api.benchmark.list(120).then(setBenchmarks).catch(() => setBenchmarks([]))
  }, [])

  const refreshEvaluations = useCallback(() => {
    void window.api.evaluate.list(12).then(setEvaluations).catch(() => setEvaluations([]))
  }, [])

  const refreshProviders = useCallback(async () => {
    try {
      const list = await window.api.chat.listProviders()
      setProviders(list)
      setProviderId((cur) => {
        if (list.some((p) => p.id === cur && (p.available.ok || isLocalAutoStarting(p)))) return cur
        return (
          list.find((p) => p.id === 'local' && (p.available.ok || isLocalAutoStarting(p)))?.id ??
          list.find((p) => p.available.ok)?.id ??
          list[0]?.id ??
          ''
        )
      })
    } catch {
      setProviders([])
    }
  }, [])

  // Initial load (providers, settings, history).
  useEffect(() => {
    void refreshProviders()
    void window.api.test.getSettings().then((s) => {
      setSettings(s)
      setInstallDeps(s.installDeps)
      setSourceRepo((cur) => cur || s.sourceRepo)
      setProviderId((cur) => cur || s.defaultProviderId || 'local')
    })
    void window.api.projects.list().then(setProjects).catch(() => setProjects([]))
    refreshRecent()
    refreshBenchmarks()
    refreshEvaluations()
  }, [refreshRecent, refreshBenchmarks, refreshEvaluations, refreshProviders])

  useEffect(() => {
    if (!isLocalAutoStarting(localProvider)) return
    const timer = window.setTimeout(() => void refreshProviders(), 3000)
    return () => window.clearTimeout(timer)
  }, [localProvider, refreshProviders])

  useEffect(() => {
    if (!active) return
    void window.api.projects.list().then(setProjects).catch(() => setProjects([]))
  }, [active])

  // If the user already has an active project, make it the simple-flow default
  // without overwriting an explicit Test Lab repo path from settings/user input.
  useEffect(() => {
    if (!activeProject?.path) return
    setSourceRepo((cur) => cur || activeProject.path || '')
  }, [activeProject?.path])

  // Default the model when the provider/model list changes.
  useEffect(() => {
    setModel((cur) => (selected && selected.models.includes(cur) ? cur : (selected?.models[0] ?? '')))
  }, [selected])

  useEffect(() => {
    setSelectedModels((current) => {
      const optionKeys = new Set(benchmarkOptions.filter((option) => option.available).map((option) => option.key))
      const valid = current.filter((key) => optionKeys.has(key))
      if (valid.length > 0) return valid
      return availableBenchmarkOptions.slice(0, 2).map((option) => option.key)
    })
  }, [benchmarkOptions.map((option) => `${option.key}:${option.available ? '1' : '0'}`).join('|')])

  useEffect(() => {
    const first = selectedBenchmarkOptions[0]
    if (first && (first.providerId !== providerId || first.model !== model)) {
      setProviderId(first.providerId)
      setModel(first.model)
    }
  }, [selectedModels.join('|'), benchmarkOptions.map((option) => option.key).join('|')])

  // Pick a sensible but overridable judge default. Phase 25 allows Local,
  // Claude, or ChatGPT; Local is preferred when available.
  useEffect(() => {
    setJudgeProviderId((cur) => {
      if (judgeProviders.some((p) => p.id === cur)) return cur
      return (
        judgeProviders.find((p) => p.id === 'local')?.id ||
        judgeProviders.find((p) => p.id === 'claude')?.id ||
        judgeProviders.find((p) => p.id === 'chatgpt')?.id ||
        ''
      )
    })
  }, [providers])

  useEffect(() => {
    setJudgeModel((cur) => (judgeSelected && judgeSelected.models.includes(cur) ? cur : (judgeSelected?.models[0] ?? '')))
  }, [judgeSelected])

  const prepareSourceRepo = async (): Promise<string | null> => {
    const input = sourceRepo.trim()
    if (!input) {
      setError('Pick a source repo first.')
      return null
    }
    const resolved = await window.api.test.resolveSource(input)
    if (!resolved.ok) {
      setError(resolved.error)
      setSourceNotice(null)
      return null
    }
    if (resolved.path !== input) {
      setSourceRepo(resolved.path)
      setSourceNotice(`${resolved.cloned ? 'Cloned' : 'Using cached clone'} ${resolved.label}`)
    } else {
      setSourceNotice(null)
    }
    return resolved.path
  }

  const chooseFolder = async (): Promise<void> => {
    setError(null)
    const res = await window.api.projects.pickDirectory()
    if (!res.ok) {
      if (!res.cancelled) setError(res.error)
      return
    }
    setSourceMode('folder')
    setSourceRepo(res.path)
    setDetection(null)
    setRepoContext(null)
    setSourceNotice(null)
  }

  const detect = async (): Promise<DetectionResult | null> => {
    setError(null)
    const repoPath = await prepareSourceRepo()
    if (!repoPath) return null
    await window.api.test.setSourceRepo(repoPath)
    const d = await window.api.test.detect(repoPath)
    if ('error' in d) {
      setError(d.error)
      setDetection(null)
      return null
    }
    setDetection(d)
    setFramework(d.framework)
    setTestCommand(d.testCommand)
    setInstallCommand(d.installCommand)
    setTestPath(d.suggestedTestPath)
    // Pull a bounded read-only structure digest so generation imports real files.
    try {
      const ctx = await window.api.test.context(repoPath)
      const nextContext = ctx && !('error' in ctx) ? ctx : null
      setRepoContext(nextContext)
      // Detection always yields a runnable command now (Akorith's sandbox
      // fallback covers repos with no test runner), so we never block here.
      return { detection: d, context: nextContext, sourceRepo: repoPath }
    } catch {
      setRepoContext(null)
    }
    return { detection: d, context: null, sourceRepo: repoPath }
  }

  // Apply the requested test focus. Repo detection owns framework/command/path.
  const applyTestType = async (id: string): Promise<void> => {
    setTestTypeId(id)
    const t = TEST_TYPES.find((x) => x.id === id)
    // Only custom repo sandbox runs need repo detection.
    if (t?.metric === 'tests' && sourceRepo.trim()) await detect()
    setError(null)
  }

  const toggleModel = (option: BenchmarkModelOption): void => {
    const adding = !selectedModels.includes(option.key)
    setSelectedModels((current) => {
      return current.includes(option.key) ? current.filter((key) => key !== option.key) : [...current, option.key]
    })
    if (adding) {
      setProviderId(option.providerId)
      setModel(option.model)
    }
  }

  const effectiveTarget = (): string => presetFocus || 'the most important logic in this repository'

  // Framework-specific rules that keep generated tests runnable (no "0 tests",
  // correct syntax, real imports). Steers away from the brittle patterns that
  // produced failing runs in manual testing.
  const frameworkRules = (runFramework = framework): string => {
    const fw = (runFramework || '').toLowerCase()
    if (fw === 'pytest') {
      return [
        '- Use plain pytest: `def test_*()` functions with `assert`. Do NOT require pytest plugins, fixtures from conftest, or network access.',
        '- Import modules exactly as they appear in the structure below (match the real module path and exported names). Do not invent functions.',
        '- If a module needs a package that may be missing, prefer testing pure-Python modules that have no third-party imports.',
        '- Include at least 3 real test functions that will actually execute.'
      ].join('\n')
    }
    if (fw === 'vitest' || fw === 'jest') {
      return [
        `- Use ${fw} syntax: import { describe, it, expect } from '${fw}' (vitest) — for jest the globals are available, do not import them.`,
        '- Import modules using paths that resolve from the generated test file. Prefer relative imports such as `./lib/example` or `./src/example`; if the repo uses `@/`, Akorith fallback Vitest resolves `@` to the repo root.',
        '- Use the exact exported names shown in the structure/samples below. Verify the export exists before testing it.',
        '- Only test pure functions/logic that run in Node without a browser, DB, or network. Do not import React components unless the preset is React.',
        '- Use the correct extension already chosen for the file. Include at least 3 real `it(...)` tests with concrete assertions — never an empty describe block.'
      ].join('\n')
    }
    return [
      '- Import the modules under test using the EXACT path and exported names shown in the structure below.',
      '- Write at least 3 real, executable tests with concrete assertions. Avoid placeholders, TODOs, or skipped tests.',
      '- Do not depend on network access, a running server, or packages that are not already in the repo.'
    ].join('\n')
  }

  const buildStructureBlock = (context = repoContext): string => {
    if (!context) return ''
    const samples = context.samples
      .map((s) => `--- FILE: ${s.path} ---\n${s.content}`)
      .join('\n\n')
    return (
      `\nRepository structure (read-only context — these are REAL files; import from them, do not invent names):\n` +
      `Source files (${context.fileCount} total, truncated):\n${context.tree || '(none found)'}\n` +
      (samples ? `\nSample source files you can import and test directly:\n${samples}\n` : '')
    )
  }

  const buildGenPrompt = (config: RunConfig, context = repoContext): string =>
    `You are generating an automated test file for an existing repository. First study the repository structure and sample files below, then write tests that import the REAL modules and assert on their REAL behavior.\n\n` +
    `Framework: ${config.framework || 'unit'}\n` +
    `Target: ${effectiveTarget()}\n` +
    (presetFocus ? `Emphasis: ${presetFocus}\n` : '') +
    `\nRules (follow exactly so the tests actually run and pass):\n${frameworkRules(config.framework)}\n` +
    buildStructureBlock(context) +
    `\nThe file will be saved as "${config.testPath}" (relative to the repo root) and run with: ${config.testCommand}\n` +
    `Make sure imports resolve from that location.\n\n` +
    `Respond with ONLY the complete test file content inside a single fenced code block — no prose, no explanation.`

  const buildChallengePrompt = (challenge: TestType): string => {
    const deliverables = challenge.deliverables?.length ? `\nRequired deliverables:\n- ${challenge.deliverables.join('\n- ')}` : ''
    return (
      `${challenge.prompt ?? 'Complete the benchmark task clearly and concisely.'}` +
      deliverables +
      `\n\nBenchmark rules:\n- Run fully locally; do not assume cloud APIs or paid services.\n- Be specific enough that a developer could implement or verify the answer.\n- Prefer compact code blocks, concrete commands, and explicit acceptance checks.\n- Do not mention that you are being benchmarked.`
    )
  }

  /** Repo-free benchmark: time the model on a fixed challenge and synthesize a
   *  run row so it slots into the same leaderboard and graph. */
  const challengeOne = async (selection: BenchmarkModelOption, challenge: TestType): Promise<ResultItem> => {
    const reqId = newId()
    currentReqId.current = reqId
    setPhase(`running ${challenge.label.toLowerCase()} on ${benchmarkOptionLabel(selection)}...`)
    const started = Date.now()
    try {
      const res = await window.api.chat.send({
        requestId: reqId,
        providerId: selection.providerId,
        model: selection.model || undefined,
        prompt: buildChallengePrompt(challenge)
      })
      const durationMs = Date.now() - started
      if (!res.ok) return { model: selection.model, providerId: selection.providerId, providerLabel: selection.providerLabel, pending: false, error: res.error }
      const u = res.result.usage
      const tokens = (u.promptTokens ?? 0) + (u.completionTokens ?? 0)
      let run: TestRunRow = {
        id: newId(),
        ts: Date.now(),
        sourceRepo: 'local-benchmark-preset',
        targetDesc: challenge.label,
        providerId: selection.providerId,
        model: res.result.model,
        framework: challenge.metric,
        passed: null,
        failed: null,
        errored: null,
        durationMs,
        exitCode: 0,
        tokens,
        attempts: 1,
        sandboxPath: null,
        generatedFiles: null,
        rawOutput: res.result.text,
        status: 'passed'
      }
      const persisted = await window.api.test.persistRun(run)
      if (persisted.ok) {
        run = persisted.run
      }
      return { model: res.result.model, providerId: selection.providerId, providerLabel: selection.providerLabel, pending: false, run }
    } catch (err) {
      return {
        model: selection.model,
        providerId: selection.providerId,
        providerLabel: selection.providerLabel,
        pending: false,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      currentReqId.current = null
    }
  }

  /** Generate with the selected provider → write into a fresh sandbox → run → metrics. */
  const runOne = async (
    selection: BenchmarkModelOption,
    config: RunConfig,
    context: TestRepoContext | null,
    sourcePath: string
  ): Promise<ResultItem> => {
    const reqId = newId()
    currentReqId.current = reqId
    setPhase(`generating tests with ${benchmarkOptionLabel(selection)}...`)
    let genText: string
    let tokens: number | undefined
    let runModel = selection.model
    try {
      const res = await window.api.chat.send({
        requestId: reqId,
        providerId: selection.providerId,
        model: selection.model || undefined,
        prompt: buildGenPrompt(config, context)
      })
      if (!res.ok) return { model: selection.model, providerId: selection.providerId, providerLabel: selection.providerLabel, pending: false, error: res.error }
      genText = res.result.text
      runModel = res.result.model
      const u = res.result.usage
      tokens = (u.promptTokens ?? 0) + (u.completionTokens ?? 0)
    } catch (err) {
      return {
        model: selection.model,
        providerId: selection.providerId,
        providerLabel: selection.providerLabel,
        pending: false,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      currentReqId.current = null
    }

    const code = extractCode(genText)
    if (!code) return { model: selection.model, providerId: selection.providerId, providerLabel: selection.providerLabel, pending: false, error: 'model did not return a fenced code block' }

    const runId = newId()
    currentRunId.current = runId
    setPhase(`running ${config.framework} in sandbox…`)
    try {
      const res = await window.api.test.run({
        runId,
        sourceRepo: sourcePath,
        targetDesc: effectiveTarget(),
        providerId: selection.providerId,
        model: runModel,
        framework: config.framework,
        testCommand: config.testCommand,
        installCommand: config.installCommand || undefined,
        installDeps,
        files: [{ path: config.testPath, content: code }],
        tokens,
        attempts: 1,
        timeoutMs: settings?.timeoutMs
      })
      if (!res.ok) return { model: selection.model, providerId: selection.providerId, providerLabel: selection.providerLabel, pending: false, error: res.error }
      return { model: runModel, providerId: selection.providerId, providerLabel: selection.providerLabel, pending: false, run: res.run }
    } catch (err) {
      return {
        model: selection.model,
        providerId: selection.providerId,
        providerLabel: selection.providerLabel,
        pending: false,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      currentRunId.current = null
    }
  }

  const recordBenchmarkResults = async (items: ResultItem[], challenge: TestType, metricName: TestMetric): Promise<void> => {
    const finished = items.filter((item) => item.run)
    if (finished.length === 0) return
    const ranked = rankResults(finished, metricName, challenge)
    const sourceLabel = challenge.metric === 'tests' ? sourceRepo.trim() || 'repo sandbox' : 'local preset'
    await Promise.all(
      finished.map((item) => {
        const run = item.run as TestRunRow
        const score = ranked.get(run.id)?.score ?? null
        const rank = ranked.get(run.id)?.rank ?? null
        const modelName = run.model || item.model || 'unknown'
        const runProviderId = run.providerId ?? item.providerId ?? 'unknown'
        const providerName = item.providerLabel ?? providerDisplayName(runProviderId, providers)
        return window.api.benchmark.upsert({
          challengeId: challenge.id,
          challengeLabel: challenge.label,
          category: challenge.category,
          metric: metricName,
          model: modelName,
          providerId: runProviderId,
          score,
          rank,
          status: run.status,
          durationMs: run.durationMs,
          tokens: run.tokens,
          runId: run.id,
          source: sourceLabel,
          summary: `${challenge.label} · ${providerName} · ${modelName}${score === null ? '' : ` · ${score}/100`}`,
          prompt: buildChallengePrompt(challenge),
          artifactPreview: run.rawOutput,
          mediaType: challenge.mediaType ?? 'none',
          mediaUrl: benchmarkMediaUrl(challenge),
          signature: `${challenge.id}::${runProviderId}::${modelName.toLowerCase()}`
        })
      })
    )
    refreshBenchmarks()
  }

  const needsRepo = testType.metric === 'tests'
  const canRun =
    !running &&
    (!needsRepo || Boolean(sourceRepo.trim())) &&
    selectedBenchmarkOptions.length > 0 &&
    !unavailableSelected

  const handleRun = async (): Promise<void> => {
    setError(null)
    if (!canRun) {
      if (needsRepo && !sourceRepo.trim()) setError('Pick a source repo.')
      else if (unavailableSelected) setError(`${benchmarkOptionLabel(unavailableSelected)} is unavailable: ${unavailableSelected.reason ?? 'provider is offline'}.`)
      else if (selectedBenchmarkOptions.length === 0) setError('Pick at least one available benchmark model.')
      return
    }

    const metric = testType.metric
    const models = selectedBenchmarkOptions

    // Repo-free challenges: run each model on the fixed local task once; rank
    // by throughput, token count, or artifact completeness.
    if (metric === 'latency' || metric === 'efficiency' || metric === 'artifact') {
      setRunning(true)
      setClearKey((k) => k + 1)
      setRanMetric(metric)
      setResults(models.map((option) => ({ model: option.model, providerId: option.providerId, providerLabel: option.providerLabel, pending: true })))
      const done: ResultItem[] = []
      for (let i = 0; i < models.length; i++) {
        const item = await challengeOne(models[i], testType)
        done.push(item)
        setResults((prev) => prev.map((r, idx) => (idx === i ? item : r)))
      }
      try {
        await recordBenchmarkResults(done, testType, metric)
        setBenchmarkExportNotice(null)
      } catch (err) {
        setBenchmarkExportNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
      refreshRecent()
      setRunning(false)
      setPhase('')
      return
    }

    const preparedSource = await prepareSourceRepo()
    if (!preparedSource) return

    let sourcePath = preparedSource
    let runConfig: RunConfig = { framework, testCommand, installCommand, testPath }
    let context = repoContext
    if (!runConfig.framework.trim() || !runConfig.testCommand.trim() || !runConfig.testPath.trim() || !context) {
      setPhase('detecting repo test runner…')
      const detected = await detect()
      if (!detected) {
        setPhase('')
        return
      }
      sourcePath = detected.sourceRepo
      runConfig = {
        framework: detected.detection.framework,
        testCommand: detected.detection.testCommand,
        installCommand: detected.detection.installCommand,
        testPath: detected.detection.suggestedTestPath
      }
      context = detected.context
    }
    // Never block the benchmark on a missing runner: fall back to Akorith's own
    // disposable Vitest sandbox so Detect → Generate → Run → Score always runs.
    if (!runConfig.testCommand.trim() || !runConfig.testPath.trim()) {
      const isTs = runConfig.testPath.endsWith('.ts') || runConfig.testPath.endsWith('.tsx') || framework === 'vitest'
      const fallbackPath = runConfig.testPath.trim() || `akorith.generated.test.${isTs ? 'ts' : 'js'}`
      runConfig = {
        framework: 'vitest',
        testCommand: `npx --yes vitest run --config akorith.vitest.config.mjs ${fallbackPath}`,
        installCommand: runConfig.installCommand || 'npm install',
        testPath: fallbackPath
      }
    }

    setRunning(true)
    setClearKey((k) => k + 1)
    setRanMetric('tests')
    setResults(models.map((option) => ({ model: option.model, providerId: option.providerId, providerLabel: option.providerLabel, pending: true })))
    const completed: ResultItem[] = []

    for (let i = 0; i < models.length; i++) {
      const item = await runOne(models[i], runConfig, context, sourcePath)
      completed.push(item)
      setResults((prev) => prev.map((r, idx) => (idx === i ? item : r)))
    }

    try {
      await recordBenchmarkResults(completed, testType, 'tests')
      setBenchmarkExportNotice(null)
    } catch (err) {
      setBenchmarkExportNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
    refreshRecent()
    // Objective leaderboard is derived from results at render — keep run ids
    // handy so the optional AI review panel can still be pointed at them.
    setSelectedRunIds(completed.map((item) => item.run?.id).filter((id): id is string => Boolean(id)))
    setRunning(false)
    setPhase('')
  }

  const stop = (): void => {
    if (currentRunId.current) window.api.test.stop(currentRunId.current)
    if (currentReqId.current) window.api.chat.cancel(currentReqId.current)
    setPhase('stopping…')
  }

  const isRepairable = (item: ResultItem): boolean =>
    Boolean(item.run) &&
    ['failed', 'error', 'no-tests', 'install-failed'].includes(item.run!.status ?? '') &&
    Boolean(item.run!.generatedFiles?.length)

  // Phase 14.1 "repair failed test": feed the failing test file + sandbox output
  // back to the model, ask for a corrected file, then rerun once in a fresh
  // sandbox. Source repo stays read-only; only the generated test changes.
  const repairOne = async (idx: number): Promise<void> => {
    const item = results[idx]
    const failedRun = item.run
    if (!failedRun || running || repairingIdx !== null) return
    const original = failedRun.generatedFiles?.[0]
    if (!original) return

    setRepairingIdx(idx)
    setError(null)
    const reqId = newId()
    currentReqId.current = reqId
    setPhase('repairing failing test…')
    const repairPrompt =
      `A generated ${failedRun.framework ?? framework} test file failed when run in a sandboxed copy of the repository. ` +
      `Fix the test file so it runs and passes against the REAL code. Keep it honest — do not weaken assertions just to pass; ` +
      `correct wrong imports, wrong export names, syntax errors, or unsupported assumptions.\n\n` +
      `Test command: ${testCommand}\nFile path: ${original.path}\n\n` +
      `Current failing test file:\n\`\`\`\n${original.content}\n\`\`\`\n\n` +
      `Sandbox output / failure:\n\`\`\`\n${(failedRun.rawOutput ?? '').slice(-4000)}\n\`\`\`\n` +
      buildStructureBlock() +
      `\nRespond with ONLY the corrected, complete test file inside a single fenced code block — no prose.`

    let genText: string
    let runModel = failedRun.model ?? model
    let tokens: number | undefined
    const repairProviderId = failedRun.providerId || item.providerId || providerId || 'local'
    const repairProviderLabel = item.providerLabel ?? providerDisplayName(repairProviderId, providers)
    try {
      const res = await window.api.chat.send({ requestId: reqId, providerId: repairProviderId, model: failedRun.model || model || undefined, prompt: repairPrompt })
      if (!res.ok) {
        setResults((prev) => prev.map((r, i) => (i === idx ? { ...r, error: `repair failed: ${res.error}` } : r)))
        return
      }
      genText = res.result.text
      runModel = res.result.model
      const u = res.result.usage
      tokens = (u.promptTokens ?? 0) + (u.completionTokens ?? 0)
    } catch (err) {
      setResults((prev) => prev.map((r, i) => (i === idx ? { ...r, error: err instanceof Error ? err.message : String(err) } : r)))
      return
    } finally {
      currentReqId.current = null
    }

    const code = extractCode(genText)
    if (!code) {
      setResults((prev) => prev.map((r, i) => (i === idx ? { ...r, error: 'repair did not return a fenced code block' } : r)))
      setRepairingIdx(null)
      setPhase('')
      return
    }

    const runId = newId()
    currentRunId.current = runId
    setClearKey((k) => k + 1)
    setResults((prev) => prev.map((r, i) => (i === idx ? { ...r, pending: true } : r)))
    setPhase(`re-running repaired ${framework} in sandbox…`)
    try {
      const res = await window.api.test.run({
        runId,
        sourceRepo: failedRun.sourceRepo || sourceRepo.trim(),
        targetDesc: `repair: ${effectiveTarget()}`,
        providerId: repairProviderId,
        model: runModel,
        framework,
        testCommand,
        installCommand: installCommand || undefined,
        installDeps,
        files: [{ path: original.path, content: code }],
        tokens,
        attempts: (failedRun.attempts ?? 1) + 1,
        timeoutMs: settings?.timeoutMs
      })
      const next: ResultItem = res.ok
        ? { model: runModel, providerId: repairProviderId, providerLabel: repairProviderLabel, pending: false, run: res.run }
        : { model: runModel, providerId: repairProviderId, providerLabel: repairProviderLabel, pending: false, error: res.error }
      setResults((prev) => prev.map((r, i) => (i === idx ? next : r)))
      refreshRecent()
      if (res.ok) {
        setSelectedRunIds([res.run.id])
        setLatestEvaluation(null)
      }
    } catch (err) {
      setResults((prev) => prev.map((r, i) => (i === idx ? { ...r, pending: false, error: err instanceof Error ? err.message : String(err) } : r)))
    } finally {
      currentRunId.current = null
      setRepairingIdx(null)
      setPhase('')
    }
  }

  const metric = (run: TestRunRow): string => {
    const p = run.passed ?? 0
    const f = run.failed ?? 0
    const e = run.errored ?? 0
    const tot = p + f + e
    return tot > 0 ? `${p}/${tot} passed${f ? `, ${f} failed` : ''}${e ? `, ${e} err` : ''}` : run.status ?? '—'
  }

  const toggleRunSelection = (runId: string): void => {
    setSelectedRunIds((prev) => (prev.includes(runId) ? prev.filter((id) => id !== runId) : [...prev, runId]))
    setLatestEvaluation(null)
  }

  const runEvaluation = async (
    runIds = selectedRunIds,
    opts: { includeQuality?: boolean } = {}
  ): Promise<EvaluationRow | null> => {
    const wantsQuality = opts.includeQuality ?? true
    setEvalError(null)
    if (runIds.length === 0) {
      setEvalError('Select at least one finished run.')
      return null
    }
    if (wantsQuality && !judgeProviderId) {
      setEvalError('Pick Local, Claude, or ChatGPT to score this run.')
      return null
    }
    setEvaluating(true)
    try {
      const res = await window.api.evaluate.run({
        testRunIds: runIds,
        includeQuality: wantsQuality,
        judgeProviderId: wantsQuality ? judgeProviderId : undefined,
        judgeModel: wantsQuality ? judgeModel || undefined : undefined
      })
      if (!res.ok) {
        setEvalError(res.error)
        return null
      }
      setLatestEvaluation(res.evaluation)
      setSelectedRunIds(res.evaluation.testRunIds)
      refreshEvaluations()
      return res.evaluation
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setEvaluating(false)
    }
  }

  const exportPdf = async (evaluation: EvaluationRow): Promise<void> => {
    setPdfBusyId(evaluation.id)
    setEvalError(null)
    setPdfNotice(null)
    try {
      const res = await window.api.evaluate.exportPdf(evaluation.id)
      if (!res.ok) {
        setEvalError(res.error)
        setPdfNotice({ kind: 'error', text: res.error })
        return
      }
      setLatestEvaluation(res.evaluation)
      setPdfNotice({ kind: 'ok', text: `Saved PDF to ${res.pdfPath}` })
      refreshEvaluations()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setEvalError(message)
      setPdfNotice({ kind: 'error', text: message })
    } finally {
      setPdfBusyId(null)
    }
  }

  const revealPdf = async (evaluation: EvaluationRow): Promise<void> => {
    setPdfNotice(null)
    const res = await window.api.evaluate.revealPdf(evaluation.id)
    if (!res.ok) {
      setEvalError(res.error)
      setPdfNotice({ kind: 'error', text: res.error })
      return
    }
    setPdfNotice({ kind: 'ok', text: `Revealed PDF in Finder: ${evaluation.pdfPath}` })
  }

  const openPdf = async (evaluation: EvaluationRow): Promise<void> => {
    setPdfNotice(null)
    const res = await window.api.evaluate.openPdf(evaluation.id)
    if (!res.ok) {
      setEvalError(res.error)
      setPdfNotice({ kind: 'error', text: res.error })
      return
    }
    setPdfNotice({ kind: 'ok', text: `Opened PDF: ${evaluation.pdfPath}` })
  }

  const exportBenchmarkLibrary = async (): Promise<void> => {
    setBenchmarkExportNotice(null)
    const res = await window.api.benchmark.exportForWeb()
    if (!res.ok) {
      setBenchmarkExportNotice({ kind: 'error', text: res.error })
      return
    }
    setBenchmarkExportNotice({ kind: 'ok', text: `Exported ${res.count} benchmark${res.count === 1 ? '' : 's'} to ${res.path}` })
    refreshBenchmarks()
  }

  // Objective leaderboard for the current results (computed here, not by a model).
  const ranking = rankResults(results, ranMetric, testType)
  const leaderboard = results
    .filter((r) => r.run)
    .slice()
    .sort((a, b) => (ranking.get(a.run!.id)?.rank ?? 99) - (ranking.get(b.run!.id)?.rank ?? 99))
  const anyPending = results.some((r) => r.pending)
  // tokens/sec for latency rows
  const tps = (run: TestRunRow): number => {
    const secs = (run.durationMs ?? 0) / 1000
    return secs > 0 ? Math.round((run.tokens ?? 0) / secs) : 0
  }
  const challengeSections = (['general', 'ui', 'game', 'repo'] as BenchmarkCategory[])
    .map((category) => ({
      category,
      label: categoryLabel(category),
      items: TEST_TYPES.filter((t) => t.category === category)
    }))
    .filter((section) => section.items.length > 0)
  const benchmarkSummary = {
    total: benchmarks.length,
    visual: benchmarks.filter((entry) => entry.category === 'ui' || entry.category === 'game').length,
    exported: benchmarks.filter((entry) => entry.mediaType !== 'none').length
  }
  const benchmarkPerformance = summarizeBenchmarkPerformance(benchmarks, providers)
  const benchmarkCategorySummary = (['general', 'ui', 'game', 'repo'] as BenchmarkCategory[]).map((category) => ({
    category,
    label: categoryLabel(category),
    count: benchmarks.filter((entry) => entry.category === category).length
  }))
  const selectedModelSummary = selectedBenchmarkOptions.length
    ? selectedBenchmarkOptions
        .slice(0, 2)
        .map((option) => benchmarkOptionLabel(option))
        .join('  ·  ')
    : 'No models selected'

  return (
    <div className={`test-page ${sandboxOpen ? '' : 'sandbox-collapsed'}`}>
      <div className="test-config">
        <div className="test-topbar">
          <button
            type="button"
            className={`sandbox-toggle-btn ${sandboxOpen ? 'is-active' : ''}`}
            onClick={() => setSandboxOpen((v) => !v)}
            title="Show the disposable sandbox output stream"
          >
            <span className="sandbox-toggle-dot" />
            Sandbox output
          </button>
          <span className="bench-local-pill">CLI + local providers</span>
        </div>
        <header className="benchmark-header">
          <div>
            <h2>Benchmark</h2>
            <p>Run the same challenge across models and compare objective performance.</p>
          </div>
          <div className="benchmark-header-meta" aria-label="Benchmark summary">
            <span><strong>{selectedBenchmarkOptions.length}</strong> models</span>
            <span><strong>{benchmarks.length}</strong> saved</span>
          </div>
        </header>

        <section className="benchmark-launch" aria-label="Benchmark setup">
          <details className="benchmark-picker">
            <summary>
              <span>
                <small>Models</small>
                <strong>{selectedModelSummary}</strong>
              </span>
              <em>{selectedBenchmarkOptions.length} selected</em>
            </summary>
            {benchmarkProviderGroups.length > 0 ? (
              <div className="benchmark-picker-body">
                <div className="test-model-toolbar">
                  <button
                    type="button"
                    className="test-table-btn"
                    onClick={() => {
                      const next = availableBenchmarkOptions.map((option) => option.key)
                      setSelectedModels(next)
                      const first = availableBenchmarkOptions[0]
                      if (first) {
                        setProviderId(first.providerId)
                        setModel(first.model)
                      }
                    }}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="test-table-btn"
                    onClick={() => {
                      const next = availableBenchmarkOptions.slice(0, 2)
                      setSelectedModels(next.map((option) => option.key))
                      const first = next[0]
                      if (first) {
                        setProviderId(first.providerId)
                        setModel(first.model)
                      }
                    }}
                  >
                    Two model battle
                  </button>
                </div>
                <div className="test-provider-stack">
                  {benchmarkProviderGroups.map((group) => (
                    <div key={group.provider.id} className={`test-provider-group ${group.available ? '' : 'is-offline'}`}>
                      <div className="test-provider-head">
                        <strong>{group.provider.id === 'chatgpt' ? 'Codex/GPT' : group.provider.label}</strong>
                        <span>{group.available ? `${group.options.length} model${group.options.length === 1 ? '' : 's'}` : group.provider.available.reason ?? 'offline'}</span>
                      </div>
                      <div className="test-model-grid">
                        {group.options.map((option) => {
                          const checked = selectedModels.includes(option.key)
                          return (
                            <label
                              key={option.key}
                              className={`test-model-card ${checked ? 'is-selected' : ''} ${option.available ? '' : 'is-disabled'}`}
                              title={option.available ? benchmarkOptionLabel(option) : option.reason ?? 'Provider unavailable'}
                            >
                              <input type="checkbox" checked={checked} disabled={!option.available} onChange={() => toggleModel(option)} />
                              <span>{option.model}</span>
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="test-notice">Waiting for benchmark providers. Start Ollama, sign in to Codex/Claude/OpenCode, or enable providers in Settings.</div>
            )}
          </details>

          <label className="benchmark-challenge-select">
            <span>
              <small>Challenge</small>
              <strong>{testType.scoreHint ?? 'Objective metrics'}</strong>
            </span>
            <select value={testTypeId} onChange={(event) => void applyTestType(event.target.value)}>
              {challengeSections.map((section) => (
                <optgroup key={section.category} label={section.label}>
                  {section.items.map((challenge) => (
                    <option key={challenge.id} value={challenge.id}>{challenge.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </section>

        {needsRepo && <details className="benchmark-repo-source" open>
          <summary>
            <span>Repository source</span>
            <small>{sourceRepo || 'Required for this challenge'}</small>
          </summary>
          <div className="benchmark-repo-body">
            <div className="test-source-tabs">
              <button type="button" className={sourceMode === 'folder' ? 'is-selected' : ''} onClick={() => setSourceMode('folder')}>
                Folder
              </button>
              <button type="button" className={sourceMode === 'github' ? 'is-selected' : ''} onClick={() => setSourceMode('github')}>
                GitHub link
              </button>
            </div>
            {sourceMode === 'folder' ? (
              <div className="test-source-box">
                {projectOptions.length > 0 && (
                  <label className="test-field">
                    <span>Saved project</span>
                    <select
                      value={selectedProjectPath}
                      onChange={(e) => {
                        setSourceRepo(e.target.value)
                        setDetection(null)
                        setRepoContext(null)
                        setSourceNotice(null)
                        setError(null)
                      }}
                    >
                      <option value="">Choose a saved project or browse...</option>
                      {projectOptions.map((project) => (
                        <option key={project.id} value={project.path ?? ''}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="test-row">
                  <input type="text" value={sourceRepo} placeholder="No folder selected" readOnly spellCheck={false} />
                  <button type="button" className="test-btn" onClick={() => void chooseFolder()}>
                    Choose folder
                  </button>
                </div>
              </div>
            ) : (
              <label className="test-field">
                <span>GitHub repository URL</span>
                <div className="test-row">
                  <input
                    type="text"
                    value={sourceRepo}
                    placeholder="https://github.com/owner/repo"
                    onChange={(e) => {
                      setSourceRepo(e.target.value)
                      setSourceNotice(null)
                      setDetection(null)
                      setRepoContext(null)
                    }}
                    spellCheck={false}
                  />
                  <button type="button" className="test-btn" onClick={() => void detect()}>
                    Detect
                  </button>
                </div>
              </label>
            )}
            {sourceNotice && <div className="test-detected">{sourceNotice}</div>}
            {detection && (
              <div className="test-detected">
                Detected: <strong>{detection.framework}</strong>
                {detection.lockfile ? ` · lockfile ${detection.lockfile}` : ''}
                {detection.note ? ` · ${detection.note}` : ''}
              </div>
            )}
          </div>
        </details>}

        {/* Advanced: auto-filled sandbox runner details, only needed when detection misses. */}
        {needsRepo && <details className="test-advanced">
          <summary>Sandbox runner details</summary>
          <div className="test-grid">
            <label className="test-field">
              <span>Framework</span>
              <input value={framework} onChange={(e) => setFramework(e.target.value)} spellCheck={false} />
            </label>
            <label className="test-field">
              <span>Test file path (in sandbox)</span>
              <input value={testPath} onChange={(e) => setTestPath(e.target.value)} spellCheck={false} />
            </label>
          </div>
          <label className="test-field">
            <span>Test command</span>
            <input value={testCommand} onChange={(e) => setTestCommand(e.target.value)} spellCheck={false} placeholder="e.g. python3 -m pytest -q" />
          </label>
          <div className="test-grid">
            <label className="test-field">
              <span>Install command</span>
              <input value={installCommand} onChange={(e) => setInstallCommand(e.target.value)} spellCheck={false} placeholder="(optional)" />
            </label>
            <label className="test-toggle">
              <input type="checkbox" checked={installDeps} onChange={() => setInstallDeps((v) => !v)} />
              Install deps in sandbox
            </label>
          </div>
        </details>}

        <div className="test-actions">
          {running ? (
            <button type="button" className="test-btn is-stop" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="button" className="test-btn is-primary" disabled={!canRun} onClick={() => void handleRun()}>
              {selectedBenchmarkOptions.length > 1 ? `Battle ${selectedBenchmarkOptions.length} models` : 'Run benchmark'}
            </button>
          )}
          {phase && <span className="test-phase">{phase}</span>}
        </div>
        {error && <div className="test-notice">{error}</div>}

        {results.length > 0 && (
          <div className="bench-board">
            <div className="bench-board-head">
              <span className="test-recent-title">Leaderboard</span>
              <span className="test-hint">
                {ranMetric === 'latency'
                  ? 'ranked by throughput (tokens/sec)'
                  : ranMetric === 'efficiency'
                    ? 'ranked by token efficiency (fewest tokens)'
                    : ranMetric === 'artifact'
                      ? 'ranked by deliverables, structure, speed, and token discipline'
                      : 'ranked by tests passed, then speed'}
              </span>
            </div>

            {/* Purple → green score graph: one column per finished model,
                height ∝ score. The winner column is green, the rest purple. */}
            {leaderboard.length > 0 && (
              <div className="bench-chart">
                {leaderboard.map((r) => {
                  const run = r.run as TestRunRow
                  const rank = ranking.get(run.id)?.rank ?? 0
                  const score = ranking.get(run.id)?.score ?? 0
                  const label = resultLabel(r, providers)
                  return (
                    <div key={run.id} className="bench-col">
                      <span className="bench-col-score">{score}</span>
                      <div className="bench-col-track">
                        <div
                          className={`bench-col-fill ${rank === 1 ? 'is-top' : ''}`}
                          style={{ height: `${Math.max(score, 3)}%` }}
                        />
                      </div>
                      <span className="bench-col-name" title={label}>
                        {label.replace(/:.*$/, '')}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Finished rows first, ranked; pending/errored models below. */}
            {leaderboard.map((r) => {
              const run = r.run as TestRunRow
              const rank = ranking.get(run.id)?.rank ?? 0
              const score = ranking.get(run.id)?.score ?? 0
              const i = results.indexOf(r)
              const label = resultLabel(r, providers)
              return (
                <div key={run.id} className={`bench-row ${rank === 1 ? 'is-top' : ''}`}>
                  <div className="bench-rank">{rank === 1 ? '★' : rank}</div>
                  <div className="bench-model">
                    <strong>{label}</strong>
                    <span className={`bench-status ${statusColor(run.status)}`}>
                      {ranMetric === 'tests' ? run.status : 'timed'}
                    </span>
                  </div>
                  <div className="bench-metrics">
                    {ranMetric === 'artifact' ? (
                      <>
                        <span><strong>{run.tokens ?? 0}</strong> tok</span>
                        <span>{run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'}</span>
                        <span>{tps(run)} tok/s</span>
                      </>
                    ) : ranMetric === 'efficiency' ? (
                      <>
                        <span><strong>{run.tokens ?? 0}</strong> tok</span>
                        <span>{run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'}</span>
                        <span>{tps(run)} tok/s</span>
                      </>
                    ) : ranMetric === 'latency' ? (
                      <>
                        <span><strong>{tps(run)}</strong> tok/s</span>
                        <span>{run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'}</span>
                        <span>{run.tokens ?? 0} tok</span>
                      </>
                    ) : (
                      <>
                        <span>{metric(run)}</span>
                        <span>{run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'}</span>
                        <span>{run.tokens ?? 0} tok</span>
                      </>
                    )}
                  </div>
                  <div className="bench-score">
                    <div className="bench-score-bar"><div style={{ width: `${score}%` }} /></div>
                    <strong>{score}</strong>
                    {rank === 1 && leaderboard.length > 1 && <span className="bench-winner">WINNER</span>}
                  </div>
                  {ranMetric === 'tests' && isRepairable(r) && (
                    <button
                      type="button"
                      className="test-mini-btn"
                      disabled={running || repairingIdx !== null}
                      title="Send the failing test + sandbox output back to the model, then rerun once"
                      onClick={() => void repairOne(i)}
                    >
                      {repairingIdx === i ? 'Repairing…' : 'Repair & rerun'}
                    </button>
                  )}
                </div>
              )
            })}

            {results
              .filter((r) => !r.run)
              .map((r, i) => (
                <div key={`p-${i}`} className="bench-row is-muted">
                  <div className="bench-rank">·</div>
                  <div className="bench-model">
                    <strong>{resultLabel(r, providers)}</strong>
                    <span className="bench-status">{r.pending ? 'running…' : r.error ? 'error' : '—'}</span>
                  </div>
                  <div className="bench-metrics">
                    <span className="bench-note">{r.pending ? 'running…' : 'no result — skipped in ranking'}</span>
                  </div>
                </div>
              ))}

            {!anyPending && leaderboard.length > 1 && (
              <div className="test-hint bench-foot">
                {resultLabel(leaderboard[0], providers)}{' '}
                {ranMetric === 'latency' ? 'is fastest' : ranMetric === 'efficiency' ? 'is leanest' : ranMetric === 'artifact' ? 'has the strongest artifact score' : 'leads'} this
                benchmark.
              </div>
            )}
          </div>
        )}

        <section className="benchmark-library">
          <div className="benchmark-library-head">
            <div>
              <span className="test-recent-title">Benchmark library</span>
              <p className="test-hint">
                Unique provider + model + challenge results are kept here and exported to akorith.space.
              </p>
            </div>
            <div className="benchmark-library-actions">
              <span>{benchmarkSummary.total} saved</span>
              <span>{benchmarkSummary.visual} visual</span>
              <span>{benchmarkSummary.exported} media-ready</span>
              <button type="button" className="test-table-btn" onClick={() => void exportBenchmarkLibrary()}>
                Export web JSON
              </button>
            </div>
          </div>
          {benchmarkExportNotice && <div className={`pdf-notice ${benchmarkExportNotice.kind}`}>{benchmarkExportNotice.text}</div>}
          {benchmarks.length === 0 ? (
            <div className="benchmark-empty">
              Run a benchmark to publish its latest provider/model/challenge result into the library.
            </div>
          ) : (
            <>
              <div className="benchmark-library-viz">
                <section className="benchmark-performance-panel" aria-labelledby="benchmark-performance-title">
                  <div className="benchmark-panel-title">
                    <div>
                      <strong id="benchmark-performance-title">Model performance</strong>
                      <span>Average score across saved challenges</span>
                    </div>
                    <div className="benchmark-axis" aria-hidden="true"><span>0</span><span>50</span><span>100</span></div>
                  </div>
                  <div className="benchmark-performance-chart">
                    {benchmarkPerformance.map((item, index) => (
                      <div className="benchmark-performance-row" key={item.key}>
                        <span className="benchmark-performance-rank">{index + 1}</span>
                        <span className="benchmark-performance-name" title={item.label}>{item.label}</span>
                        <div
                          className="benchmark-performance-track"
                          role="img"
                          aria-label={`${item.label}: average score ${item.averageScore} out of 100`}
                        >
                          <span style={{ width: `${Math.max(item.averageScore, 2)}%` }} />
                        </div>
                        <strong>{item.averageScore}</strong>
                        <span className="benchmark-performance-meta">
                          {item.runs} run{item.runs === 1 ? '' : 's'}
                          {item.averageDurationMs == null ? '' : ` · ${(item.averageDurationMs / 1000).toFixed(1)}s`}
                          {item.averageTokens == null ? '' : ` · ${item.averageTokens} tok`}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>

                <aside className="benchmark-category-panel" aria-labelledby="benchmark-category-title">
                  <div className="benchmark-panel-title">
                    <div>
                      <strong id="benchmark-category-title">Coverage</strong>
                      <span>Saved result mix</span>
                    </div>
                  </div>
                  <div className="benchmark-category-chart">
                    {benchmarkCategorySummary.map((item) => (
                      <div key={item.category}>
                        <span>{item.label}</span>
                        <div role="img" aria-label={`${item.label}: ${item.count} saved results`}>
                          <span style={{ width: `${benchmarkSummary.total ? (item.count / benchmarkSummary.total) * 100 : 0}%` }} />
                        </div>
                        <strong>{item.count}</strong>
                      </div>
                    ))}
                  </div>
                </aside>
              </div>

              <div className="benchmark-recent-visual">
                <div className="benchmark-panel-title">
                  <div>
                    <strong>Recent results</strong>
                    <span>Latest challenge snapshots</span>
                  </div>
                </div>
                <div className="benchmark-recent-grid">
                  {benchmarks.slice(0, 8).map((entry) => {
                    const providerName = providerDisplayName(entry.providerId ?? 'unknown', providers)
                    const modelName = `${providerName} · ${entry.model}`
                    return (
                      <article key={entry.id} className={`benchmark-recent-card is-${entry.category}`}>
                        <div>
                          <span>{entry.challengeLabel}</span>
                          <strong title={modelName}>{modelName}</strong>
                        </div>
                        <div className="benchmark-recent-score">
                          <span><i style={{ width: `${Math.max(entry.score ?? 0, 2)}%` }} /></span>
                          <strong>{entry.score ?? '—'}</strong>
                        </div>
                        <small>
                          {entry.durationMs == null ? '—' : `${(entry.durationMs / 1000).toFixed(1)}s`} · {entry.tokens ?? 0} tok
                        </small>
                      </article>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </section>

        <details className="test-optional-review">
          <summary>Optional: AI quality review &amp; PDF (off by default — the leaderboard above is objective)</summary>
        <div className="test-evaluate">
          <div className="test-evaluate-head">
            <div>
              <div className="test-recent-title">Review and PDF</div>
              <div className="test-hint">
                {selectedRunIds.length === 0
                  ? 'Select finished runs below.'
                  : `${selectedRunIds.length} run${selectedRunIds.length === 1 ? '' : 's'} selected`}
              </div>
            </div>
            <button
              type="button"
              className="test-btn is-primary"
              disabled={evaluating || selectedRunIds.length === 0 || !judgeProviderId}
              onClick={() => void runEvaluation()}
            >
              {evaluating ? 'Scoring…' : 'Re-score selected runs'}
            </button>
          </div>

          <div className="test-grid">
              <label className="test-field">
                <span>Score provider</span>
                <select value={judgeProviderId} onChange={(e) => setJudgeProviderId(e.target.value)}>
                  {judgeProviders.length === 0 && <option value="">No available judge</option>}
                  {judgeProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              {judgeSelected && judgeSelected.models.length > 0 && (
                <label className="test-field">
                  <span>Score model</span>
                  <select value={judgeModel} onChange={(e) => setJudgeModel(e.target.value)}>
                    {judgeSelected.models.map((m) => (
                      <option key={m} value={m}>
                        {formatModelLabel(m, judgeSelected.id)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

          {evalError && <div className="test-error">{evalError}</div>}
          {pdfNotice && <div className={`pdf-notice ${pdfNotice.kind}`}>{pdfNotice.text}</div>}

          {latestEvaluation && (
            <div className="isa-card">
              <div className="isa-card-head">
                <div>
                  <div className="isa-title">
                    ISAScore {latestEvaluation.totalScore.toFixed(1)} · {latestEvaluation.kind}
                  </div>
                  <div className="isa-meta">
                    Judge: {latestEvaluation.judgeModel ?? 'objective-only'} · {new Date(latestEvaluation.ts).toLocaleString()}
                  </div>
                </div>
                <div className="isa-actions">
                  <button
                    type="button"
                    className="test-btn"
                    disabled={pdfBusyId === latestEvaluation.id}
                    onClick={() => void exportPdf(latestEvaluation)}
                  >
                    {pdfBusyId === latestEvaluation.id ? 'Exporting…' : 'Export PDF'}
                  </button>
                  {latestEvaluation.pdfPath && (
                    <>
                      <button type="button" className="test-btn" onClick={() => void revealPdf(latestEvaluation)}>
                        Reveal
                      </button>
                      <button type="button" className="test-btn" onClick={() => void openPdf(latestEvaluation)}>
                        Open
                      </button>
                    </>
                  )}
                </div>
              </div>
              {latestEvaluation.pdfPath && <div className="pdf-path">PDF: {latestEvaluation.pdfPath}</div>}
              {evaluationWarning(latestEvaluation) && <div className="isa-warning">{evaluationWarning(latestEvaluation)}</div>}
              <div className="isa-runs">
                {[...latestEvaluation.dimensionScores.runs]
                  .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
                  .map((run) => (
                    <div className="isa-run" key={run.testRunId}>
                      <div className="isa-run-head">
                        <span>
                          #{run.rank ?? '—'} {run.model}
                        </span>
                        <strong>{run.totalScore.toFixed(1)}</strong>
                      </div>
                      <div className="isa-dims">
                        {SCORE_DIMS.map((dim) => {
                          const d = run.dimensions[dim]
                          return (
                            <div className={`isa-dim ${d.omitted ? 'is-omitted' : ''}`} key={dim} title={d.formula}>
                              <span>{dim}</span>
                              <strong>{scoreLabel(d.score)}</strong>
                              <em>{Math.round(d.effectiveWeight * 100)}%</em>
                            </div>
                          )
                        })}
                      </div>
                      {run.qualityRationale && <div className="isa-rationale">{run.qualityRationale}</div>}
                    </div>
                  ))}
              </div>
              {latestEvaluation.rationale && <div className="isa-rationale">{latestEvaluation.rationale}</div>}
            </div>
          )}
        </div>
        </details>

        <details className="test-optional-review legacy-runs">
          <summary>Raw run history &amp; past evaluations</summary>
        <div className="test-recent">
          <div className="test-recent-title">Recent runs</div>
          {recent.length === 0 ? (
            <div className="test-hint">No runs yet.</div>
          ) : (
            <table className="test-recent-table">
              <thead>
                <tr>
                  <th></th>
                  <th>when</th>
                  <th>model</th>
                  <th>fw</th>
                  <th>result</th>
                  <th>dur</th>
                  <th>tok</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className={`${statusColor(r.status)} ${selectedRunIds.includes(r.id) ? 'is-selected' : ''}`}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedRunIds.includes(r.id)}
                        onChange={() => toggleRunSelection(r.id)}
                      />
                    </td>
                    <td>{new Date(r.ts).toLocaleTimeString()}</td>
                    <td title={r.model ?? ''}>{r.model ?? '—'}</td>
                    <td>{r.framework ?? '—'}</td>
                    <td>{metric(r)}</td>
                    <td>{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                    <td>{r.tokens ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="test-recent">
          <div className="test-recent-title">Past evaluations</div>
          {evaluations.length === 0 ? (
            <div className="test-hint">No evaluations yet.</div>
          ) : (
            <table className="test-recent-table">
              <thead>
                <tr>
                  <th>when</th>
                  <th>kind</th>
                  <th>judge</th>
                  <th>score</th>
                  <th>pdf</th>
                </tr>
              </thead>
              <tbody>
                {evaluations.map((ev) => (
                  <tr key={ev.id}>
                    <td>{new Date(ev.ts).toLocaleTimeString()}</td>
                    <td>{ev.kind}</td>
                    <td title={ev.judgeModel ?? 'objective-only'}>{ev.judgeModel ?? 'objective-only'}</td>
                    <td>{ev.totalScore.toFixed(1)}</td>
                    <td>
                      <button type="button" className="test-table-btn" onClick={() => setLatestEvaluation(ev)}>
                        View
                      </button>
                      {ev.pdfPath ? (
                        <>
                          <button type="button" className="test-table-btn" onClick={() => void revealPdf(ev)}>
                            Reveal
                          </button>
                          <button type="button" className="test-table-btn" onClick={() => void openPdf(ev)}>
                            Open
                          </button>
                        </>
                      ) : (
                        <button type="button" className="test-table-btn" onClick={() => void exportPdf(ev)}>
                          PDF
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        </details>
      </div>

      {sandboxOpen && (
        <div className="test-terminal-col">
          <div className="test-terminal-header">
            <div>
              <span>Sandbox output</span>
              <strong>{phase || 'Idle'}</strong>
            </div>
            <button
              type="button"
              className="test-sandbox-toggle"
              aria-expanded={sandboxOpen}
              title="Hide sandbox"
              onClick={() => setSandboxOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className="test-sandbox-rail">
              <div className={detection ? 'is-done' : ''}>
                <span>01</span>
                <strong>Detect</strong>
              </div>
              <div className={running || results.length > 0 ? 'is-done' : ''}>
                <span>02</span>
                <strong>Generate</strong>
              </div>
              <div className={results.some((r) => r.run) ? 'is-done' : ''}>
                <span>03</span>
                <strong>Run</strong>
              </div>
              <div className={results.some((r) => r.run) ? 'is-done' : ''}>
                <span>04</span>
                <strong>Score</strong>
              </div>
            </div>
            <TestTerminal clearKey={clearKey} active={active} />
        </div>
      )}
    </div>
  )
}
