import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  MacroMode,
  MacroSessionRow,
  MacroState,
  MacroTurnRow,
  PermissionDetection,
  ProjectRow,
  ProviderInfo
} from '../../../preload/index.d'
import { SparkIcon } from './icons'

const TERMINALS = [
  { id: 't2', label: 'Olympus' },
  { id: 't1', label: 'Atlantis' }
] as const

// Statuses where an Auto-Mode loop is actively working — drives UI polling.
const AUTO_ACTIVE = new Set(['auto_running', 'proposing', 'preparing_context', 'sending', 'summarizing'])

function terminalLabel(id: string | undefined): string {
  return TERMINALS.find((t) => t.id === id)?.label ?? id ?? '—'
}

interface AutoActionEntry {
  type: string
  reason?: string
  action?: string
  at?: number
  [k: string]: unknown
}

function parseAutoActions(json: string | null | undefined): AutoActionEntry[] {
  if (!json) return []
  try {
    const list = JSON.parse(json) as AutoActionEntry[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function parsePermission(json: string | null | undefined): PermissionDetection | null {
  if (!json) return null
  try {
    return JSON.parse(json) as PermissionDetection
  } catch {
    return null
  }
}

interface MacroLoopPanelProps {
  providers: ProviderInfo[] | null
  defaultProviderId: string
  defaultModel: string
  defaultTargetTerminal: string
  activeProject: ProjectRow | null
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Phase 20: open a freshly-scaffolded project so its executor terminal boots. */
  onOpenProject?: (project: ProjectRow) => void
}

function latestActionableTurn(state: MacroState | null): MacroTurnRow | null {
  if (!state || state.turns.length === 0) return null
  return state.turns[state.turns.length - 1]
}

function busyStatus(status: string | undefined): boolean {
  return (
    status === 'preparing_context' ||
    status === 'proposing' ||
    status === 'sending' ||
    status === 'summarizing' ||
    status === 'auto_running'
  )
}

function statusLabel(status: string | undefined): string {
  return (status ?? 'idle').replace(/_/g, ' ')
}

export default function MacroLoopPanel({
  providers,
  defaultProviderId,
  defaultModel,
  defaultTargetTerminal,
  activeProject,
  collapsed,
  onToggleCollapsed,
  onOpenProject
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
  const [copiedPrompt, setCopiedPrompt] = useState(false)
  // Loop mode for the create form (before a session exists). Default Approval.
  const [formMode, setFormMode] = useState<MacroMode>('approval')
  const [summarizing, setSummarizing] = useState(false)
  // Phase 20: autonomous workspace-project creation (idea seed + token budget).
  const [workspaceSeed, setWorkspaceSeed] = useState('')
  const [tokenBudget, setTokenBudget] = useState(0)
  const [scaffolding, setScaffolding] = useState(false)
  const [workspaceInfo, setWorkspaceInfo] = useState<{ name: string; dir: string } | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const session = state?.session ?? null
  const mode: MacroMode = session?.mode ?? formMode
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

  // While an Auto-Mode loop is running in the main process, poll its persisted
  // state so the UI tracks progress (sends, summaries, pauses) live.
  useEffect(() => {
    const sid = session?.id
    const active = sid != null && AUTO_ACTIVE.has(session?.status ?? '')
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    if (active && sid) {
      pollRef.current = setInterval(() => {
        void window.api.macro
          .get(sid)
          .then((loaded) => {
            if (loaded) setState(loaded)
          })
          .catch(() => {})
      }, 1500)
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [session?.id, session?.status])

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
    if (includeRepoDigest && activeProject?.path) {
      await window.api.digest.setWorkingDir(activeProject.path)
    }
    const created = await window.api.macro.createSession({
      goal: goal.trim(),
      plannerProvider,
      plannerModel: plannerModel || undefined,
      targetTerminal,
      maxIterations,
      goodEnoughThreshold,
      includeRepoDigest,
      mode: formMode
    })
    if (!applyResponse(created)) return
    if (!created.ok) return
    if (formMode === 'auto') {
      const started = await window.api.macro.startAuto(created.state.session.id)
      applyResponse(started)
      return
    }
    await propose(created.state.session.id)
  }

  // Phase 20 one-click: generate an everyday-dev idea, scaffold it as its own git
  // repo, OPEN the project (so the executor terminal boots in that cwd), then
  // start the auto-commit loop — no manual steps. The loop's first action is a
  // planner meta call, which gives the terminal time to launch its agent CLI
  // before any prompt is sent; a short delay adds margin.
  const buildAutonomously = async (): Promise<void> => {
    if (!plannerProvider || scaffolding) return
    setError(null)
    setScaffolding(true)
    setWorkspaceInfo(null)
    try {
      const res = await window.api.macro.createWorkspaceProject({
        seed: workspaceSeed.trim() || undefined,
        plannerProvider,
        plannerModel: plannerModel || undefined,
        targetTerminal,
        maxIterations,
        goodEnoughThreshold,
        tokenBudget: tokenBudget > 0 ? tokenBudget : undefined
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setState(res.state)
      setGoal(res.state.session.goal)
      setWorkspaceInfo({ name: res.idea.name, dir: res.workspaceDir })
      refreshHistory()
      // Open the new project: switches active project → executor terminal spawns
      // in the workspace dir and launches its agent CLI.
      onOpenProject?.(res.project)
      // Let the agent terminal boot before the loop starts sending prompts.
      await new Promise((resolve) => setTimeout(resolve, 3000))
      const started = await window.api.macro.startAuto(res.state.session.id)
      applyResponse(started)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScaffolding(false)
    }
  }

  // Auto Mode: kick (or resume) the cautious loop in the main process.
  const startAuto = async (): Promise<void> => {
    if (!session) return
    setError(null)
    const res = await window.api.macro.startAuto(session.id)
    applyResponse(res)
  }

  const changeMode = async (next: MacroMode): Promise<void> => {
    if (next === mode) return
    if (!session) {
      setFormMode(next)
      return
    }
    setFormMode(next)
    const res = await window.api.macro.setMode(session.id, next)
    applyResponse(res)
  }

  // Approval Mode: fill the executor-result summary from the terminal snapshot.
  const summarizeFromTerminal = async (): Promise<void> => {
    if (!session || !turn) return
    setSummarizing(true)
    setError(null)
    try {
      const res = await window.api.macro.summarize({ sessionId: session.id, turnId: turn.id })
      if (res.ok) {
        if (res.summaryText) setResultSummary(res.summaryText)
        if (res.state) setState(res.state)
      } else {
        setError(res.error)
      }
    } finally {
      setSummarizing(false)
    }
  }

  // Send a (user-approved) response to a detected permission prompt.
  const respondPermission = async (action: string): Promise<void> => {
    if (!session || !turn) return
    setError(null)
    const res = await window.api.macro.respondPermission({ sessionId: session.id, turnId: turn.id, action })
    applyResponse(res)
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

  const copyProposal = async (): Promise<void> => {
    if (!proposalDraft.trim()) return
    try {
      await navigator.clipboard.writeText(proposalDraft)
      setCopiedPrompt(true)
      setTimeout(() => setCopiedPrompt(false), 1500)
    } catch {
      setError('Copy failed.')
    }
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
      setFormMode(loaded.session.mode)
      setError(null)
    }
  }

  if (collapsed) {
    return (
      <section className="macro-panel is-collapsed">
        <div className="macro-head">
          <div>
            <div className="macro-title">
              <SparkIcon size={13} />
              Macro loop
            </div>
            <div className={`macro-status status-${session?.status ?? 'idle'}`}>{statusLabel(session?.status)}</div>
          </div>
          <button type="button" className="macro-btn" onClick={onToggleCollapsed}>
            Show
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="macro-panel">
      <div className="macro-head">
        <div>
          <div className="macro-title">
            <SparkIcon size={13} />
            Macro loop
          </div>
          <div className={`macro-status status-${session?.status ?? 'idle'}`}>{statusLabel(session?.status)}</div>
        </div>
        <button type="button" className="macro-btn" onClick={onToggleCollapsed}>
          Hide
        </button>
        {session && session.status !== 'completed' && session.status !== 'stopped' && (
          <button type="button" className="macro-btn is-stop" disabled={isBusy && !session} onClick={() => void stop()}>
            Stop
          </button>
        )}
      </div>

      <div className="macro-mode-row">
        <div className="macro-mode" role="tablist" aria-label="Loop mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'approval'}
            className={mode === 'approval' ? 'is-active' : ''}
            onClick={() => void changeMode('approval')}
          >
            Approval
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'auto'}
            className={mode === 'auto' ? 'is-active' : ''}
            onClick={() => void changeMode('auto')}
          >
            Auto
          </button>
        </div>
        <span className="macro-reading">reads {terminalLabel(session?.targetTerminal ?? targetTerminal)}</span>
      </div>
      {mode === 'auto' && (
        <div className="macro-auto-note">
          Auto Mode can send follow-up prompts to agents and auto-answer only low-risk one-time
          confirmations. Medium/high-risk prompts pause for you. Stop remains available.
        </div>
      )}

      {(!session || session.status === 'completed' || session.status === 'stopped') && (
        <details className="macro-workspace">
          <summary>✨ Autonomous project (one-click scaffold, build &amp; loop-commit)</summary>
          <div className="macro-help">
            One click: generates an everyday-dev idea, scaffolds it as its own git repo, opens the
            project so the executor agent runs inside it, and starts a loop that commits every
            change as <code>Phase N: …</code> until the token budget is spent.
          </div>
          <label className="macro-field">
            <span>Idea theme (optional)</span>
            <input
              type="text"
              value={workspaceSeed}
              disabled={scaffolding || isBusy}
              placeholder="e.g. a CLI for tidying markdown — or leave blank to surprise me"
              onChange={(e) => setWorkspaceSeed(e.target.value)}
            />
          </label>
          <label className="macro-field">
            <span>Token budget (0 = until max iterations)</span>
            <input
              type="number"
              min={0}
              step={1000}
              value={tokenBudget}
              disabled={scaffolding || isBusy}
              onChange={(e) => setTokenBudget(Math.max(0, Number(e.target.value)))}
            />
          </label>
          <button
            type="button"
            className="macro-btn is-primary"
            disabled={!plannerProvider || scaffolding || isBusy}
            onClick={() => void buildAutonomously()}
          >
            {scaffolding ? 'Scaffolding & starting…' : '✨ Build autonomously (one-click)'}
          </button>
          {workspaceInfo && (
            <div className="macro-auto-note">
              Building <strong>{workspaceInfo.name}</strong> at <code>{workspaceInfo.dir}</code> —
              the loop is running and will commit each change as <code>Phase N</code>.
            </div>
          )}
        </details>
      )}

      <label className="macro-field">
        <span>Goal</span>
        <textarea
          value={goal}
          rows={2}
          disabled={isBusy}
          placeholder="Describe the outcome you want Akorith to drive one approved step at a time."
          onChange={(e) => setGoal(e.target.value)}
        />
      </label>

      <label
        className="macro-toggle"
        title="Adds a compact project digest so Akorith understands your codebase. Better planning, more tokens."
      >
        <input type="checkbox" checked={includeRepoDigest} disabled={isBusy} onChange={() => setIncludeRepoDigest((v) => !v)} />
        Repo context
        {activeProject?.path && <em>{activeProject.name}</em>}
        {session?.includeRepoDigest && session.repoDigestSnapshot && <span>included</span>}
      </label>
      <div className="macro-help">Adds a compact project digest so Akorith understands your codebase. Better planning, more tokens.</div>

      <details className="macro-advanced">
        <summary>Advanced settings</summary>
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
      </details>

      {!session || session.status === 'completed' || session.status === 'stopped' ? (
        <button type="button" className="macro-btn is-primary" disabled={!goal.trim() || !plannerProvider || isBusy} onClick={() => void start()}>
          {formMode === 'auto' ? 'Start Auto loop' : 'Plan with loop'}
        </button>
      ) : null}

      {/* Auto Mode is paused on a safety gate — let the user resume cautiously. */}
      {session &&
        mode === 'auto' &&
        (session.status === 'awaiting_executor_result' || session.status === 'awaiting_approval') &&
        session.pauseReason && (
          <button type="button" className="macro-btn is-primary" onClick={() => void startAuto()}>
            Resume Auto
          </button>
        )}

      {session?.pauseReason && session.status !== 'stopped' && session.status !== 'completed' && (
        <div className="macro-warning">Auto paused: {session.pauseReason.replace(/_/g, ' ')}</div>
      )}

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
            <span className="macro-field-head">
              <span>Approved executor prompt</span>
              <button type="button" className="macro-copy-btn" onClick={() => void copyProposal()}>
                {copiedPrompt ? 'Copied' : 'Copy'}
              </button>
            </span>
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

      {/* Detected permission prompt awaiting the user (Approval mode, or an Auto
          pause on a medium/high-risk or low-confidence permission). */}
      {session?.status === 'awaiting_permission' && turn && (() => {
        const det = parsePermission(turn.permissionDetection)
        return (
          <div className="macro-permission">
            <div className="macro-title small">Permission prompt detected</div>
            <div className={`macro-perm-risk risk-${det?.riskLevel ?? 'medium'}`}>
              {det ? `${det.kind.replace(/_/g, ' ')} · risk ${det.riskLevel}` : 'review required'}
            </div>
            {det?.rationale && <div className="macro-rationale">{det.rationale}</div>}
            {det?.matchedText && <pre className="macro-perm-snippet">{det.matchedText.slice(-220)}</pre>}
            <div className="macro-actions">
              {det && det.suggestedAction !== '' && (
                <button type="button" className="macro-btn is-primary" onClick={() => void respondPermission(det.suggestedAction)}>
                  Send “{det.suggestedAction}”
                </button>
              )}
              <button type="button" className="macro-btn" onClick={() => void respondPermission('')}>
                Send Enter
              </button>
              <button type="button" className="macro-btn is-stop" onClick={() => void stop()}>
                Stop
              </button>
            </div>
            <div className="macro-hint">Akorith never auto-selects “always allow”. One-time approval only.</div>
          </div>
        )
      })()}

      {session?.status === 'awaiting_executor_result' && turn && (
        <div className="macro-result">
          <div className="macro-title small">Executor result · reads {terminalLabel(session.targetTerminal)}</div>
          <textarea
            value={resultSummary}
            rows={4}
            placeholder="Paste the executor report, or click Summarize from terminal to read it automatically."
            onChange={(e) => setResultSummary(e.target.value)}
          />
          <div className="macro-actions">
            <button type="button" className="macro-btn" disabled={summarizing} onClick={() => void summarizeFromTerminal()}>
              {summarizing ? 'Summarizing…' : 'Summarize from terminal'}
            </button>
            <button type="button" className="macro-btn is-primary" onClick={() => void recordAndContinue()}>
              Continue loop
            </button>
            {mode === 'auto' && (
              <button type="button" className="macro-btn" onClick={() => void startAuto()}>
                Resume Auto
              </button>
            )}
            <button type="button" className="macro-btn" onClick={() => void complete()}>
              Mark complete
            </button>
            <button type="button" className="macro-btn is-stop" onClick={() => void stop()}>
              Stop
            </button>
          </div>
        </div>
      )}

      {turn?.executorResultSummary && session?.status !== 'awaiting_executor_result' && (
        <div className="macro-summary-readout">
          <div className="macro-title small">
            Latest summary
            {turn.criticScore != null && (
              <span className={`macro-critic-badge is-${turn.criticVerdict ?? 'stalled'}`}>
                critic {turn.criticScore}/100 · {turn.criticVerdict ?? 'graded'}
              </span>
            )}
          </div>
          <pre>{turn.executorResultSummary}</pre>
        </div>
      )}

      {session?.workspaceDir && (
        <div className="macro-help">
          Workspace: <code>{session.workspaceDir}</code>
          {session.autoCommit && ' · auto-commits Phase N'}
          {session.tokenBudget > 0
            ? ` · tokens ${session.tokensUsed}/${session.tokenBudget}`
            : session.tokensUsed > 0
              ? ` · ${session.tokensUsed} planner tokens used`
              : ''}
        </div>
      )}

      {session && parseAutoActions(session.autoActions).length > 0 && (
        <details className="macro-autolog">
          <summary>Auto-actions log ({parseAutoActions(session.autoActions).length})</summary>
          {parseAutoActions(session.autoActions)
            .slice(-8)
            .reverse()
            .map((a, i) => (
              <div key={i} className="macro-autolog-row">
                <span>{a.type.replace(/_/g, ' ')}</span>
                <em>{a.action ? `“${a.action}”` : a.reason ? a.reason.replace(/_/g, ' ') : ''}</em>
              </div>
            ))}
        </details>
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
