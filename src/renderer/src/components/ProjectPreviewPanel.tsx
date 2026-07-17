import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { ProjectPreviewInspection, ProjectPreviewStatus } from '../../../preload/index.d'
import { FolderOpenIcon, GlobeIcon, PanelsIcon, PlayIcon, StopIcon } from './icons'

interface ProjectPreviewPanelProps {
  projectPath: string
  projectName: string
}

interface FrameState {
  dataUrl: string
  width: number
  height: number
}

export function ProjectPreviewPanel({ projectPath, projectName }: ProjectPreviewPanelProps): JSX.Element {
  const [inspection, setInspection] = useState<ProjectPreviewInspection | null>(null)
  const [session, setSession] = useState<ProjectPreviewStatus | null>(null)
  const [frame, setFrame] = useState<FrameState | null>(null)
  const [live, setLive] = useState(false)
  const [typing, setTyping] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pollingRef = useRef(false)
  const cursorRef = useRef<HTMLSpanElement>(null)
  const lastMoveRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    setInspection(null)
    setSession(null)
    setFrame(null)
    setLive(false)
    setError(null)
    void Promise.all([window.api.projectPreview.inspect(projectPath), window.api.projectPreview.active(projectPath)])
      .then(([nextInspection, activeSession]) => {
        if (cancelled) return
        setInspection(nextInspection)
        setSession(activeSession)
        setLive(Boolean(activeSession))
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [projectPath])

  useEffect(() => {
    if (!session || (session.state !== 'starting' && session.state !== 'running')) return
    let cancelled = false
    const refresh = async (): Promise<void> => {
      if (pollingRef.current) return
      pollingRef.current = true
      try {
        if (live) {
          const capture = await window.api.projectPreview.capture(session.id)
          if (!cancelled) {
            setSession(capture.status)
            if (capture.dataUrl) setFrame({ dataUrl: capture.dataUrl, width: capture.width, height: capture.height })
          }
        } else {
          const status = await window.api.projectPreview.status(session.id)
          if (!cancelled) setSession(status)
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        pollingRef.current = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), live ? 850 : 1600)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [live, session?.id, session?.state])

  const start = async (): Promise<void> => {
    setError(null)
    try {
      const next = await window.api.projectPreview.start(projectPath, inspection?.suggestedScript ?? undefined)
      setSession(next)
      setLive(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const stop = async (): Promise<void> => {
    if (!session) return
    const next = await window.api.projectPreview.stop(session.id)
    setSession(next)
    setLive(false)
  }

  const interact = async (event: MouseEvent<HTMLButtonElement>): Promise<void> => {
    if (!session || !frame) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - bounds.left) * (frame.width / bounds.width)
    const y = (event.clientY - bounds.top) * (frame.height / bounds.height)
    await window.api.projectPreview.input({ id: session.id, type: 'click', x, y })
  }

  const moveCursor = (event: MouseEvent<HTMLButtonElement>): void => {
    if (!session || !frame) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const relativeX = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left))
    const relativeY = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top))
    if (cursorRef.current) {
      cursorRef.current.style.transform = `translate(${relativeX}px, ${relativeY}px)`
      cursorRef.current.style.opacity = '1'
    }
    const now = performance.now()
    if (now - lastMoveRef.current < 80) return
    lastMoveRef.current = now
    const x = relativeX * (frame.width / bounds.width)
    const y = relativeY * (frame.height / bounds.height)
    void window.api.projectPreview.input({ id: session.id, type: 'move', x, y })
  }

  const sendText = async (): Promise<void> => {
    if (!session || !typing) return
    await window.api.projectPreview.input({ id: session.id, type: 'text', text: typing })
    setTyping('')
  }

  const running = session?.state === 'starting' || session?.state === 'running'
  const statusLabel = session?.state === 'starting' ? 'Starting' : session?.state === 'running' ? 'Live' : session?.state === 'error' ? 'Needs attention' : 'Ready'

  return (
    <section className={`project-preview ${live ? 'is-open' : ''}`} aria-label={`${projectName} live project preview`}>
      <div className="project-preview-bar">
        <div className="project-preview-title"><span className={`project-preview-dot is-${session?.state ?? 'ready'}`} /><div><strong>Computer Use</strong><span>{statusLabel}{session?.url ? ` · ${session.url}` : ` · ${inspection?.note ?? 'Inspecting project…'}`}</span></div></div>
        <div className="project-preview-actions">
          <button type="button" title="Show project in Finder" aria-label="Show project in Finder" onClick={() => void window.api.projectPreview.reveal(projectPath)}><FolderOpenIcon size={14} /></button>
          {session?.url && <button type="button" title="Open project in browser" aria-label="Open project in browser" onClick={() => void window.api.projectPreview.open(session.id)}><GlobeIcon size={14} /></button>}
          {running && <button type="button" className={live ? 'is-active' : ''} title={live ? 'Hide live stream' : 'Show live stream'} aria-label={live ? 'Hide live stream' : 'Show live stream'} onClick={() => setLive((value) => !value)}><PanelsIcon size={14} /></button>}
          {running
            ? <button type="button" className="is-stop" title="Stop project" aria-label="Stop project" onClick={() => void stop()}><StopIcon size={13} /></button>
            : <button type="button" className="is-run" disabled={!inspection?.runnable} title="Run project" aria-label="Run project" onClick={() => void start()}><PlayIcon size={13} /></button>}
        </div>
      </div>
      {live && running && <div className="project-preview-stage">
        {frame ? <button type="button" className="project-preview-frame" title="Click to interact with the running project" onMouseMove={moveCursor} onMouseLeave={() => { if (cursorRef.current) cursorRef.current.style.opacity = '0' }} onClick={(event) => void interact(event)}><img src={frame.dataUrl} alt={`Live view of ${projectName}`} /><span ref={cursorRef} className="project-preview-cursor" aria-hidden="true" /></button> : <div className="project-preview-loading"><span />Waiting for the first live frame…</div>}
        {frame && <form className="project-preview-type" onSubmit={(event) => { event.preventDefault(); void sendText() }}><input value={typing} onChange={(event) => setTyping(event.target.value)} placeholder="Type into the focused field…" aria-label="Text to type into live project" /><button type="submit" disabled={!typing}>Type</button></form>}
        <p>Click the stream to focus controls, then type or open the project for full control. Only this project’s loopback URL is visible.</p>
      </div>}
      {(error || session?.error) && <div className="project-preview-error">{error ?? session?.error}</div>}
    </section>
  )
}
