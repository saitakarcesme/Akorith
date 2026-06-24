import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MacroSessionRow, MacroState, ProjectRow, ProviderInfo, PtyCommandKind, PtySnapshot } from '../../../preload/index.d'
import { ChevronIcon, LoopIcon, PlusIcon } from './icons'

type View = 'list' | 'create' | 'detail'
type LoopIntent = 'continuous' | 'monitor' | 'daily-build' | 'custom'
type ExecutorTarget = 'local' | 't1' | 't2'
type LoopType =
  | 'project-improvement'
  | 'feature-development'
  | 'social-monitoring'
  | 'repo-analysis'
  | 'project-creation'
  | 'research-monitoring'
  | 'maintenance'
  | 'custom'
type TargetType = 'new-project' | 'local-project' | 'github-repo' | 'social-source' | 'research-source' | 'custom-source'
type ScheduleKind = 'continuous' | 'once' | 'hourly' | 'daily' | 'weekly' | 'custom'
type AutonomyLevel = 'guided' | 'semi-auto' | 'full-auto'
type CommitBehavior = 'commit' | 'suggest' | 'none'
type ReportFormat = 'summary' | 'detailed' | 'brief'
type SafetyLevel = 'strict' | 'balanced' | 'wide'

interface AutoAction {
  type: string
  phase?: number
  message?: string
  reason?: string
  at?: number
  [key: string]: unknown
}

interface LoopTemplate {
  id: string
  title: string
  type: LoopType
  targetType: TargetType
  scheduleKind: ScheduleKind
  autonomy: AutonomyLevel
  commitBehavior: CommitBehavior
  prompt: string
  description: string
  cadenceMinutes?: number
}

const EXECUTORS: Array<{ target: ExecutorTarget; kind?: PtyCommandKind; label: string; hint: string }> = [
  { target: 'local', label: 'Local / Ollama', hint: 'fully local model execution' },
  { target: 't1', kind: 'claude-auto', label: 'Claude / Atlantis', hint: 'best for coding agent work' },
  { target: 't2', kind: 'codex-auto', label: 'ChatGPT / Olympus', hint: 'use when Claude is busy' }
]

const LOOP_ACTIVITY = [
  { active: true, label: 'Active', hint: 'Akorith continues automatically within the selected autonomy mode.' },
  { active: false, label: 'Passive', hint: 'Akorith waits for you before continuing.' }
]

const LOOP_TYPES: Array<{ id: LoopType; label: string; hint: string }> = [
  { id: 'project-improvement', label: 'Project improvement', hint: 'Improve an existing app over repeated cycles.' },
  { id: 'feature-development', label: 'Feature loop', hint: 'Find, rank, build, test, and commit useful features.' },
  { id: 'social-monitoring', label: 'Social monitor', hint: 'Watch accounts, keywords, competitors, or sources.' },
  { id: 'repo-analysis', label: 'Repository analysis', hint: 'Audit repos repeatedly and surface actions.' },
  { id: 'project-creation', label: 'Project creation', hint: 'Generate and build new usable projects.' },
  { id: 'research-monitoring', label: 'Research monitor', hint: 'Track news, papers, products, and trends.' },
  { id: 'maintenance', label: 'Maintenance', hint: 'Docs, tests, dependencies, releases, and cleanup.' },
  { id: 'custom', label: 'Custom', hint: 'Any repeated AI-driven workflow.' }
]

const TARGET_TYPES: Array<{ id: TargetType; label: string; hint: string }> = [
  { id: 'new-project', label: 'New Akorith project', hint: 'Create a fresh workspace for the loop.' },
  { id: 'local-project', label: 'Local project', hint: 'Work inside an existing project folder.' },
  { id: 'github-repo', label: 'GitHub repository', hint: 'Track or improve a remote repository.' },
  { id: 'social-source', label: 'Social account/source', hint: 'Monitor posts, replies, trends, or competitors.' },
  { id: 'research-source', label: 'Research/news source', hint: 'Watch a topic, site, feed, or announcement stream.' },
  { id: 'custom-source', label: 'Custom target', hint: 'Describe any target in plain language.' }
]

const SCHEDULES: Array<{ id: ScheduleKind; label: string; detail: string; minutes: number }> = [
  { id: 'continuous', label: 'Continuous', detail: 'Keep moving until a stop condition is reached.', minutes: 0 },
  { id: 'once', label: 'Once', detail: 'Run one complete cycle.', minutes: 0 },
  { id: 'hourly', label: 'Hourly', detail: 'Repeat every hour.', minutes: 60 },
  { id: 'daily', label: 'Daily', detail: 'Repeat once per day.', minutes: 1440 },
  { id: 'weekly', label: 'Weekly', detail: 'Repeat once per week.', minutes: 10080 },
  { id: 'custom', label: 'Custom', detail: 'Use a custom minute interval.', minutes: 15 }
]

const AUTONOMY: Array<{ id: AutonomyLevel; label: string; detail: string }> = [
  { id: 'guided', label: 'Guided', detail: 'Ask before major actions.' },
  { id: 'semi-auto', label: 'Semi-Auto', detail: 'Run automatically, pause for risky choices.' },
  { id: 'full-auto', label: 'Full Auto', detail: 'Run end-to-end inside safety limits.' }
]

const TEMPLATES: LoopTemplate[] = [
  {
    id: 'github-commit',
    title: 'GitHub commit automation',
    type: 'project-improvement',
    targetType: 'local-project',
    scheduleKind: 'daily',
    autonomy: 'semi-auto',
    commitBehavior: 'commit',
    description: 'Improve, validate, commit, and report on a project repeatedly.',
    prompt: 'Keep improving this project every day. Add useful features, refactor weak areas, fix bugs, update documentation, run tests, and commit meaningful changes with clear messages.'
  },
  {
    id: 'feature-loop',
    title: 'Feature addition loop',
    type: 'feature-development',
    targetType: 'local-project',
    scheduleKind: 'continuous',
    autonomy: 'semi-auto',
    commitBehavior: 'commit',
    description: 'Analyze the product, rank improvements, build the best next feature.',
    prompt: 'Analyze this project, find missing features or weak UX, rank the safest useful improvements, implement the best next one, run validation, commit it, then re-analyze.'
  },
  {
    id: 'social-monitor',
    title: 'Social media monitoring',
    type: 'social-monitoring',
    targetType: 'social-source',
    scheduleKind: 'custom',
    autonomy: 'semi-auto',
    commitBehavior: 'commit',
    cadenceMinutes: 5,
    description: 'Watch an account, keyword, or competitor and report only meaningful changes.',
    prompt: 'Monitor the X account @ibrahimsait_. Every 5 minutes, check for new posts, reposts, replies, or profile updates. Keep a seen-state, summarize what changed, and suggest useful follow-up ideas.'
  },
  {
    id: 'repo-health',
    title: 'Repository health analysis',
    type: 'repo-analysis',
    targetType: 'github-repo',
    scheduleKind: 'weekly',
    autonomy: 'guided',
    commitBehavior: 'suggest',
    description: 'Find stale repos, missing tests, weak READMEs, CI gaps, and roadmap ideas.',
    prompt: 'Analyze the selected repositories every week. Detect stale areas, missing tests, weak documentation, outdated dependencies, and product opportunities. Produce a prioritized improvement report.'
  },
  {
    id: 'project-factory',
    title: 'Autonomous project factory',
    type: 'project-creation',
    targetType: 'new-project',
    scheduleKind: 'daily',
    autonomy: 'full-auto',
    commitBehavior: 'commit',
    description: 'Create one useful small developer tool, build it to MVP, and report.',
    prompt: 'Every day, create one useful small developer tool. Pick the most useful idea, scaffold it, build a usable MVP, test it, commit meaningful phases, and write a final report with architecture and next steps.'
  },
  {
    id: 'maintenance',
    title: 'Maintenance loop',
    type: 'maintenance',
    targetType: 'local-project',
    scheduleKind: 'daily',
    autonomy: 'semi-auto',
    commitBehavior: 'commit',
    description: 'Docs, tests, dependency updates, UI polish, changelog, and release prep.',
    prompt: 'Run a daily maintenance cycle: improve documentation, add missing tests, update safe dependencies, polish small UX issues, prepare changelog notes, validate the app, and commit only meaningful changes.'
  }
]

const RUNNING = new Set(['auto_running', 'proposing', 'preparing_context', 'sending', 'summarizing'])
const AUTO_ACTIVE = new Set([...RUNNING, 'awaiting_executor_result', 'awaiting_approval', 'idle', 'scheduled'])
const PAUSED = new Set(['awaiting_permission', 'paused'])

function projectKey(id: string): string {
  return id.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 40)
}

function parseAutoActions(json: string | null): AutoAction[] {
  if (!json) return []
  try {
    const list = JSON.parse(json) as AutoAction[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function commitsOf(session: MacroSessionRow): AutoAction[] {
  return parseAutoActions(session.autoActions).filter((a) => a.type === 'auto_commit' && a.message)
}

function executorForTarget(target: string): { target: ExecutorTarget; kind?: PtyCommandKind; label: string; hint: string } {
  return EXECUTORS.find((e) => e.target === target) ?? EXECUTORS[0]
}

function defaultExecutorForProvider(providerId: string): ExecutorTarget {
  if (providerId === 'local') return 'local'
  return providerId === 'chatgpt' ? 't2' : 't1'
}

function providerLabel(providers: ProviderInfo[], id: string): string {
  return providers.find((p) => p.id === id)?.label ?? id
}

function selectedModel(provider: ProviderInfo | undefined, value: string): string {
  if (!provider) return ''
  if (value && provider.models.includes(value)) return value
  return provider.models[0] ?? ''
}

function minutesForSchedule(kind: ScheduleKind, customMinutes: number): number {
  if (kind === 'custom') return Math.min(Math.max(Math.floor(customMinutes || 15), 1), 7 * 24 * 60)
  return SCHEDULES.find((s) => s.id === kind)?.minutes ?? 0
}

function loopIntentFor(type: LoopType, schedule: ScheduleKind): LoopIntent {
  if (type === 'social-monitoring' || type === 'research-monitoring') return 'monitor'
  if (type === 'project-creation' || schedule === 'daily' || schedule === 'weekly') return 'daily-build'
  if (schedule === 'custom' || schedule === 'hourly') return 'custom'
  return 'continuous'
}

function formatCadenceMinutes(minutes: number): string {
  if (!minutes) return 'continuous'
  if (minutes >= 1440 && minutes % 1440 === 0) return `every ${minutes / 1440} day${minutes === 1440 ? '' : 's'}`
  if (minutes >= 60 && minutes % 60 === 0) return `every ${minutes / 60} hour${minutes === 60 ? '' : 's'}`
  return `every ${minutes} min`
}

function formatDateTime(ts: number | null): string {
  if (!ts) return 'not scheduled'
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff >= day) return `${Math.floor(diff / day)}d ago`
  if (diff >= hour) return `${Math.floor(diff / hour)}h ago`
  if (diff >= minute) return `${Math.floor(diff / minute)}m ago`
  return 'just now'
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

interface Friendly {
  label: string
  tone: 'running' | 'paused' | 'done' | 'stopped' | 'idle' | 'error'
}

function friendlyStatus(session: MacroSessionRow): Friendly {
  const s = session.status
  if (session.archivedAt) return { label: 'Archived', tone: 'stopped' }
  if (session.mode === 'auto' && AUTO_ACTIVE.has(s)) {
    if (s === 'awaiting_executor_result' && session.nextRunAt && session.nextRunAt > Date.now()) {
      return { label: 'Active', tone: 'running' }
    }
    if (session.latestResult?.startsWith('Recovering automatically') || session.pauseReason?.startsWith('planner_error') || session.pauseReason?.startsWith('executor_error')) {
      return { label: 'Recovering', tone: 'running' }
    }
    return { label: 'Active', tone: 'running' }
  }
  if (RUNNING.has(s)) return { label: 'Running', tone: 'running' }
  if (s === 'completed') return { label: 'Completed', tone: 'done' }
  if (s === 'error' || s === 'failed') return { label: 'Failed', tone: 'error' }
  if (s === 'stopped') return { label: 'Stopped', tone: 'stopped' }
  if (s === 'scheduled') return { label: 'Scheduled', tone: 'idle' }
  if (PAUSED.has(s)) return { label: session.pauseReason ? 'Waiting for approval' : 'Paused', tone: 'paused' }
  return { label: 'Ready', tone: 'idle' }
}

function loopTitle(session: MacroSessionRow): string {
  if (session.title?.trim()) return session.title.trim()
  const goal = session.goal?.split('Loop profile:')[0]?.trim() ?? ''
  return goal ? goal.slice(0, 90) : 'Untitled loop'
}

function cleanGoal(session: MacroSessionRow): string {
  return (session.goal?.split('Loop profile:')[0]?.trim() || loopTitle(session)).slice(0, 1200)
}

function latestResult(session: MacroSessionRow, turns: MacroState['turns'] = []): string {
  if (session.mode === 'auto' && session.latestResult?.startsWith('planner_error:')) return 'Recovering automatically with the next available planner.'
  if (session.mode === 'auto' && session.latestResult?.startsWith('executor_error:')) return 'Recovering automatically and reconnecting the executor.'
  if (session.mode === 'auto' && session.latestResult === 'Waiting for the next scheduled cycle.') return 'Active; waiting for the next scheduled cycle.'
  if (session.latestResult?.trim()) return session.latestResult.trim()
  const last = [...turns].reverse().find((t) => t.executorResultSummary || t.error)
  if (last?.error) return last.error
  if (!last?.executorResultSummary) return 'No result recorded yet.'
  return resultLine(last.executorResultSummary) || 'Result summarized.'
}

function resultLine(summary: string | null): string {
  if (!summary) return ''
  const first = summary.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return first.replace(/^current status:?\s*/i, '').slice(0, 240)
}

function terminalText(snapshot: PtySnapshot | null): string {
  if (!snapshot?.text) return ''
  return snapshot.text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .slice(-80)
    .join('\n')
    .trim()
}

function parseStrArray(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function progressPercent(session: MacroSessionRow, turns: number, commits: number): number {
  if (session.maxCommits > 0) return Math.min(100, Math.round((commits / session.maxCommits) * 100))
  if (session.maxRuns > 0) return Math.min(100, Math.round((session.runCount / session.maxRuns) * 100))
  if (session.finalScore != null) return Math.min(100, Math.round(session.finalScore))
  if (session.maxIterations > 0) return Math.min(100, Math.round((turns / session.maxIterations) * 100))
  return 0
}

export default function LoopsPage({ active }: { active: boolean }): JSX.Element {
  const [view, setView] = useState<View>('list')
  const [loops, setLoops] = useState<MacroSessionRow[]>([])
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<MacroState | null>(null)
  const [description, setDescription] = useState('')
  const [loopType, setLoopType] = useState<LoopType>('project-improvement')
  const [targetType, setTargetType] = useState<TargetType>('new-project')
  const [targetRef, setTargetRef] = useState('')
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>('continuous')
  const [customMinutes, setCustomMinutes] = useState(15)
  const [autonomyLevel, setAutonomyLevel] = useState<AutonomyLevel>('semi-auto')
  const [fullyLoopActive, setFullyLoopActive] = useState(true)
  const [maxRuns, setMaxRuns] = useState(30)
  const [maxCommits, setMaxCommits] = useState(0)
  const [commitBehavior, setCommitBehavior] = useState<CommitBehavior>('commit')
  const [pushEnabled, setPushEnabled] = useState(true)
  const [testCommands, setTestCommands] = useState('')
  const [reportFormat, setReportFormat] = useState<ReportFormat>('summary')
  const [safetyLevel, setSafetyLevel] = useState<SafetyLevel>('balanced')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [plannerProvider, setPlannerProvider] = useState('')
  const [plannerModel, setPlannerModel] = useState('')
  const [executorTarget, setExecutorTarget] = useState<ExecutorTarget>('t1')
  const [detailProvider, setDetailProvider] = useState('')
  const [detailModel, setDetailModel] = useState('')
  const [detailTarget, setDetailTarget] = useState<ExecutorTarget>('t1')
  const [terminalSnapshot, setTerminalSnapshot] = useState<PtySnapshot | null>(null)
  const [savingPlanner, setSavingPlanner] = useState(false)
  const [busy, setBusy] = useState(false)
  const [busyNote, setBusyNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshLoops = useCallback(async (): Promise<void> => {
    try {
      const list = await window.api.macro.list(100)
      setLoops(list.filter((s) => s.workspaceDir && !s.archivedAt))
    } catch {
      /* keep last list */
    }
  }, [])

  const refreshProjects = useCallback(async (): Promise<void> => {
    try {
      setProjects(await window.api.projects.list())
    } catch {
      /* best effort */
    }
  }, [])

  const refreshProviders = useCallback(async (): Promise<ProviderInfo[]> => {
    const list = await window.api.chat.listProviders()
    setProviders(list)
    const firstAvailable = list.find((p) => p.available.ok) ?? list[0]
    if (firstAvailable) {
      setPlannerProvider((current) => (current && list.some((p) => p.id === current) ? current : firstAvailable.id))
      setPlannerModel((current) => current || firstAvailable.models[0] || '')
      setExecutorTarget((current) => current || defaultExecutorForProvider(firstAvailable.id))
    }
    return list
  }, [])

  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])

  useEffect(() => {
    if (!active) return
    void refreshProviders().catch(() => undefined)
    void refreshProjects()
  }, [active, refreshProviders, refreshProjects])

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = null
    if (!active) return
    if (view === 'detail' && selectedId) {
      const sid = selectedId
      const pull = (): void => {
        void window.api.macro.get(sid).then((d) => {
          if (!d) return
          setDetail(d)
          void window.api.pty.snapshot(d.session.targetTerminal, 8000).then(setTerminalSnapshot).catch(() => undefined)
        })
      }
      pull()
      pollRef.current = setInterval(pull, 2000)
    } else if (view === 'list') {
      setTerminalSnapshot(null)
      void refreshLoops()
      pollRef.current = setInterval(() => void refreshLoops(), 3000)
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [active, view, selectedId, refreshLoops])

  const createPlanner = useMemo(() => providers.find((p) => p.id === plannerProvider), [providers, plannerProvider])
  const detailPlanner = useMemo(() => providers.find((p) => p.id === detailProvider), [providers, detailProvider])
  const createModels = createPlanner?.models ?? []

  const ensureExecutor = useCallback(async (project: { id: string }, cwd: string, targetTerminal: string): Promise<void> => {
    const key = projectKey(project.id)
    const executor = executorForTarget(targetTerminal)
    if (executor.target === 'local' || !executor.kind) return
    window.api.pty.setActiveProject(key)
    await window.api.pty.create(`${executor.target}::${key}`, { cols: 120, rows: 32, cwd, commandKind: executor.kind })
  }, [])

  const applyTemplate = useCallback((template: LoopTemplate): void => {
    setLoopType(template.type)
    setTargetType(template.targetType)
    setScheduleKind(template.scheduleKind)
    setAutonomyLevel(template.autonomy)
    setCommitBehavior(template.commitBehavior)
    setCustomMinutes(template.cadenceMinutes ?? 15)
    setDescription(template.prompt)
    if (template.targetType === 'local-project' && projects[0]?.path) setTargetRef(projects[0].path)
    else setTargetRef('')
    setView('create')
    setError(null)
  }, [projects])

  const createLoop = useCallback(async (): Promise<void> => {
    const text = description.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      setBusyNote('Checking the selected model...')
      const list = providers.length ? providers : await refreshProviders()
      const planner = list.find((p) => p.id === plannerProvider) ?? list.find((p) => p.available.ok)
      if (!planner?.available.ok) {
        setError('No AI engine is available yet. Start Ollama, Claude, or Codex and try again.')
        return
      }
      const model = selectedModel(planner, plannerModel)
      const cadence = minutesForSchedule(scheduleKind, customMinutes)
      const intent = loopIntentFor(loopType, scheduleKind)
      const target = targetType === 'local-project' && targetRef ? targetRef : targetRef.trim()
      const mode = fullyLoopActive && autonomyLevel !== 'guided' ? 'auto' : 'approval'
      setBusyNote(targetType === 'local-project' && target ? 'Binding the loop to your project...' : 'Creating the loop workspace...')
      const res = await window.api.macro.createWorkspaceProject({
        seed: text,
        plannerProvider: planner.id,
        plannerModel: model || undefined,
        targetTerminal: executorTarget,
        mode,
        loopIntent: intent,
        cadenceMinutes: cadence,
        maxIterations: maxRuns > 0 ? maxRuns : cadence > 0 ? 200 : 30,
        goodEnoughThreshold: autonomyLevel === 'full-auto' ? 92 : 88,
        loopType,
        targetType,
        targetRef: target,
        scheduleKind,
        scheduleDetail: cadence ? formatCadenceMinutes(cadence) : SCHEDULES.find((s) => s.id === scheduleKind)?.detail,
        autonomyLevel,
        stopCondition: maxCommits > 0 ? `stop after ${maxCommits} commits or manual stop` : maxRuns > 0 ? `stop after ${maxRuns} runs or manual stop` : 'manual stop',
        maxRuns,
        maxCommits,
        commitBehavior,
        pushEnabled,
        testCommands,
        reportFormat,
        safetyLevel
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      let state = res.state
      if (fullyLoopActive && autonomyLevel !== 'guided') {
        setBusyNote('Waking up the executor...')
        await ensureExecutor(res.project, res.workspaceDir, executorTarget)
        await new Promise((r) => setTimeout(r, 1500))
        setBusyNote('Starting the loop...')
        const started = await window.api.macro.startAuto(res.state.session.id)
        if (started.ok) state = started.state
      }
      setDescription('')
      setSelectedId(state.session.id)
      setDetail(state)
      setView('detail')
      void refreshLoops()
      void refreshProjects()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setBusyNote('')
    }
  }, [
    description,
    busy,
    providers,
    refreshProviders,
    plannerProvider,
    plannerModel,
    scheduleKind,
    customMinutes,
    loopType,
    targetType,
    targetRef,
    fullyLoopActive,
    autonomyLevel,
    executorTarget,
    maxRuns,
    maxCommits,
    commitBehavior,
    pushEnabled,
    testCommands,
    reportFormat,
    safetyLevel,
    ensureExecutor,
    refreshLoops,
    refreshProjects
  ])

  const selected = detail?.session ?? loops.find((l) => l.id === selectedId) ?? null

  useEffect(() => {
    if (!selected) return
    setDetailProvider(selected.plannerProvider)
    setDetailModel(selected.plannerModel ?? '')
    setDetailTarget(executorForTarget(selected.targetTerminal).target)
  }, [selected?.id, selected?.plannerProvider, selected?.plannerModel, selected?.targetTerminal])

  const openLoop = useCallback((id: string): void => {
    setSelectedId(id)
    setDetail(null)
    setView('detail')
    setError(null)
  }, [])

  const resumeLoop = useCallback(async (session: MacroSessionRow): Promise<void> => {
    if (!session.workspaceDir) return
    setBusy(true)
    setError(null)
    try {
      const allProjects = projects.length ? projects : await window.api.projects.list()
      const project = allProjects.find((p) => p.path === session.workspaceDir)
      if (project) {
        await ensureExecutor(project, session.workspaceDir, session.targetTerminal)
        await new Promise((r) => setTimeout(r, 1200))
      }
      const started = await window.api.macro.startAuto(session.id)
      if (!started.ok) setError(started.error)
      const d = await window.api.macro.get(session.id)
      if (d) setDetail(d)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [ensureExecutor, projects])

  const setLoopActivity = useCallback(async (session: MacroSessionRow, activeMode: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.macro.setMode(session.id, activeMode ? 'auto' : 'approval')
      if (!res.ok) {
        setError(res.error)
        return
      }
      setDetail(res.state)
      if (activeMode && session.status !== 'completed' && session.status !== 'stopped' && !RUNNING.has(session.status)) {
        await resumeLoop(res.state.session)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [resumeLoop])

  const stopLoop = useCallback(async (id: string): Promise<void> => {
    const res = await window.api.macro.stop(id)
    if (res.ok) setDetail(res.state)
    else setError(res.error)
  }, [])

  const archiveLoop = useCallback(async (id: string): Promise<void> => {
    const res = await window.api.macro.archive(id)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setView('list')
    setSelectedId(null)
    setDetail(null)
    void refreshLoops()
  }, [refreshLoops])

  const removeLoop = useCallback(async (id: string): Promise<void> => {
    if (!window.confirm('Remove this loop from Akorith? This deletes the local loop record, not the project folder.')) return
    const res = await window.api.macro.remove(id)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setView('list')
    setSelectedId(null)
    setDetail(null)
    void refreshLoops()
  }, [refreshLoops])

  const saveLoopPlanner = useCallback(async (session: MacroSessionRow): Promise<void> => {
    const list = providers.length ? providers : await refreshProviders()
    const planner = list.find((p) => p.id === detailProvider)
    if (!planner?.available.ok) {
      setError(planner?.available.reason || 'Selected model is not available right now.')
      return
    }
    setSavingPlanner(true)
    setError(null)
    try {
      const model = selectedModel(planner, detailModel)
      const res = await window.api.macro.setPlanner({
        sessionId: session.id,
        plannerProvider: planner.id,
        plannerModel: model || undefined,
        targetTerminal: detailTarget
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      if (session.workspaceDir) {
        const allProjects = projects.length ? projects : await window.api.projects.list()
        const project = allProjects.find((p) => p.path === session.workspaceDir)
        if (project) await ensureExecutor(project, session.workspaceDir, detailTarget)
      }
      setDetail(res.state)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingPlanner(false)
    }
  }, [providers, refreshProviders, detailProvider, detailModel, detailTarget, projects, ensureExecutor])

  const duplicateLoop = useCallback((session: MacroSessionRow): void => {
    setDescription(cleanGoal(session))
    setLoopType((session.loopType as LoopType) || 'custom')
    setTargetType((session.targetType as TargetType) || 'new-project')
    setTargetRef(session.targetRef ?? '')
    setScheduleKind((session.scheduleKind as ScheduleKind) || 'continuous')
    setCustomMinutes(session.cadenceMinutes || 15)
    setAutonomyLevel(session.mode === 'approval' ? 'guided' : 'semi-auto')
    setFullyLoopActive(session.mode === 'auto')
    setMaxRuns(session.maxRuns || session.maxIterations || 30)
    setMaxCommits(session.maxCommits || 0)
    setCommitBehavior((session.commitBehavior as CommitBehavior) || 'commit')
    setPushEnabled(session.pushEnabled)
    setTestCommands(session.testCommands ?? '')
    setReportFormat((session.reportFormat as ReportFormat) || 'summary')
    setSafetyLevel((session.safetyLevel as SafetyLevel) || 'balanced')
    setView('create')
  }, [])

  const dashboard = useMemo(() => {
    const activeLoops = loops.filter((l) => (l.mode === 'auto' && AUTO_ACTIVE.has(l.status)) || RUNNING.has(l.status)).length
    const pausedLoops = loops.filter((l) => !((l.mode === 'auto' && AUTO_ACTIVE.has(l.status)) || RUNNING.has(l.status)) && (PAUSED.has(l.status) || l.status === 'error')).length
    const completedLoops = loops.filter((l) => l.status === 'completed').length
    const failedLoops = loops.filter((l) => l.status === 'error' || l.status === 'failed').length
    const commits = loops.reduce((sum, l) => sum + commitsOf(l).length, 0)
    return { activeLoops, pausedLoops, completedLoops, failedLoops, commits }
  }, [loops])

  if (view === 'detail' && selected) {
    const f = friendlyStatus(selected)
    const turns = detail?.turns ?? []
    const commits = commitsOf(selected)
    const actions = parseAutoActions(selected.autoActions)
    const latest = turns.length ? turns[turns.length - 1] : null
    const isRunning = (selected.mode === 'auto' && AUTO_ACTIVE.has(selected.status)) || RUNNING.has(selected.status)
    const isPaused = !isRunning && (PAUSED.has(selected.status) || selected.status === 'idle')
    const options = parseStrArray(latest?.nextOptions)
    const progress = progressPercent(selected, turns.length, commits.length)
    const activity = latest?.plannerRationale?.trim() || latest?.proposal?.trim() || ''

    return (
      <div className="loops-page loop-ops">
        <button type="button" className="loop-back" onClick={() => setView('list')}>
          <ChevronIcon size={16} direction="left" /> All loops
        </button>

        <section className="loop-detail loop-detail-wide">
          <div className="loop-detail-hero">
            <div>
              <div className="loop-kicker">{selected.loopType?.replace(/-/g, ' ') || 'autonomous loop'}</div>
              <h1>{loopTitle(selected)}</h1>
              <p>{cleanGoal(selected)}</p>
            </div>
            <span className={`loop-pill is-${f.tone}`}>{f.label}</span>
          </div>

          <div className="loop-stats loop-stats-four">
            <div className="loop-stat">
              <span className="loop-stat-num">{selected.runCount || turns.length}</span>
              <span className="loop-stat-label">runs recorded</span>
            </div>
            <div className="loop-stat">
              <span className="loop-stat-num">{commits.length}</span>
              <span className="loop-stat-label">commits saved</span>
            </div>
            <div className="loop-stat">
              <span className="loop-stat-num">{progress}%</span>
              <span className="loop-stat-label">progress</span>
            </div>
            <div className="loop-stat">
              <span className="loop-stat-num">{fmtDuration(Date.now() - selected.createdAt)}</span>
              <span className="loop-stat-label">since start</span>
            </div>
          </div>

          <div className="loop-progress"><span style={{ width: `${progress}%` }} /></div>

          <div className="loop-control-panel loop-ops-panel">
            <div className="loop-activity-row">
              <div>
                <span className="loop-control-label">Loop automation</span>
                <strong>{selected.mode === 'auto' ? 'Active' : 'Passive'}</strong>
              </div>
              <div className="loop-segmented is-compact">
                {LOOP_ACTIVITY.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    className={(selected.mode === 'auto') === item.active ? 'is-selected' : ''}
                    disabled={busy || selected.status === 'completed' || selected.status === 'stopped'}
                    title={item.hint}
                    onClick={() => void setLoopActivity(selected, item.active)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="loop-control-row">
              <label className="loop-field">
                <span>Planning model</span>
                <select
                  value={detailProvider}
                  disabled={savingPlanner || providers.length === 0}
                  onChange={(e) => {
                    const id = e.target.value
                    const p = providers.find((item) => item.id === id)
                    setDetailProvider(id)
                    setDetailModel(p?.models[0] ?? '')
                    setDetailTarget(defaultExecutorForProvider(id))
                  }}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available.ok && p.id !== selected.plannerProvider}>
                      {p.label}{p.available.ok ? '' : ' (offline)'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="loop-field">
                <span>Variant</span>
                <select
                  value={detailModel}
                  disabled={savingPlanner || !detailPlanner || detailPlanner.models.length === 0}
                  onChange={(e) => setDetailModel(e.target.value)}
                >
                  {(detailPlanner?.models.length ? detailPlanner.models : ['']).map((m) => (
                    <option key={m || 'default'} value={m}>{m || 'Default'}</option>
                  ))}
                </select>
              </label>
              <label className="loop-field">
                <span>Executor</span>
                <select
                  value={detailTarget}
                  disabled={savingPlanner}
                  onChange={(e) => setDetailTarget(executorForTarget(e.target.value).target)}
                >
                  {EXECUTORS.map((e) => (
                    <option key={e.target} value={e.target}>{e.label}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="loop-btn" disabled={savingPlanner || !detailProvider || !detailPlanner?.available.ok} onClick={() => void saveLoopPlanner(selected)}>
                {savingPlanner ? 'Saving...' : 'Save model'}
              </button>
            </div>

            <div className="loop-meta-strip">
              <span>{selected.targetType || 'target'}: {selected.targetRef || selected.workspaceDir || 'workspace'}</span>
              <span>{selected.scheduleKind || 'schedule'} · {selected.cadenceMinutes ? formatCadenceMinutes(selected.cadenceMinutes) : 'continuous'}</span>
              <span>{selected.commitBehavior || 'commit'} · push {selected.pushEnabled ? 'on' : 'off'}</span>
              <span>next run: {formatDateTime(selected.nextRunAt)}</span>
            </div>
          </div>

          {error && <div className="loop-note is-error">{error}</div>}
          {selected.pauseReason && <div className="loop-note">Waiting: {selected.pauseReason.replace(/_/g, ' ')}</div>}
          {selected.status === 'error' && selected.stopReason && <div className="loop-note is-error">{selected.stopReason}</div>}

          <div className="loop-actions loop-actions-wrap">
            {(isPaused || selected.status === 'idle') && selected.status !== 'completed' && selected.status !== 'stopped' && (
              <button type="button" className="loop-btn is-primary" disabled={busy} onClick={() => void resumeLoop(selected)}>
                {busy ? 'Resuming...' : 'Resume'}
              </button>
            )}
            {isRunning && <button type="button" className="loop-btn is-stop" onClick={() => void stopLoop(selected.id)}>Stop</button>}
            {selected.status !== 'completed' && <button type="button" className="loop-btn" onClick={() => void window.api.macro.complete(selected.id).then((r) => r.ok && setDetail(r.state))}>Mark complete</button>}
            <button type="button" className="loop-btn" onClick={() => duplicateLoop(selected)}>Duplicate</button>
            <button type="button" className="loop-btn" onClick={() => void archiveLoop(selected.id)}>Archive</button>
            <button type="button" className="loop-btn is-stop" onClick={() => void removeLoop(selected.id)}>Remove loop</button>
          </div>

          <div className="loop-detail-grid">
            <section className="loop-panel loop-terminal-panel">
              <h2>Live executor terminal</h2>
              {terminalSnapshot?.alive ? (
                <pre>{terminalText(terminalSnapshot) || 'Executor is live. Waiting for output...'}</pre>
              ) : (
                <div className="loop-empty">Executor terminal is starting or not attached yet.</div>
              )}
            </section>

            <section className="loop-panel">
              <h2>Now</h2>
              <p>{activity || latestResult(selected, turns)}</p>
              {options.length > 0 && (
                <div className="loop-steer-options">
                  {options.map((opt, i) => (
                    <button key={i} type="button" className="loop-chip" onClick={() => void window.api.macro.steer(selected.id, opt)}>
                      {opt}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="loop-panel">
              <h2>Safety</h2>
              <ul className="loop-simple-list">
                <li>Destructive commands require approval.</li>
                <li>Secrets, .env files, and credentials must not be committed.</li>
                <li>Validation failures are reported honestly.</li>
                <li>Every automatic action is persisted in history.</li>
              </ul>
            </section>
          </div>

          <h2 className="loop-section-title">Run timeline</h2>
          {turns.length === 0 ? (
            <div className="loop-empty">No runs yet. Active loops start automatically after their executor wakes up.</div>
          ) : (
            <ol className="loop-steps">
              {[...turns].reverse().map((t) => {
                const result = resultLine(t.executorResultSummary)
                return (
                  <li key={t.id} className="loop-step">
                    <div className="loop-step-head">
                      <span className="loop-step-n">Run {t.turnIndex}</span>
                      {t.criticScore != null && (
                        <span className={`loop-pill is-${t.criticVerdict === 'regressed' ? 'error' : t.criticVerdict === 'complete' || t.criticVerdict === 'advanced' ? 'done' : 'paused'}`}>
                          {t.criticScore}/100
                        </span>
                      )}
                    </div>
                    {t.plannerRationale && <div className="loop-step-plan">{t.plannerRationale}</div>}
                    {result && <div className="loop-step-result">{result}</div>}
                    {t.error && <div className="loop-step-result is-error">{t.error}</div>}
                  </li>
                )
              })}
            </ol>
          )}

          <div className="loop-detail-grid">
            <section className="loop-panel">
              <h2>Audit trail</h2>
              {actions.length === 0 ? (
                <div className="loop-empty">No automatic actions recorded yet.</div>
              ) : (
                <ol className="loop-audit">
                  {[...actions].reverse().slice(0, 12).map((a, i) => (
                    <li key={i}>
                      <span>{a.type.replace(/_/g, ' ')}</span>
                      <strong>{a.message || a.reason || (a.at ? timeAgo(a.at) : '')}</strong>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <section className="loop-panel">
              <h2>Final report</h2>
              <p>{selected.status === 'completed' ? latestResult(selected, turns) : 'The report fills in as the loop records runs, commits, findings, and completion notes.'}</p>
              {commits.length > 0 && (
                <ol className="loop-commits">
                  {[...commits].reverse().map((c, i) => (
                    <li key={i} className="loop-commit"><span className="loop-commit-dot" /><span className="loop-commit-msg">{c.message}</span></li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          {selected.workspaceDir && <div className="loop-folder">Workspace <code>{selected.workspaceDir}</code></div>}
        </section>
      </div>
    )
  }

  if (view === 'create') {
    const cadence = minutesForSchedule(scheduleKind, customMinutes)
    const activeMode = fullyLoopActive && autonomyLevel !== 'guided'
    const selectedProjectPath = targetType === 'local-project' ? targetRef || projects[0]?.path || '' : targetRef

    return (
      <div className="loops-page loop-ops">
        <button type="button" className="loop-back" onClick={() => !busy && setView('list')}>
          <ChevronIcon size={16} direction="left" /> All loops
        </button>

        <section className="loop-create loop-create-wide">
          <div className="loop-create-head">
            <div>
              <div className="loop-kicker">Create loop</div>
              <h1>What should this loop do?</h1>
              <p className="loops-sub">Start simple. Akorith turns the instruction into a scheduled, auditable AI workflow.</p>
            </div>
          </div>

          <textarea
            className="loop-create-input"
            rows={5}
            autoFocus
            disabled={busy}
            value={description}
            placeholder="Keep improving this project every day. Find useful features, implement the best next change, run validation, commit it, and write a clear summary."
            onChange={(e) => setDescription(e.target.value)}
          />

          <div className="loop-create-layout">
            <section className="loop-panel">
              <h2>Loop type</h2>
              <div className="loop-option-grid">
                {LOOP_TYPES.map((item) => (
                  <button key={item.id} type="button" className={loopType === item.id ? 'is-selected' : ''} disabled={busy} onClick={() => setLoopType(item.id)}>
                    <strong>{item.label}</strong>
                    <span>{item.hint}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="loop-panel">
              <h2>Where should it work?</h2>
              <div className="loop-control-row is-two">
                <label className="loop-field">
                  <span>Target</span>
                  <select value={targetType} disabled={busy} onChange={(e) => {
                    const next = e.target.value as TargetType
                    setTargetType(next)
                    setTargetRef(next === 'local-project' ? projects[0]?.path ?? '' : '')
                  }}>
                    {TARGET_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </label>
                {targetType === 'local-project' ? (
                  <label className="loop-field">
                    <span>Project</span>
                    <select value={selectedProjectPath} disabled={busy || projects.length === 0} onChange={(e) => setTargetRef(e.target.value)}>
                      {projects.length === 0 && <option value="">No saved projects yet</option>}
                      {projects.filter((p) => p.path).map((p) => <option key={p.id} value={p.path ?? ''}>{p.name}</option>)}
                    </select>
                  </label>
                ) : (
                  <label className="loop-field">
                    <span>Target reference</span>
                    <input value={targetRef} disabled={busy} placeholder="@account, repo URL, topic, source..." onChange={(e) => setTargetRef(e.target.value)} />
                  </label>
                )}
              </div>
            </section>

            <section className="loop-panel">
              <h2>How often should it run?</h2>
              <div className="loop-segmented loop-segmented-six">
                {SCHEDULES.map((s) => (
                  <button key={s.id} type="button" className={scheduleKind === s.id ? 'is-selected' : ''} disabled={busy} onClick={() => setScheduleKind(s.id)}>
                    {s.label}
                  </button>
                ))}
              </div>
              {scheduleKind === 'custom' && (
                <label className="loop-field loop-field-small">
                  <span>Minutes</span>
                  <input type="number" min={1} max={10080} value={customMinutes} disabled={busy} onChange={(e) => setCustomMinutes(Number(e.target.value))} />
                </label>
              )}
              <p className="loop-field-hint">{SCHEDULES.find((s) => s.id === scheduleKind)?.detail} {cadence ? `Current rhythm: ${formatCadenceMinutes(cadence)}.` : ''}</p>
            </section>

            <section className="loop-panel">
              <h2>How much freedom should the AI have?</h2>
              <div className="loop-option-grid is-three">
                {AUTONOMY.map((a) => (
                  <button key={a.id} type="button" className={autonomyLevel === a.id ? 'is-selected' : ''} disabled={busy} onClick={() => setAutonomyLevel(a.id)}>
                    <strong>{a.label}</strong>
                    <span>{a.detail}</span>
                  </button>
                ))}
              </div>
              <div className="loop-activity-row is-inline">
                <div>
                  <span className="loop-control-label">Fully loop</span>
                  <strong>{fullyLoopActive ? 'Active' : 'Passive'}</strong>
                </div>
                <div className="loop-segmented is-compact">
                  {LOOP_ACTIVITY.map((item) => (
                    <button key={item.label} type="button" className={fullyLoopActive === item.active ? 'is-selected' : ''} disabled={busy} title={item.hint} onClick={() => setFullyLoopActive(item.active)}>
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          </div>

          <button type="button" className="loop-advanced-toggle" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? 'Hide advanced settings' : 'Advanced settings'}
          </button>

          {showAdvanced && (
            <div className="loop-create-controls">
              <div className="loop-control-row">
                <label className="loop-field">
                  <span>Planning model</span>
                  <select value={plannerProvider} disabled={busy || providers.length === 0} onChange={(e) => {
                    const id = e.target.value
                    const p = providers.find((item) => item.id === id)
                    setPlannerProvider(id)
                    setPlannerModel(p?.models[0] ?? '')
                    setExecutorTarget(defaultExecutorForProvider(id))
                  }}>
                    {providers.map((p) => <option key={p.id} value={p.id} disabled={!p.available.ok}>{p.label}{p.available.ok ? '' : ' (offline)'}</option>)}
                  </select>
                </label>
                <label className="loop-field">
                  <span>Variant</span>
                  <select value={plannerModel} disabled={busy || !createPlanner || createModels.length === 0} onChange={(e) => setPlannerModel(e.target.value)}>
                    {(createModels.length ? createModels : ['']).map((m) => <option key={m || 'default'} value={m}>{m || 'Default'}</option>)}
                  </select>
                </label>
                <label className="loop-field">
                  <span>Executor</span>
                  <select value={executorTarget} disabled={busy} onChange={(e) => setExecutorTarget(executorForTarget(e.target.value).target)}>
                    {EXECUTORS.map((e) => <option key={e.target} value={e.target}>{e.label}</option>)}
                  </select>
                </label>
                <label className="loop-field">
                  <span>Report</span>
                  <select value={reportFormat} disabled={busy} onChange={(e) => setReportFormat(e.target.value as ReportFormat)}>
                    <option value="summary">Readable summary</option>
                    <option value="detailed">Detailed report</option>
                    <option value="brief">Brief alert</option>
                  </select>
                </label>
              </div>

              <div className="loop-control-row">
                <label className="loop-field">
                  <span>Max runs</span>
                  <input type="number" min={1} max={10000} value={maxRuns} disabled={busy} onChange={(e) => setMaxRuns(Number(e.target.value))} />
                </label>
                <label className="loop-field">
                  <span>Max commits</span>
                  <input type="number" min={0} max={10000} value={maxCommits} disabled={busy} onChange={(e) => setMaxCommits(Number(e.target.value))} />
                </label>
                <label className="loop-field">
                  <span>Commit behavior</span>
                  <select value={commitBehavior} disabled={busy} onChange={(e) => setCommitBehavior(e.target.value as CommitBehavior)}>
                    <option value="commit">Commit meaningful changes</option>
                    <option value="suggest">Suggest only</option>
                    <option value="none">No commits</option>
                  </select>
                </label>
                <label className="loop-field">
                  <span>Safety</span>
                  <select value={safetyLevel} disabled={busy} onChange={(e) => setSafetyLevel(e.target.value as SafetyLevel)}>
                    <option value="strict">Strict</option>
                    <option value="balanced">Balanced</option>
                    <option value="wide">Wide</option>
                  </select>
                </label>
              </div>

              <label className="loop-check">
                <input type="checkbox" checked={pushEnabled} disabled={busy} onChange={(e) => setPushEnabled(e.target.checked)} />
                Push every loop commit to AkorithLoop
              </label>

              <label className="loop-field">
                <span>Validation commands</span>
                <input value={testCommands} disabled={busy} placeholder="Auto-detect, or e.g. npm run typecheck && npm test" onChange={(e) => setTestCommands(e.target.value)} />
              </label>
            </div>
          )}

          <div className="loop-meta-strip loop-create-summary">
            <span>{createPlanner ? `${createPlanner.label} plans` : 'no model selected'}</span>
            <span>{executorForTarget(executorTarget).label} executes</span>
            <span>{activeMode ? 'active automation' : 'guided/passive'}</span>
            <span>{cadence ? formatCadenceMinutes(cadence) : 'continuous'}</span>
            <span>{commitBehavior}{pushEnabled ? ' + push' : ''}</span>
          </div>

          {error && <div className="loop-note is-error">{error}</div>}
          {createPlanner && !createPlanner.available.ok && <div className="loop-note is-error">{createPlanner.available.reason || 'This provider is unavailable right now.'}</div>}

          <div className="loop-actions">
            <button type="button" className="loop-btn is-primary is-big" disabled={!description.trim() || busy || !createPlanner?.available.ok} onClick={() => void createLoop()}>
              {busy ? busyNote || 'Setting up...' : 'Create Loop'}
            </button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="loops-page loop-ops">
      <header className="loops-head loop-ops-head">
        <div>
          <div className="loops-title">
            <LoopIcon size={22} />
            <h1>Loop Operations Center</h1>
          </div>
          <p className="loops-sub">
            Create autonomous workflows that monitor, analyze, build, validate, commit, report, and continue over time.
          </p>
        </div>
        <button type="button" className="loop-btn is-primary" onClick={() => setView('create')}>
          <PlusIcon size={16} /> Create Loop
        </button>
      </header>

      {error && <div className="loop-note is-error">{error}</div>}

      <section className="loop-dashboard">
        <div><strong>{dashboard.activeLoops}</strong><span>Active</span></div>
        <div><strong>{dashboard.pausedLoops}</strong><span>Needs attention</span></div>
        <div><strong>{dashboard.completedLoops}</strong><span>Completed</span></div>
        <div><strong>{dashboard.failedLoops}</strong><span>Failed</span></div>
        <div><strong>{dashboard.commits}</strong><span>Commits</span></div>
      </section>

      <section className="loop-template-section">
        <div className="loop-section-head">
          <h2>Templates</h2>
          <span>Start from a proven automation pattern, then customize it.</span>
        </div>
        <div className="loop-template-grid">
          {TEMPLATES.map((template) => (
            <button key={template.id} type="button" className="loop-template-card" onClick={() => applyTemplate(template)}>
              <strong>{template.title}</strong>
              <span>{template.description}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="loop-section-head">
        <h2>Loops</h2>
        <span>{loops.length} workflow{loops.length === 1 ? '' : 's'} saved locally</span>
      </section>

      <div className="loops-grid loop-card-grid">
        <button type="button" className="loop-card loop-card-new" onClick={() => setView('create')}>
          <span className="loop-plus"><PlusIcon size={28} /></span>
          <span className="loop-card-new-label">Create Loop</span>
        </button>

        {loops.map((loop) => {
          const f = friendlyStatus(loop)
          const commits = commitsOf(loop)
          const progress = progressPercent(loop, loop.runCount, commits.length)
          return (
            <button key={loop.id} type="button" className="loop-card loop-ops-card" onClick={() => openLoop(loop.id)}>
              <div className="loop-card-top">
                <span className={`loop-pill is-${f.tone}`}>{f.label}</span>
                <span>{loop.loopType?.replace(/-/g, ' ') || 'custom'}</span>
              </div>
              <div className="loop-card-title">{loopTitle(loop)}</div>
              <div className="loop-card-meta">{loop.targetType || 'target'} · {providerLabel(providers, loop.plannerProvider)} · {loop.mode === 'auto' ? 'active' : 'passive'}</div>
              <div className="loop-progress"><span style={{ width: `${progress}%` }} /></div>
              <div className="loop-card-result">{latestResult(loop)}</div>
              <div className="loop-card-foot">
                <span>{commits.length} commit{commits.length === 1 ? '' : 's'}</span>
                <span>{loop.nextRunAt ? formatDateTime(loop.nextRunAt) : timeAgo(loop.updatedAt)}</span>
              </div>
            </button>
          )
        })}
      </div>

      {loops.length === 0 && (
        <div className="loop-empty loops-empty">No loops yet. Create one from a template or describe your own autonomous workflow.</div>
      )}
    </div>
  )
}
