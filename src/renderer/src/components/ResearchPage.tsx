import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  CreateResearchJobInput,
  ProviderInfo,
  ResearchEssayPreview,
  ResearchJob,
  ResearchLiveDetail,
  ResearchOutputFormat
} from '../../../preload/index.d'
import { useDocumentVisible } from '../documentVisibility'
import '../research-autoresearch.css'
import { CloseIcon, PlusIcon } from './icons'
import ResearchComposer from './ResearchComposer'
import ResearchLibrary from './ResearchLibrary'
import ResearchProgress from './ResearchProgress'

interface ResearchPageProps {
  active: boolean
}

type ResearchSurface = 'workspace' | 'library'

const ACTIVE_RESEARCH_STATUSES = new Set<ResearchJob['status']>([
  'draft',
  'planning',
  'researching',
  'verifying',
  'synthesizing',
  'exporting'
])
const AUTO_OPEN_RESEARCH_STATUSES = new Set<ResearchJob['status']>([
  ...ACTIVE_RESEARCH_STATUSES,
  'paused'
])

function sameResearchJobs(current: ResearchJob[], next: ResearchJob[]): boolean {
  if (current.length !== next.length) return false
  for (let index = 0; index < current.length; index += 1) {
    const left = current[index]
    const right = next[index]
    if (
      left.id !== right.id ||
      left.updatedAt !== right.updatedAt ||
      left.revision !== right.revision ||
      left.status !== right.status ||
      left.sourceCount !== right.sourceCount ||
      left.artifactPath !== right.artifactPath ||
      left.coverPath !== right.coverPath
    ) return false
  }
  return true
}

export default function ResearchPage({ active }: ResearchPageProps): JSX.Element {
  const documentVisible = useDocumentVisible()
  const [surface, setSurface] = useState<ResearchSurface>('workspace')
  const [jobs, setJobs] = useState<ResearchJob[]>([])
  const [openTabIds, setOpenTabIds] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ResearchLiveDetail | null>(null)
  const [essayPreviews, setEssayPreviews] = useState<Record<string, ResearchEssayPreview | null>>({})
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [covers, setCovers] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(true)
  const [actionPending, setActionPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const actionPendingRef = useRef(false)
  const coversRef = useRef<Record<string, string | null>>({})
  const pendingCoverIdsRef = useRef(new Set<string>())
  const pendingEssayKeysRef = useRef(new Set<string>())
  const detailRequestRef = useRef(0)
  const detailVersionsRef = useRef<Record<string, string>>({})
  const selectedRef = useRef<string | null>(null)
  const jobsLoadedRef = useRef(false)
  selectedRef.current = selectedId
  coversRef.current = covers

  const loadJobs = useCallback(async (preserveSelection = true): Promise<ResearchJob[]> => {
    const next = await window.api.research.list()
    setJobs((current) => sameResearchJobs(current, next) ? current : next)
    setOpenTabIds((current) => {
      const available = new Set<string>()
      const activeIds: string[] = []
      for (const job of next) {
        available.add(job.id)
        if (AUTO_OPEN_RESEARCH_STATUSES.has(job.status)) activeIds.push(job.id)
      }
      const retained = current.filter((id) => available.has(id))
      const merged = Array.from(new Set([...activeIds, ...retained]))
      return merged.length === current.length && merged.every((id, index) => id === current[index])
        ? current
        : merged
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
    if (!active || !documentVisible || providers) return
    let cancelled = false
    void window.api.chat.listProviders()
      .then((next) => { if (!cancelled) setProviders(next) })
      .catch((nextError) => { if (!cancelled) setError(errorMessage(nextError)) })
    return () => { cancelled = true }
  }, [active, documentVisible, providers])

  useEffect(() => {
    if (!active || !documentVisible) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    if (!jobsLoadedRef.current) setLoading(true)
    const refresh = async (): Promise<void> => {
      let nextDelay = 10_000
      try {
        const next = await loadJobs()
        nextDelay = next.some((job) => ACTIVE_RESEARCH_STATUSES.has(job.status)) ? 5_000 : 30_000
        if (!cancelled) {
          jobsLoadedRef.current = true
          setLoading(false)
        }
      } catch (nextError) {
        if (!cancelled) {
          setLoading(false)
          setError(errorMessage(nextError))
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), nextDelay)
      }
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [active, documentVisible, loadJobs])

  useEffect(() => {
    if (!active || !selectedId) {
      setDetail(null)
      return
    }
    if (!documentVisible) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let firstLoad = true
    const poll = async (): Promise<void> => {
      try {
        const next = await loadDetail(selectedId, firstLoad)
        firstLoad = false
        if (cancelled) return
        const activeStatus = next.running || ACTIVE_RESEARCH_STATUSES.has(next.status)
        const nextDelay = activeStatus
          ? 1_500
          : next.status === 'completed' || next.status === 'archived'
            ? 30_000
            : 6_000
        timer = setTimeout(() => void poll(), nextDelay)
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
  }, [active, documentVisible, loadDetail, selectedId])

  const selectedEssayKey = detail && selectedId === detail.job.id
    ? `${detail.job.id}:${detail.job.revision}`
    : null

  useEffect(() => {
    if (!active || !documentVisible || !detail || detail.job.id !== selectedId) return
    if (!['completed', 'archived'].includes(detail.job.status)) return
    const key = `${detail.job.id}:${detail.job.revision}`
    if (Object.prototype.hasOwnProperty.call(essayPreviews, key) || pendingEssayKeysRef.current.has(key)) return
    let cancelled = false
    pendingEssayKeysRef.current.add(key)
    void window.api.research.essay(detail.job.id)
      .then((essay) => {
        if (!cancelled) setEssayPreviews((current) => ({ ...current, [key]: essay }))
      })
      .catch((nextError) => {
        if (!cancelled) {
          setEssayPreviews((current) => ({ ...current, [key]: null }))
          setError(errorMessage(nextError))
        }
      })
      .finally(() => pendingEssayKeysRef.current.delete(key))
    return () => { cancelled = true }
  }, [active, detail, documentVisible, essayPreviews, selectedId])

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
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs])
  const openJobs = useMemo(() => {
    const result: ResearchJob[] = []
    for (const id of openTabIds) {
      const job = jobsById.get(id)
      if (job) result.push(job)
    }
    return result
  }, [jobsById, openTabIds])

  const runAction = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
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
  }, [loadDetail, loadJobs])

  const createResearch = useCallback(async (input: CreateResearchJobInput): Promise<boolean> => {
    return runAction(async () => {
      const job = await window.api.research.create(input)
      selectedRef.current = job.id
      setOpenTabIds((current) => [job.id, ...current.filter((id) => id !== job.id)])
      setSelectedId(job.id)
      setSurface('workspace')
    })
  }, [runAction])

  const openJob = useCallback((id: string): void => {
    setOpenTabIds((current) => current.includes(id) ? current : [...current, id])
    setSelectedId(id)
    setSurface('workspace')
  }, [])

  const pauseSelected = useCallback(async (): Promise<void> => {
    const id = selectedRef.current
    if (id) await runAction(() => window.api.research.pause(id))
  }, [runAction])

  const resumeSelected = useCallback(async (): Promise<void> => {
    const id = selectedRef.current
    if (id) await runAction(() => window.api.research.resume(id))
  }, [runAction])

  const exportSelected = useCallback(async (format: ResearchOutputFormat): Promise<void> => {
    const id = selectedRef.current
    if (id) await runAction(() => window.api.research.export(id, format))
  }, [runAction])

  const openArtifact = useCallback(async (id: string): Promise<void> => {
    await runAction(() => window.api.research.openArtifact(id))
  }, [runAction])

  const revealArtifact = useCallback(async (id: string): Promise<void> => {
    await runAction(() => window.api.research.revealArtifact(id))
  }, [runAction])

  const openSource = useCallback(async (id: string): Promise<void> => {
    await runAction(() => window.api.research.openSource(id))
  }, [runAction])

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
          <button id="research-workspace-tab" type="button" role="tab" aria-controls="research-view-panel" aria-selected={surface === 'workspace'} tabIndex={surface === 'workspace' ? 0 : -1} className={surface === 'workspace' ? 'is-active' : ''} onClick={() => setSurface('workspace')} onKeyDown={handleSurfaceKeyDown}>Autoresearch</button>
          <button id="research-library-tab" type="button" role="tab" aria-controls="research-view-panel" aria-selected={surface === 'library'} tabIndex={surface === 'library' ? 0 : -1} className={surface === 'library' ? 'is-active' : ''} onClick={() => setSurface('library')} onKeyDown={handleSurfaceKeyDown}>Library <span>{jobs.length}</span></button>
        </div>
        <div className="research-toolbar-status" role="status" aria-live="polite"><i aria-hidden="true" />{runningCount > 0 ? `${runningCount} running` : 'Ready'}</div>
        <button
          type="button"
          className="research-new-tab"
          onClick={() => { setSelectedId(null); setSurface('workspace') }}
        >
          <PlusIcon size={15} /> New run
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
              essay={selectedEssayKey ? essayPreviews[selectedEssayKey] : undefined}
              actionPending={actionPending}
              onPause={pauseSelected}
              onResume={resumeSelected}
              onExport={exportSelected}
              onOpenArtifact={openArtifact}
              onRevealArtifact={revealArtifact}
              onOpenSource={openSource}
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
