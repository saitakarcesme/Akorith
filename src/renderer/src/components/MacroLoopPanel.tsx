import { useEffect, useMemo, useState } from 'react'
import type { MacroSessionRow, MacroState, MacroTurnRow, ProviderInfo } from '../../../preload/index.d'

const TERMINALS = [
  { id: 't1', label: 'Terminal 1' },
  { id: 't2', label: 'Terminal 2' }
] as const

interface MacroLoopPanelProps {
  providers: ProviderInfo[] | null
  defaultProviderId: string
  defaultModel: string
  defaultTargetTerminal: string
}

function latestActionableTurn(state: MacroState | null): MacroTurnRow | null {
  if (!state || state.turns.length === 0) return null
  return state.turns[state.turns.length - 1]
}

function busyStatus(status: string | undefined): boolean {
  return status === 'preparing_context' || status === 'proposing' || status === 'sending'
}

function statusLabel(status: string | undefined): string {
  return (status ?? 'idle').replace(/_/g, ' ')
}

export default function MacroLoopPanel({
  providers,
  defaultProviderId,
  defaultModel,
  defaultTargetTerminal
}: MacroLoopPanelProps): JSX.Element {
  const chatProviders = useMemo(() => (providers ?? []).filter((p) => p.available.ok && p.kind.includes('chat')), [providers])
  const [goal, setGoal] = useState('')
  const [plannerProvider, setPlannerProvider] = useState(defaultProviderId)
  const [plannerModel, setPlannerModel] = useState(defaultModel)
  const [targetTerminal, setTargetTerminal] = useState(defaultTargetTerminal)
  const [maxIterations, setMaxIterations] = useState(5)
  const [goodEnoughThreshold, setGoodEnoughThreshold] = useState(85)
  const [includeRepoDigest, setIncludeRepoDigest] = useState(false)
  const [state, setState] = useState<MacroState | null>(null)
  const [proposalDraft, setProposalDraft] = useState('')
  const [resultSummary, setResultSummary] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<MacroSessionRow[]>([])

  const session = state?.session ?? null
  const turn = latestActionableTurn(state)
  const planner = chatProviders.find((p) => p.id === plannerProvider)
  const isBusy = busyStatus(session?.status)
  const thresholdReached =
    turn?.goodEnoughScore != null && session != null && turn.goodEnoughScore >= session.goodEnoughThreshold

  const refreshHistory = (): void => {
    void window.api.macro.list(8).then(setHistory).catch(() => setHistory([]))
  }

  useEffect(() => {
    setPlannerProvider((cur) =>
      chatProviders.some((p) => p.id === cur) ? cur : chatProviders[0]?.id ?? defaultProviderId
    )
  }, [chatProviders, defaultProviderId])

  useEffect(() => {
    setPlannerModel((cur) => (planner && planner.models.includes(cur) ? cur : (planner?.models[0] ?? defaultModel)))
  }, [planner, defaultModel])

  useEffect(() => {
    setTargetTerminal(defaultTargetTerminal)
  }, [defaultTargetTerminal])

  useEffect(() => {
    refreshHistory()
  }, [])

  useEffect(() => {
    setProposalDraft(turn?.editedProposal ?? turn?.proposal ?? '')
  }, [turn?.id, turn?.editedProposal, turn?.proposal])

  const applyResponse = (res: Awaited<ReturnType<typeof window.api.macro.propose>>): boolean => {
    if (res.ok) {
      setState(res.state)
      setError(null)
      refreshHistory()
      return true
    }
    setError(res.error)
    if (res.state) setState(res.state)
    refreshHistory()
    return false
  }

  const setLocalStatus = (status: MacroState['session']['status']): void => {
    setState((prev) => (prev ? { ...prev, session: { ...prev.session, status } } : prev))
  }

  const propose = async (sessionId: string): Promise<void> => {
    setError(null)
    setLocalStatus('preparing_context')
    const res = await window.api.macro.propose(sessionId)
    applyResponse(res)
  }

  const start = async (): Promise<void> => {
    if (!goal.trim() || !plannerProvider) return
    setError(null)
    const created = await window.api.macro.createSession({
      goal: goal.trim(),
      plannerProvider,
      plannerModel: plannerModel || undefined,
      targetTerminal,
      maxIterations,
      goodEnoughThreshold,
      includeRepoDigest
    })
    if (!applyResponse(created)) return
    if (!created.ok) return
    await propose(created.state.session.id)
  }

  const approve = async (): Promise<void> => {
    if (!session || !turn) return
    setLocalStatus('sending')
    const res = await window.api.macro.approve({
      sessionId: session.id,
      turnId: turn.id,
      editedProposal: proposalDraft
    })
    applyResponse(res)
  }

  const skip = async (): Promise<void> => {
    if (!session || !turn) return
    const skipped = await window.api.macro.skip({ sessionId: session.id, turnId: turn.id })
    if (!applyResponse(skipped)) return
    await propose(session.id)
  }

  const recordAndContinue = async (): Promise<void> => {
    if (!session || !turn) return
    setLocalStatus('idle')
    const recorded = await window.api.macro.recordResult({
      sessionId: session.id,
      turnId: turn.id,
      summary: resultSummary
    })
    if (!applyResponse(recorded)) return
    if (!recorded.ok) return
    setResultSummary('')
    if (recorded.state.session.status !== 'stopped') await propose(session.id)
  }

  const stop = async (): Promise<void> => {
    if (!session) return
    setLocalStatus('stopped')
    const res = await window.api.macro.stop(session.id)
    applyResponse(res)
  }

  const complete = async (): Promise<void> => {
    if (!session) return
    setLocalStatus('completed')
    const res = await window.api.macro.complete(session.id)
    applyResponse(res)
  }

  const loadSession = async (sessionId: string): Promise<void> => {
    const loaded = await window.api.macro.get(sessionId)
    if (loaded) {
      setState(loaded)
      setGoal(loaded.session.goal)
      setPlannerProvider(loaded.session.plannerProvider)
      setPlannerModel(loaded.session.plannerModel ?? '')
      setTargetTerminal(loaded.session.targetTerminal)
      setMaxIterations(loaded.session.maxIterations)
      setGoodEnoughThreshold(loaded.session.goodEnoughThreshold)
      setIncludeRepoDigest(loaded.session.includeRepoDigest)
      setError(null)
    }
  }

  return (
    <section className="macro-panel">
      <div className="macro-head">
        <div>
          <div className="macro-title">Macro loop</div>
          <div className={`macro-status status-${session?.status ?? 'idle'}`}>{statusLabel(session?.status)}</div>
        </div>
        {session && session.status !== 'completed' && session.status !== 'stopped' && (
          <button type="button" className="macro-btn is-stop" disabled={isBusy && !session} onClick={() => void stop()}>
            Stop
          </button>
        )}
      </div>

      <label className="macro-field">
        <span>Goal</span>
        <textarea
          value={goal}
          rows={2}
          disabled={isBusy}
          placeholder="Describe the outcome you want Loopex to drive one approved step at a time."
          onChange={(e) => setGoal(e.target.value)}
        />
      </label>

      <div className="macro-grid">
        <label className="macro-field">
          <span>Planner</span>
          <select value={plannerProvider} disabled={isBusy || chatProviders.length === 0} onChange={(e) => setPlannerProvider(e.target.value)}>
            {chatProviders.length === 0 && <option value="">No available planner</option>}
            {chatProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="macro-field">
          <span>Model</span>
          <select value={plannerModel} disabled={isBusy || !planner?.models.length} onChange={(e) => setPlannerModel(e.target.value)}>
            {!planner?.models.length && <option value="">Default</option>}
            {planner?.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="macro-grid three">
        <label className="macro-field">
          <span>Executor</span>
          <select value={targetTerminal} disabled={isBusy} onChange={(e) => setTargetTerminal(e.target.value)}>
            {TERMINALS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="macro-field">
          <span>Max</span>
          <input type="number" min={1} max={50} value={maxIterations} disabled={isBusy} onChange={(e) => setMaxIterations(Number(e.target.value))} />
        </label>
        <label className="macro-field">
          <span>Threshold</span>
          <input
            type="number"
            min={1}
            max={100}
            value={goodEnoughThreshold}
            disabled={isBusy}
            onChange={(e) => setGoodEnoughThreshold(Number(e.target.value))}
          />
        </label>
      </div>

      <label className="macro-toggle">
        <input type="checkbox" checked={includeRepoDigest} disabled={isBusy} onChange={() => setIncludeRepoDigest((v) => !v)} />
        Include repo context
        {session?.includeRepoDigest && session.repoDigestSnapshot && <span>included</span>}
      </label>

      {!session || session.status === 'completed' || session.status === 'stopped' ? (
        <button type="button" className="macro-btn is-primary" disabled={!goal.trim() || !plannerProvider || isBusy} onClick={() => void start()}>
          Start loop
        </button>
      ) : null}

      {error && <div className="macro-error">{error}</div>}

      {turn && (session?.status === 'awaiting_approval' || turn.status === 'skipped') && (
        <div className="macro-proposal">
          <div className="macro-proposal-meta">
            <span>Turn {turn.turnIndex}</span>
            <span>{turn.providerUsed ?? session?.plannerProvider} · {turn.modelUsed ?? session?.plannerModel ?? 'default'}</span>
            {turn.goodEnoughScore != null && <span>{turn.goodEnoughScore}/100 done</span>}
            {turn.riskLevel && <span>risk {turn.riskLevel}</span>}
          </div>
          {turn.plannerRationale && <div className="macro-rationale">{turn.plannerRationale}</div>}
          {thresholdReached && (
            <div className="macro-warning">
              Good-enough threshold reached. Mark complete, continue anyway, or stop.
            </div>
          )}
          <label className="macro-field">
            <span>Approved executor prompt</span>
            <textarea value={proposalDraft} rows={6} onChange={(e) => setProposalDraft(e.target.value)} />
          </label>
          {turn.expectedResult && <div className="macro-expected">Expected: {turn.expectedResult}</div>}
          <div className="macro-actions">
            <button type="button" className="macro-btn is-primary" onClick={() => void approve()}>
              {thresholdReached ? 'Continue anyway' : 'Approve & send'}
            </button>
            <button type="button" className="macro-btn" onClick={() => void skip()}>
              Skip / regenerate
            </button>
            <button type="button" className="macro-btn" onClick={() => void propose(session!.id)}>
              Regenerate
            </button>
            <button type="button" className="macro-btn" onClick={() => void complete()}>
              Mark complete
            </button>
          </div>
        </div>
      )}

      {session?.status === 'awaiting_executor_result' && turn && (
        <div className="macro-result">
          <div className="macro-title small">Executor result</div>
          <textarea
            value={resultSummary}
            rows={4}
            placeholder="Paste or summarize the executor report: changed files, tests, failures, commit status."
            onChange={(e) => setResultSummary(e.target.value)}
          />
          <div className="macro-actions">
            <button type="button" className="macro-btn is-primary" onClick={() => void recordAndContinue()}>
              Continue loop
            </button>
            <button type="button" className="macro-btn" onClick={() => void complete()}>
              Mark complete
            </button>
            <button type="button" className="macro-btn" onClick={() => void stop()}>
              Stop
            </button>
          </div>
        </div>
      )}

      {session?.stopReason && <div className="macro-hint">Stop reason: {session.stopReason}</div>}

      {history.length > 0 && (
        <div className="macro-history">
          <div className="macro-title small">Recent loops</div>
          {history.slice(0, 4).map((h) => (
            <button type="button" key={h.id} onClick={() => void loadSession(h.id)} title={h.goal}>
              <span>{h.status}</span>
              {h.goal}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
