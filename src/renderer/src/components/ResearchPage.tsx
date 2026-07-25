import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  CreateResearchJobInput,
  ProviderInfo,
  ResearchJob,
  ResearchLiveDetail,
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
  const [openTabIds, setOpenTabIds] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ResearchLiveDetail | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [covers, setCovers] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(true)
  const [actionPending, setActionPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const actionPendingRef = useRef(false)
  const coversRef = useRef<Record<string, string | null>>({})
  const pendingCoverIdsRef = useRef(new Set<string>())
  const detailRequestRef = useRef(0)
  const detailVersionsRef = useRef<Record<string, string>>({})
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId
  coversRef.current = covers

  const loadJobs = useCallback(async (preserveSelection = true): Promise<ResearchJob[]> => {
    const next = await window.api.research.list()
    setJobs(next)
    setOpenTabIds((current) => {
      const available = new Set(next.map((job) => job.id))
      const retained = current.filter((id) => available.has(id))
      const active = next
        .filter((job) => !['completed', 'error', 'archived'].includes(job.status))
        .map((job) => job.id)
      return Array.from(new Set([...active, ...retained]))
    })
    setSelectedId((current) => {
      if (!preserveSelection) return null
      if (current === null) return null
      return next.some((job) => job.id === current) ? current : null
    })
    return next
  }, [])

  const loadDetail = useCallback(async (id: string, force = false) => {
    const request = ++detailRequestRef.current
    const next = await window.api.research.poll(id, force ? undefined : detailVersionsRef.current[id])
    detailVersionsRef.current[id] = next.version
    if (next.detail && request === detailRequestRef.current && selectedRef.current === id) {
      setDetail(next.detail)
      setJobs((current) => current.map((job) => job.id === next.detail!.job.id ? next.detail!.job : job))
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
    let firstLoad = true
    const poll = async (): Promise<void> => {
      try {
        const next = await loadDetail(selectedId, firstLoad)
        firstLoad = false
        if (cancelled) return
        const activeStatus = next.running || !['completed', 'paused', 'archived'].includes(next.status)
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

  const requestCovers = useCallback((ids: string[]): void => {
    if (!active) return
    const missing = ids.filter((id) =>
      !(id in coversRef.current) && !pendingCoverIdsRef.current.has(id)
    )
    if (missing.length === 0) return
    for (const id of missing) pendingCoverIdsRef.current.add(id)
    void Promise.all(missing.map(async (id) => {
      try {
        return [id, await window.api.research.coverDataUrl(id)] as const
      } catch {
        return [id, null] as const
      }
    })).then((entries) => {
      setCovers((current) => {
        const next = { ...current, ...Object.fromEntries(entries) }
        coversRef.current = next
        return next
      })
    }).finally(() => {
      for (const id of missing) pendingCoverIdsRef.current.delete(id)
    })
  }, [active])

  const runningCount = useMemo(
    () => jobs.filter((job) => !['completed', 'paused', 'error', 'archived'].includes(job.status)).length,
    [jobs]
  )
  const openJobs = useMemo(
    () => openTabIds.map((id) => jobs.find((job) => job.id === id)).filter((job): job is ResearchJob => Boolean(job)),
    [jobs, openTabIds]
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
        await loadDetail(selectedRef.current, true)
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
      setOpenTabIds((current) => [job.id, ...current.filter((id) => id !== job.id)])
      setSelectedId(job.id)
      setSurface('workspace')
    })
  }

  function openJob(id: string): void {
    setOpenTabIds((current) => current.includes(id) ? current : [...current, id])
    setSelectedId(id)
    setSurface('workspace')
  }

  function closeTab(id: string): void {
    const index = openTabIds.indexOf(id)
    const remaining = openTabIds.filter((candidate) => candidate !== id)
    setOpenTabIds(remaining)
    if (selectedId === id) {
      setSelectedId(remaining[index] ?? remaining[index - 1] ?? null)
    }
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

      {surface === 'workspace' && openJobs.length > 0 && (
        <nav className="research-tabs" aria-label="Open research tabs">
          <div>
            {openJobs.map((job) => (
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
          <ResearchLibrary jobs={jobs} covers={covers} onNeedCovers={requestCovers} onSelect={openJob} />
        ) : selectedId ? (
          detail?.job.id === selectedId ? (
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
          ) : (
            <div className="research-page-loading" role="status"><i aria-hidden="true" /><span>Loading research…</span></div>
          )
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
