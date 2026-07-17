import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  CreateResearchJobInput,
  ProviderInfo,
  ResearchJob,
  ResearchJobDetail,
  ResearchOutputFormat
} from '../../../preload/index.d'
import { CloseIcon, PlusIcon } from './icons'
import ResearchComposer from './ResearchComposer'
import ResearchLibrary from './ResearchLibrary'
import ResearchProgress from './ResearchProgress'

interface ResearchPageProps {
  active: boolean
}

type ResearchSurface = 'workspace' | 'library'

export default function ResearchPage({ active }: ResearchPageProps): JSX.Element {
  const [surface, setSurface] = useState<ResearchSurface>('workspace')
  const [jobs, setJobs] = useState<ResearchJob[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ResearchJobDetail | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [covers, setCovers] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(true)
  const [actionPending, setActionPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const actionPendingRef = useRef(false)
  const detailRequestRef = useRef(0)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId

  const loadJobs = useCallback(async (preserveSelection = true): Promise<ResearchJob[]> => {
    const next = await window.api.research.list()
    setJobs(next)
    setSelectedId((current) => {
      if (!preserveSelection) return next[0]?.id ?? null
      if (current === null) return null
      return next.some((job) => job.id === current) ? current : next[0]?.id ?? null
    })
    return next
  }, [])

  const loadDetail = useCallback(async (id: string): Promise<ResearchJobDetail> => {
    const request = ++detailRequestRef.current
    const next = await window.api.research.get(id)
    if (request === detailRequestRef.current && selectedRef.current === id) {
      setDetail(next)
      setJobs((current) => current.map((job) => job.id === next.job.id ? next.job : job))
    }
    return next
  }, [])

  useEffect(() => {
    if (!active || providers) return
    let cancelled = false
    void window.api.chat.listProviders()
      .then((next) => { if (!cancelled) setProviders(next) })
      .catch((nextError) => { if (!cancelled) setError(errorMessage(nextError)) })
    return () => { cancelled = true }
  }, [active, providers])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    setLoading(true)
    const refresh = async (): Promise<void> => {
      try {
        await loadJobs()
        if (!cancelled) setLoading(false)
      } catch (nextError) {
        if (!cancelled) {
          setLoading(false)
          setError(errorMessage(nextError))
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 5_000)
      }
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [active, loadJobs])

  useEffect(() => {
    if (!active || !selectedId) {
      setDetail(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async (): Promise<void> => {
      try {
        const next = await loadDetail(selectedId)
        if (cancelled) return
        const activeStatus = next.running || !['completed', 'paused', 'archived'].includes(next.job.status)
        timer = setTimeout(() => void poll(), activeStatus ? 1_500 : 6_000)
      } catch (nextError) {
        if (!cancelled) {
          setError(errorMessage(nextError))
          timer = setTimeout(() => void poll(), 8_000)
        }
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [active, loadDetail, selectedId])

  useEffect(() => {
    if (!active) return
    const missing = jobs.filter((job) => job.coverPath && !(job.id in covers))
    if (missing.length === 0) return
    let cancelled = false
    void Promise.all(missing.map(async (job) => [job.id, await window.api.research.coverDataUrl(job.id)] as const))
      .then((entries) => {
        if (cancelled) return
        setCovers((current) => ({ ...current, ...Object.fromEntries(entries) }))
      })
      .catch((nextError) => { if (!cancelled) setError(errorMessage(nextError)) })
    return () => { cancelled = true }
  }, [active, covers, jobs])

  const runningCount = useMemo(
    () => jobs.filter((job) => !['completed', 'paused', 'error', 'archived'].includes(job.status)).length,
    [jobs]
  )

  async function runAction(action: () => Promise<unknown>): Promise<boolean> {
    if (actionPendingRef.current) return false
    actionPendingRef.current = true
    setActionPending(true)
    setError(null)
    try {
      await action()
      const nextJobs = await loadJobs()
      if (selectedRef.current && nextJobs.some((job) => job.id === selectedRef.current)) {
        await loadDetail(selectedRef.current)
      }
      return true
    } catch (nextError) {
      setError(errorMessage(nextError))
      return false
    } finally {
      actionPendingRef.current = false
      setActionPending(false)
    }
  }

  async function createResearch(input: CreateResearchJobInput): Promise<boolean> {
    return runAction(async () => {
      const job = await window.api.research.create(input)
      selectedRef.current = job.id
      setSelectedId(job.id)
      setSurface('workspace')
    })
  }

  function openJob(id: string): void {
    setSelectedId(id)
    setSurface('workspace')
  }

  function closeTab(id: string): void {
    if (selectedId !== id) return
    const index = jobs.findIndex((job) => job.id === id)
    setSelectedId(jobs[index + 1]?.id ?? jobs[index - 1]?.id ?? null)
  }

  function handleSurfaceKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const nextSurface: ResearchSurface = event.key === 'ArrowLeft' || event.key === 'Home' ? 'workspace' : 'library'
    event.preventDefault()
    setSurface(nextSurface)
    const targetId = nextSurface === 'workspace' ? 'research-workspace-tab' : 'research-library-tab'
    document.getElementById(targetId)?.focus()
  }

  return (
    <div className="research-page">
      <header className="research-page-toolbar">
        <div className="research-surface-switch" role="tablist" aria-label="Research views">
          <button id="research-workspace-tab" type="button" role="tab" aria-controls="research-view-panel" aria-selected={surface === 'workspace'} tabIndex={surface === 'workspace' ? 0 : -1} className={surface === 'workspace' ? 'is-active' : ''} onClick={() => setSurface('workspace')} onKeyDown={handleSurfaceKeyDown}>Research</button>
          <button id="research-library-tab" type="button" role="tab" aria-controls="research-view-panel" aria-selected={surface === 'library'} tabIndex={surface === 'library' ? 0 : -1} className={surface === 'library' ? 'is-active' : ''} onClick={() => setSurface('library')} onKeyDown={handleSurfaceKeyDown}>Library <span>{jobs.length}</span></button>
        </div>
        <div className="research-toolbar-status" role="status" aria-live="polite"><i aria-hidden="true" />{runningCount > 0 ? `${runningCount} running` : 'Ready'}</div>
        <button
          type="button"
          className="research-new-tab"
          onClick={() => { setSelectedId(null); setSurface('workspace') }}
        >
          <PlusIcon size={15} /> New research
        </button>
      </header>

      {surface === 'workspace' && jobs.length > 0 && (
        <nav className="research-tabs" aria-label="Open research tabs">
          <div>
            {jobs.map((job) => (
              <button
                key={job.id}
                type="button"
                className={selectedId === job.id ? 'is-active' : ''}
                aria-label={`${job.plan?.title || job.title}${selectedId === job.id ? ', active; press Delete to close' : ''}`}
                onClick={(event) => {
                  if ((event.target as Element).closest('[data-research-tab-close]')) closeTab(job.id)
                  else openJob(job.id)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Delete' && selectedId === job.id) {
                    event.preventDefault()
                    closeTab(job.id)
                  }
                }}
              >
                <i className={`is-${job.status}`} aria-hidden="true" />
                <span>{job.plan?.title || job.title}</span>
                {selectedId === job.id && (
                  <em
                    data-research-tab-close
                    title="Close tab"
                    aria-hidden="true"
                  >
                    <CloseIcon size={12} />
                  </em>
                )}
              </button>
            ))}
          </div>
        </nav>
      )}

      <main
        id="research-view-panel"
        className="research-page-content"
        role="tabpanel"
        aria-labelledby={surface === 'workspace' ? 'research-workspace-tab' : 'research-library-tab'}
      >
        {error && <div className="research-page-alert" role="alert"><span>{error}</span><button type="button" title="Dismiss" aria-label="Dismiss" onClick={() => setError(null)}><CloseIcon size={13} /></button></div>}
        {surface === 'library' ? (
          <ResearchLibrary jobs={jobs} covers={covers} onSelect={openJob} />
        ) : selectedId && detail?.job.id === selectedId ? (
          <ResearchProgress
            detail={detail}
            actionPending={actionPending}
            onPause={async () => { await runAction(() => window.api.research.pause(selectedId)) }}
            onResume={async () => { await runAction(() => window.api.research.resume(selectedId)) }}
            onExport={async (format: ResearchOutputFormat) => { await runAction(() => window.api.research.export(selectedId, format)) }}
            onOpenArtifact={async (id) => { await runAction(() => window.api.research.openArtifact(id)) }}
            onRevealArtifact={async (id) => { await runAction(() => window.api.research.revealArtifact(id)) }}
            onOpenSource={async (id) => { await runAction(() => window.api.research.openSource(id)) }}
          />
        ) : loading ? (
          <div className="research-page-loading" role="status"><i aria-hidden="true" /><span>Loading Research…</span></div>
        ) : (
          <ResearchComposer providers={providers} disabled={actionPending} onSubmit={createResearch} />
        )}
      </main>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
