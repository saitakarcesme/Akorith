import { useCallback, useEffect, useRef, useState } from 'react'
import type {
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
  pending: boolean
  run?: TestRunRow
  error?: string
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

// Benchmark test types. Every model in a run gets the same type; they're then
// ranked on objective metrics (no model judges another). Most types work by
// "generate tests → run in sandbox" and are scored on tests passed + speed.
// The 'latency' type is different: it runs no test files, it times raw model
// response on a fixed task and ranks by throughput.
type TestMetric = 'tests' | 'latency' | 'efficiency'
interface TestType {
  id: string
  label: string
  blurb: string
  metric: TestMetric
  focus?: string
}
const TEST_TYPES: TestType[] = [
  {
    id: 'bug',
    label: 'Bug hunt & correctness',
    blurb: 'Reproduce bugs and cover core logic — ranked by tests passed.',
    metric: 'tests',
    focus:
      'Find likely regressions and fragile logic; write focused tests that reproduce bugs or edge-case failures, and cover the most valuable stable behavior with correct assertions.'
  },
  {
    id: 'ui',
    label: 'UI / behavior',
    blurb: 'For React/UI repos: visible behavior, state, interactions.',
    metric: 'tests',
    focus:
      'For React/UI repos, test visible behavior, state changes, and user interactions without brittle snapshots.'
  },
  {
    id: 'unit',
    label: 'Unit logic',
    blurb: 'Small deterministic tests over pure utility & domain logic.',
    metric: 'tests',
    focus: 'Cover pure utility and domain logic with small deterministic unit tests.'
  },
  {
    id: 'edge',
    label: 'Edge cases',
    blurb: 'Boundary values, empty & malformed inputs, odd state.',
    metric: 'tests',
    focus: 'Stress boundary values, empty inputs, malformed data, and unusual state transitions.'
  },
  {
    id: 'security',
    label: 'Security probing',
    blurb: 'Validation, injection, path traversal, trust boundaries.',
    metric: 'tests',
    focus:
      'Probe security-sensitive behavior: validation, injection, path traversal, unsafe parsing, permissions, and trust boundaries.'
  },
  {
    id: 'reasoning',
    label: 'Reasoning & algorithms',
    blurb: 'Multi-step logic, computed results, algorithmic correctness.',
    metric: 'tests',
    focus:
      'Exercise multi-step logic and algorithms: assert exact computed results across representative and tricky inputs, including ordering, recursion, and state transitions.'
  },
  {
    id: 'integration',
    label: 'Integration',
    blurb: 'How modules combine — cross-function and end-to-end paths.',
    metric: 'tests',
    focus:
      'Test how multiple modules work together: compose several real functions/classes in one flow and assert the combined end-to-end behavior, not just isolated units.'
  },
  {
    id: 'latency',
    label: 'Latency & throughput',
    blurb: 'No test files — pure speed on a fixed task (tokens/sec, total time).',
    metric: 'latency'
  },
  {
    id: 'efficiency',
    label: 'Token efficiency',
    blurb: 'No test files — who solves the fixed task in the fewest tokens.',
    metric: 'efficiency'
  }
]

// Fixed, repo-independent prompt used by the latency benchmark so every model
// does comparable work. Kept deterministic (temperature aside) and self-contained.
const LATENCY_PROMPT =
  'Write a single self-contained function `debounce(fn, waitMs)` in TypeScript that delays calling ' +
  '`fn` until `waitMs` has elapsed since the last call, cancels pending calls on each new call, and ' +
  'preserves `this` and arguments. Include a 3-sentence explanation of how it works. Respond concisely.'

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

// Rank a cohort. Higher score wins; ties broken by speed (lower durationMs).
function rankResults(items: ResultItem[], metric: TestMetric): Map<string, Ranked> {
  const scored = items
    .filter((it) => it.run)
    .map((it) => {
      const run = it.run as TestRunRow
      const raw = metric === 'tests' ? scoreTestsRun(run) : 0
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

  const [testTypeId, setTestTypeId] = useState('bug')
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
  const selected = localProvider
  const modelOptions = selected?.models ?? []
  const judgeProviders = providers.filter((p) => p.available.ok && (p.id === 'local' || p.id === 'claude' || p.id === 'chatgpt'))
  const judgeSelected = judgeProviders.find((p) => p.id === judgeProviderId)
  const projectOptions = projects.filter((project) => Boolean(project.path))
  const selectedProjectPath = projectOptions.find((project) => project.path === sourceRepo)?.path ?? ''

  const refreshRecent = useCallback(() => {
    void window.api.test.listRuns(12).then(setRecent).catch(() => setRecent([]))
  }, [])

  const refreshEvaluations = useCallback(() => {
    void window.api.evaluate.list(12).then(setEvaluations).catch(() => setEvaluations([]))
  }, [])

  const refreshProviders = useCallback(async () => {
    try {
      const list = await window.api.chat.listProviders()
      setProviders(list)
      setProviderId((cur) => {
        if (cur === 'local' && list.some((p) => p.id === 'local' && (p.available.ok || isLocalAutoStarting(p)))) return cur
        return list.find((p) => p.id === 'local' && p.available.ok)?.id ?? 'local'
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
      setProviderId((cur) => cur || 'local')
    })
    void window.api.projects.list().then(setProjects).catch(() => setProjects([]))
    refreshRecent()
    refreshEvaluations()
  }, [refreshRecent, refreshEvaluations, refreshProviders])

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
      const valid = current.filter((m) => modelOptions.includes(m))
      if (valid.length > 0) return valid
      return modelOptions[0] ? [modelOptions[0]] : []
    })
  }, [modelOptions.join('|')])

  useEffect(() => {
    if (selectedModels.length > 0 && !selectedModels.includes(model)) {
      setModel(selectedModels[0])
    }
  }, [selectedModels, model])

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
    // Latency runs no test files, so it never needs repo runner detection.
    if (t?.metric === 'tests' && sourceRepo.trim()) await detect()
    setError(null)
  }

  const toggleModel = (modelName: string): void => {
    const adding = !selectedModels.includes(modelName)
    setSelectedModels((current) => {
      return current.includes(modelName) ? current.filter((m) => m !== modelName) : [...current, modelName]
    })
    if (adding) setModel(modelName)
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

  /** Latency benchmark: no test files — time the model on a fixed task and
   *  synthesize a run row so it slots into the same leaderboard. */
  const latencyOne = async (useModel: string): Promise<ResultItem> => {
    const reqId = newId()
    currentReqId.current = reqId
    setPhase(`timing ${useModel || providerId}…`)
    const started = Date.now()
    try {
      const res = await window.api.chat.send({ requestId: reqId, providerId, model: useModel || undefined, prompt: LATENCY_PROMPT })
      const durationMs = Date.now() - started
      if (!res.ok) return { model: useModel, pending: false, error: res.error }
      const u = res.result.usage
      const tokens = (u.promptTokens ?? 0) + (u.completionTokens ?? 0)
      const run: TestRunRow = {
        id: newId(),
        ts: Date.now(),
        sourceRepo: 'latency-benchmark',
        targetDesc: 'latency & throughput',
        providerId,
        model: res.result.model,
        framework: 'latency',
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
      return { model: res.result.model, pending: false, run }
    } catch (err) {
      return { model: useModel, pending: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      currentReqId.current = null
    }
  }

  /** Generate (local model) → write into a fresh sandbox → run → metrics. */
  const runOne = async (
    useModel: string,
    config: RunConfig,
    context: TestRepoContext | null,
    sourcePath: string
  ): Promise<ResultItem> => {
    const reqId = newId()
    currentReqId.current = reqId
    setPhase(`generating tests with ${useModel || providerId}…`)
    let genText: string
    let tokens: number | undefined
    let runModel = useModel
    try {
      const res = await window.api.chat.send({ requestId: reqId, providerId, model: useModel || undefined, prompt: buildGenPrompt(config, context) })
      if (!res.ok) return { model: useModel, pending: false, error: res.error }
      genText = res.result.text
      runModel = res.result.model
      const u = res.result.usage
      tokens = (u.promptTokens ?? 0) + (u.completionTokens ?? 0)
    } catch (err) {
      return { model: useModel, pending: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      currentReqId.current = null
    }

    const code = extractCode(genText)
    if (!code) return { model: useModel, pending: false, error: 'model did not return a fenced code block' }

    const runId = newId()
    currentRunId.current = runId
    setPhase(`running ${config.framework} in sandbox…`)
    try {
      const res = await window.api.test.run({
        runId,
        sourceRepo: sourcePath,
        targetDesc: effectiveTarget(),
        providerId,
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
      if (!res.ok) return { model: useModel, pending: false, error: res.error }
      return { model: runModel, pending: false, run: res.run }
    } catch (err) {
      return { model: useModel, pending: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      currentRunId.current = null
    }
  }

  const needsRepo = testType.metric === 'tests'
  const canRun =
    !running &&
    (!needsRepo || Boolean(sourceRepo.trim())) &&
    Boolean(selected?.available.ok) &&
    selectedModels.length > 0

  const handleRun = async (): Promise<void> => {
    setError(null)
    if (!canRun) {
      if (needsRepo && !sourceRepo.trim()) setError('Pick a source repo.')
      else if (!selected?.available.ok) setError('Local (Ollama) is unavailable. Akorith needs Local to run models.')
      else if (selectedModels.length === 0) setError('Pick at least one local model to benchmark.')
      return
    }

    const metric = testType.metric
    const models = selectedModels.length > 0 ? selectedModels : [model].filter(Boolean)

    // Latency & efficiency: no repo, no sandbox — run each model on the fixed
    // task once; rank by throughput or by token count.
    if (metric === 'latency' || metric === 'efficiency') {
      setRunning(true)
      setClearKey((k) => k + 1)
      setRanMetric(metric)
      setResults(models.map((m) => ({ model: m, pending: true })))
      const done: ResultItem[] = []
      for (let i = 0; i < models.length; i++) {
        const item = await latencyOne(models[i])
        done.push(item)
        setResults((prev) => prev.map((r, idx) => (idx === i ? item : r)))
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
    setResults(models.map((m) => ({ model: m, pending: true })))
    const completed: ResultItem[] = []

    for (let i = 0; i < models.length; i++) {
      const item = await runOne(models[i], runConfig, context, sourcePath)
      completed.push(item)
      setResults((prev) => prev.map((r, idx) => (idx === i ? item : r)))
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
    try {
      const res = await window.api.chat.send({ requestId: reqId, providerId, model: failedRun.model || model || undefined, prompt: repairPrompt })
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
        providerId,
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
      const next: ResultItem = res.ok ? { model: runModel, pending: false, run: res.run } : { model: runModel, pending: false, error: res.error }
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

  const resultRunIds = results.map((item) => item.run?.id).filter((id): id is string => Boolean(id))

  // Objective leaderboard for the current results (computed here, not by a model).
  const ranking = rankResults(results, ranMetric)
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
        </div>
        <div className="test-head">
          <div>
            <h2 className="test-title">Model Benchmark</h2>
            <p className="test-sub">
              Pit local models against each other on the same task — ranked on objective results, no model judging another.
            </p>
          </div>
          <div className="test-head-badge">{selectedModels.length || 0} model{selectedModels.length === 1 ? '' : 's'}</div>
        </div>

        <div className="test-wizard">
          <section className="test-step">
            <div className="test-step-head">
              <span>1</span>
              <div>
                <strong>Choose benchmark codebase</strong>
                <p>The codebase is copied into a fresh temp sandbox for each run.</p>
              </div>
            </div>
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
          </section>

          <section className="test-step">
            <div className="test-step-head">
              <span>2</span>
              <div>
                <strong>Choose local models</strong>
                <p>Each selected model gets the same prompt, file path, runner, and sandbox rules.</p>
              </div>
            </div>
            {selected && modelOptions.length > 0 ? (
              <>
                <div className="test-model-toolbar">
                  <button
                    type="button"
                    className="test-table-btn"
                    onClick={() => {
                      setSelectedModels(modelOptions)
                      setModel(modelOptions[0] ?? '')
                    }}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="test-table-btn"
                    onClick={() => {
                      const first = model || modelOptions[0] || ''
                      setSelectedModels(first ? [first] : [])
                    }}
                  >
                    One model
                  </button>
                </div>
                <div className="test-model-grid">
                  {modelOptions.map((m) => {
                    const checked = selectedModels.includes(m)
                    return (
                      <label key={m} className={`test-model-card ${checked ? 'is-selected' : ''}`}>
                        <input type="checkbox" checked={checked} onChange={() => toggleModel(m)} />
                        <span>{m}</span>
                      </label>
                    )
                  })}
                </div>
              </>
            ) : (
              <div className="test-notice">Waiting for local models — Akorith will start Ollama automatically when you run.</div>
            )}
          </section>

          <section className="test-step">
            <div className="test-step-head">
              <span>3</span>
              <div>
                <strong>Choose test type</strong>
                <p>Every selected model runs the same type; results are ranked objectively.</p>
              </div>
            </div>
            <div className="test-type-grid">
              {TEST_TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`test-type-card ${testTypeId === t.id ? 'is-selected' : ''}`}
                  onClick={() => void applyTestType(t.id)}
                >
                  <strong>{t.label}</strong>
                  <span>{t.blurb}</span>
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* Advanced: auto-filled sandbox runner details, only needed when detection misses. */}
        <details className="test-advanced">
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
        </details>

        <div className="test-actions">
          {running ? (
            <button type="button" className="test-btn is-stop" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="button" className="test-btn is-primary" disabled={!canRun} onClick={() => void handleRun()}>
              {selectedModels.length > 1 ? `Benchmark ${selectedModels.length} models` : 'Run benchmark'}
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
                    : 'ranked by tests passed, then speed'}
              </span>
            </div>

            {/* Finished rows first, ranked; pending/errored models below. */}
            {leaderboard.map((r) => {
              const run = r.run as TestRunRow
              const rank = ranking.get(run.id)?.rank ?? 0
              const score = ranking.get(run.id)?.score ?? 0
              const i = results.indexOf(r)
              return (
                <div key={run.id} className={`bench-row ${rank === 1 ? 'is-top' : ''}`}>
                  <div className="bench-rank">{rank === 1 ? '★' : rank}</div>
                  <div className="bench-model">
                    <strong>{r.model || providerId}</strong>
                    <span className={`bench-status ${statusColor(run.status)}`}>
                      {ranMetric === 'tests' ? run.status : 'timed'}
                    </span>
                  </div>
                  <div className="bench-metrics">
                    {ranMetric === 'efficiency' ? (
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
                    <strong>{r.model || providerId}</strong>
                    <span className="bench-status">{r.pending ? 'running…' : r.error ? 'error' : '—'}</span>
                  </div>
                  <div className="bench-metrics">
                    <span className="bench-note">{r.pending ? 'running…' : 'no result — skipped in ranking'}</span>
                  </div>
                </div>
              ))}

            {!anyPending && leaderboard.length > 1 && (
              <div className="test-hint bench-foot">
                {leaderboard[0].model}{' '}
                {ranMetric === 'latency' ? 'is fastest' : ranMetric === 'efficiency' ? 'is leanest' : 'leads'} this
                benchmark.
              </div>
            )}
          </div>
        )}

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
