import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ProviderInfo,
  TestDetection,
  TestRunRow,
  TestSettings
} from '../../../preload/index.d'
import TestTerminal from './TestTerminal'

interface TestPageProps {
  active: boolean
}

interface ResultItem {
  model: string
  pending: boolean
  run?: TestRunRow
  error?: string
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

export default function TestPage({ active }: TestPageProps): JSX.Element {
  const [settings, setSettings] = useState<TestSettings | null>(null)
  const [sourceRepo, setSourceRepo] = useState('')
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')

  // Resolved/overridable run config (seeded by Detect).
  const [detection, setDetection] = useState<TestDetection | null>(null)
  const [framework, setFramework] = useState('')
  const [testCommand, setTestCommand] = useState('')
  const [installCommand, setInstallCommand] = useState('')
  const [installDeps, setInstallDeps] = useState(true)
  const [testPath, setTestPath] = useState('')

  const [targetDesc, setTargetDesc] = useState('')
  const [comparison, setComparison] = useState(false)
  const [compareModels, setCompareModels] = useState<string[]>([])

  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState('')
  const [clearKey, setClearKey] = useState(0)
  const [results, setResults] = useState<ResultItem[]>([])
  const [recent, setRecent] = useState<TestRunRow[]>([])
  const [error, setError] = useState<string | null>(null)

  const currentRunId = useRef<string | null>(null)
  const currentReqId = useRef<string | null>(null)

  const selected = providers.find((p) => p.id === providerId)

  const refreshRecent = useCallback(() => {
    void window.api.test.listRuns(12).then(setRecent).catch(() => setRecent([]))
  }, [])

  // Initial load (providers, settings, history).
  useEffect(() => {
    void window.api.chat
      .listProviders()
      .then((list) => {
        setProviders(list)
        setProviderId((cur) => {
          if (list.some((p) => p.id === cur && p.available.ok)) return cur
          return list.find((p) => p.available.ok)?.id ?? ''
        })
      })
      .catch(() => setProviders([]))
    void window.api.test.getSettings().then((s) => {
      setSettings(s)
      setInstallDeps(s.installDeps)
      setSourceRepo((cur) => cur || s.sourceRepo)
      // Prefer the configured default provider when it is available.
      setProviderId((cur) => cur || s.defaultProviderId)
    })
    refreshRecent()
  }, [refreshRecent])

  // Default the model when the provider/model list changes.
  useEffect(() => {
    setModel((cur) => (selected && selected.models.includes(cur) ? cur : (selected?.models[0] ?? '')))
  }, [selected])

  const detect = async (): Promise<void> => {
    setError(null)
    if (!sourceRepo.trim()) {
      setError('Pick a source repo first.')
      return
    }
    await window.api.test.setSourceRepo(sourceRepo.trim())
    const d = await window.api.test.detect(sourceRepo.trim())
    if ('error' in d) {
      setError(d.error)
      setDetection(null)
      return
    }
    setDetection(d)
    setFramework(d.framework)
    setTestCommand(d.testCommand)
    setInstallCommand(d.installCommand)
    setTestPath(d.suggestedTestPath)
  }

  const buildGenPrompt = (): string =>
    `Write ${framework || 'unit'} tests for this repository.\n\n` +
    `Target: ${targetDesc.trim()}\n\n` +
    `Respond with ONLY the complete test file content inside a single fenced code block — no prose. ` +
    `It will be saved as "${testPath}" and run with: ${testCommand}`

  /** Generate (local model) → write into a fresh sandbox → run → metrics. */
  const runOne = async (useModel: string): Promise<ResultItem> => {
    const reqId = newId()
    currentReqId.current = reqId
    setPhase(`generating tests with ${useModel || providerId}…`)
    let genText: string
    let tokens: number | undefined
    try {
      const res = await window.api.chat.send({ requestId: reqId, providerId, model: useModel || undefined, prompt: buildGenPrompt() })
      if (!res.ok) return { model: useModel, pending: false, error: res.error }
      genText = res.result.text
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
    setPhase(`running ${framework} in sandbox…`)
    try {
      const res = await window.api.test.run({
        runId,
        sourceRepo: sourceRepo.trim(),
        targetDesc: targetDesc.trim(),
        providerId,
        model: useModel,
        framework,
        testCommand,
        installCommand: installCommand || undefined,
        installDeps,
        files: [{ path: testPath, content: code }],
        tokens,
        attempts: 1,
        timeoutMs: settings?.timeoutMs
      })
      if (!res.ok) return { model: useModel, pending: false, error: res.error }
      return { model: useModel, pending: false, run: res.run }
    } catch (err) {
      return { model: useModel, pending: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      currentRunId.current = null
    }
  }

  const canRun =
    !running &&
    Boolean(sourceRepo.trim()) &&
    Boolean(testCommand.trim()) &&
    Boolean(targetDesc.trim()) &&
    Boolean(selected?.available.ok)

  const handleRun = async (): Promise<void> => {
    setError(null)
    if (!canRun) {
      if (!testCommand.trim()) setError('No test command — run Detect, or enter one manually.')
      else if (!targetDesc.trim()) setError('Describe what to test in the box below.')
      else if (!selected?.available.ok) setError('Pick an available provider.')
      else if (!sourceRepo.trim()) setError('Pick a source repo.')
      return
    }

    const models = comparison && compareModels.length >= 2 ? compareModels : [model]
    setRunning(true)
    setClearKey((k) => k + 1)
    setResults(models.map((m) => ({ model: m, pending: true })))

    for (let i = 0; i < models.length; i++) {
      const item = await runOne(models[i])
      setResults((prev) => prev.map((r, idx) => (idx === i ? item : r)))
    }

    setRunning(false)
    setPhase('')
    refreshRecent()
  }

  const stop = (): void => {
    if (currentRunId.current) window.api.test.stop(currentRunId.current)
    if (currentReqId.current) window.api.chat.cancel(currentReqId.current)
    setPhase('stopping…')
  }

  const compareModelToggle = (m: string): void => {
    setCompareModels((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]))
  }

  const metric = (run: TestRunRow): string => {
    const p = run.passed ?? 0
    const f = run.failed ?? 0
    const e = run.errored ?? 0
    const tot = p + f + e
    return tot > 0 ? `${p}/${tot} passed${f ? `, ${f} failed` : ''}${e ? `, ${e} err` : ''}` : run.status ?? '—'
  }

  return (
    <div className="test-page">
      <div className="test-config">
        <h2 className="test-title">Test lab</h2>
        <p className="test-sub">
          A local model writes tests for your repo; they run automatically in a fresh, isolated temp sandbox. The
          source repo is never modified.
        </p>

        <label className="test-field">
          <span>Source repo</span>
          <div className="test-row">
            <input
              type="text"
              value={sourceRepo}
              placeholder="/path/to/repo"
              onChange={(e) => setSourceRepo(e.target.value)}
              spellCheck={false}
            />
            <button type="button" className="test-btn" onClick={() => void detect()}>
              Detect
            </button>
          </div>
        </label>

        {detection && (
          <div className="test-detected">
            Detected: <strong>{detection.framework}</strong>
            {detection.lockfile ? ` · lockfile ${detection.lockfile}` : ''}
            {detection.note ? ` · ${detection.note}` : ''}
          </div>
        )}

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

        <div className="test-grid">
          <label className="test-field">
            <span>Provider</span>
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              {providers.length === 0 && <option value="">No providers</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available.ok}>
                  {p.available.ok ? p.label : `${p.label} — unavailable`}
                </option>
              ))}
            </select>
          </label>
          {selected && selected.models.length > 0 && !comparison && (
            <label className="test-field">
              <span>Model</span>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {selected.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <label className="test-toggle">
          <input type="checkbox" checked={comparison} onChange={() => setComparison((v) => !v)} />
          Compare multiple models (each in its own sandbox)
        </label>
        {comparison && (
          <div className="test-compare-models">
            {selected && selected.models.length > 0 ? (
              selected.models.map((m) => (
                <label key={m} className="test-compare-model">
                  <input type="checkbox" checked={compareModels.includes(m)} onChange={() => compareModelToggle(m)} />
                  {m}
                </label>
              ))
            ) : (
              <span className="test-hint">Selected provider exposes no model list to compare.</span>
            )}
          </div>
        )}

        <label className="test-field">
          <span>What to test</span>
          <textarea
            value={targetDesc}
            onChange={(e) => setTargetDesc(e.target.value)}
            rows={3}
            placeholder='e.g. "write pytest tests for src/main/testlab.ts parseMetrics-style logic"'
            spellCheck={false}
          />
        </label>

        <div className="test-actions">
          {running ? (
            <button type="button" className="test-btn is-stop" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="button" className="test-btn is-primary" disabled={!canRun} onClick={() => void handleRun()}>
              {comparison ? 'Generate & compare' : 'Generate & run'}
            </button>
          )}
          {phase && <span className="test-phase">{phase}</span>}
        </div>
        {error && <div className="test-error">{error}</div>}

        {results.length > 0 && (
          <div className="test-results">
            {results.map((r, i) => (
              <div key={i} className={`test-result ${r.run ? statusColor(r.run.status) : r.error ? 'is-error' : ''}`}>
                <div className="test-result-head">
                  <span className="test-result-model">{r.model || providerId}</span>
                  {r.pending ? (
                    <span className="test-result-status">running…</span>
                  ) : r.error ? (
                    <span className="test-result-status">error</span>
                  ) : (
                    <span className="test-result-status">{r.run?.status}</span>
                  )}
                </div>
                {r.run && (
                  <div className="test-result-body">
                    <div>{metric(r.run)}</div>
                    <div className="test-result-meta">
                      {r.run.durationMs != null ? `${(r.run.durationMs / 1000).toFixed(1)}s` : '—'} · exit{' '}
                      {r.run.exitCode ?? '—'} · {r.run.tokens ?? 0} tok
                    </div>
                  </div>
                )}
                {r.error && <div className="test-result-body test-result-err">{r.error}</div>}
              </div>
            ))}
          </div>
        )}

        <div className="test-recent">
          <div className="test-recent-title">Recent runs</div>
          {recent.length === 0 ? (
            <div className="test-hint">No runs yet.</div>
          ) : (
            <table className="test-recent-table">
              <thead>
                <tr>
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
                  <tr key={r.id} className={statusColor(r.status)}>
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
      </div>

      <div className="test-terminal-col">
        <div className="test-terminal-header">Sandbox output</div>
        <TestTerminal clearKey={clearKey} active={active} />
      </div>
    </div>
  )
}
