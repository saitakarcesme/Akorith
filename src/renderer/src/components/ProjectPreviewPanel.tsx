import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react'
import type { ProjectPreviewInspection, ProjectPreviewStatus } from '../../../preload/index.d'
import { FolderOpenIcon, GlobeIcon, PanelsIcon, PlayIcon, StopIcon } from './icons'

interface ProjectPreviewPanelProps {
  projectPath: string
  projectName: string
  /** Whether the owning route is currently visible. Hidden routes never capture frames. */
  active?: boolean
  hideWhenUnavailable?: boolean
  /** Re-inspect after a workspace turn/cycle may have added a runnable entry point. */
  refreshKey?: string | number
  variant?: 'compact' | 'workspace'
  title?: 'Browser' | 'Computer Use'
  interactive?: boolean
  /** Pointer/keyboard input can be enabled without showing the Computer Use text tray. */
  pointerInput?: boolean
}

interface FrameState {
  dataUrl: string
  width: number
  height: number
}

interface PreviewBounds {
  left: number
  top: number
  width: number
  height: number
}

const BROWSER_CAPTURE_INTERVAL_MS = 1_200
const COMPUTER_CAPTURE_INTERVAL_MS = 550
const STARTUP_STATUS_INTERVAL_MS = 1_600
const PREVIEW_SPECIAL_KEYS: Readonly<Record<string, string>> = {
  ' ': 'Space',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUp',
  Backspace: 'Backspace',
  Delete: 'Delete',
  End: 'End',
  Enter: 'Enter',
  Escape: 'Escape',
  Home: 'Home',
  PageDown: 'PageDown',
  PageUp: 'PageUp',
  Tab: 'Tab'
}

export interface PreviewPoint {
  x: number
  y: number
  displayX: number
  displayY: number
}

export function previewKeyForInput(input: {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): string | null {
  if (input.altKey || input.ctrlKey || input.metaKey) return null
  const special = PREVIEW_SPECIAL_KEYS[input.key]
  if (special) return input.shiftKey ? null : special
  return input.key.length === 1 && input.key >= ' ' && input.key !== '\u007f'
    ? input.key
    : null
}

export function previewWheelDelta(delta: number, mode: number, pageSize: number): number {
  if (!Number.isFinite(delta)) return 0
  const scale = mode === 1 ? 16 : mode === 2 ? Math.max(1, pageSize) : 1
  return Math.max(-1_200, Math.min(1_200, Math.round(delta * scale)))
}

/** Map pointer coordinates through the frame's CSS object-fit mode. */
export function mapPreviewPoint(
  bounds: PreviewBounds,
  frame: Pick<FrameState, 'width' | 'height'>,
  clientX: number,
  clientY: number,
  fit: 'contain' | 'fill' = 'contain'
): PreviewPoint | null {
  if (bounds.width <= 0 || bounds.height <= 0 || frame.width <= 0 || frame.height <= 0) return null
  const displayX = clientX - bounds.left
  const displayY = clientY - bounds.top
  if (displayX < 0 || displayX >= bounds.width || displayY < 0 || displayY >= bounds.height) return null
  if (fit === 'fill') {
    return {
      x: Math.min(frame.width - 1, Math.max(0, displayX / bounds.width * frame.width)),
      y: Math.min(frame.height - 1, Math.max(0, displayY / bounds.height * frame.height)),
      displayX,
      displayY
    }
  }
  const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height)
  const renderedWidth = frame.width * scale
  const renderedHeight = frame.height * scale
  const offsetX = (bounds.width - renderedWidth) / 2
  const offsetY = (bounds.height - renderedHeight) / 2
  if (
    displayX < offsetX ||
    displayX >= offsetX + renderedWidth ||
    displayY < offsetY ||
    displayY >= offsetY + renderedHeight
  ) return null
  return {
    x: Math.min(frame.width - 1, Math.max(0, (displayX - offsetX) / scale)),
    y: Math.min(frame.height - 1, Math.max(0, (displayY - offsetY) / scale)),
    displayX,
    displayY
  }
}

export function ProjectPreviewPanel({
  projectPath,
  projectName,
  active = true,
  hideWhenUnavailable = false,
  refreshKey,
  variant = 'compact',
  title = 'Computer Use',
  interactive = true,
  pointerInput = interactive
}: ProjectPreviewPanelProps): JSX.Element | null {
  const [inspection, setInspection] = useState<ProjectPreviewInspection | null>(null)
  const [session, setSession] = useState<ProjectPreviewStatus | null>(null)
  const [frame, setFrame] = useState<FrameState | null>(null)
  const [live, setLive] = useState(false)
  const [typing, setTyping] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pollingRef = useRef(false)
  const viewportBusyRef = useRef(false)
  const displayRef = useRef<HTMLDivElement>(null)
  const cursorRef = useRef<HTMLSpanElement>(null)
  const frameImageRef = useRef<HTMLImageElement>(null)
  const lastMoveRef = useRef(0)
  const frameGenerationRef = useRef(0)
  const projectRef = useRef(projectPath)
  const running = session?.state === 'starting' || session?.state === 'running'
  const workspaceVariant = variant === 'workspace'
  const pointerEnabled = interactive || pointerInput

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const projectChanged = projectRef.current !== projectPath
    projectRef.current = projectPath
    if (projectChanged) {
      setInspection(null)
      setSession(null)
      setFrame(null)
      setLive(false)
    }
    setError(null)
    void Promise.all([window.api.projectPreview.inspect(projectPath), window.api.projectPreview.active(projectPath)])
      .then(([nextInspection, activeSession]) => {
        if (cancelled) return
        setInspection(nextInspection)
        setSession((current) => activeSession ?? (projectChanged ? null : current))
        if (activeSession) setLive(true)
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [active, projectPath, refreshKey])

  useEffect(() => {
    if (!active || !session || (session.state !== 'starting' && session.state !== 'running')) return
    let cancelled = false
    let timer: number | null = null
    const interval = live
      ? pointerEnabled
        ? COMPUTER_CAPTURE_INTERVAL_MS
        : BROWSER_CAPTURE_INTERVAL_MS
      : STARTUP_STATUS_INTERVAL_MS
    const schedule = (): void => {
      if (cancelled) return
      timer = window.setTimeout(() => void refresh(), interval)
    }
    const refresh = async (): Promise<void> => {
      if (document.hidden || pollingRef.current || viewportBusyRef.current) {
        schedule()
        return
      }
      pollingRef.current = true
      try {
        if (live) {
          const generation = frameGenerationRef.current
          const capture = await window.api.projectPreview.capture(session.id)
          if (!cancelled) {
            setSession(capture.status)
            if (capture.dataUrl && generation === frameGenerationRef.current) {
              setFrame({ dataUrl: capture.dataUrl, width: capture.width, height: capture.height })
            }
          }
        } else {
          const status = await window.api.projectPreview.status(session.id)
          if (!cancelled) setSession(status)
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        pollingRef.current = false
        schedule()
      }
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [active, live, pointerEnabled, session?.id, session?.state])

  useEffect(() => {
    if (!workspaceVariant || !active || !live || !running || !session?.id) return
    const display = displayRef.current
    if (!display) return
    const sessionId = session.id
    let cancelled = false
    let resizeTimer: number | null = null
    let lastRequestedSize = ''

    const scheduleResize = (): void => {
      const bounds = display.getBoundingClientRect()
      const width = Math.round(bounds.width)
      const height = Math.round(bounds.height)
      if (width < 1 || height < 1) return
      const requestedSize = `${width}x${height}`
      if (requestedSize === lastRequestedSize) return
      lastRequestedSize = requestedSize
      const generation = ++frameGenerationRef.current
      viewportBusyRef.current = true
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null
        void (async () => {
          try {
            await window.api.projectPreview.setViewport(sessionId, width, height)
            if (cancelled || generation !== frameGenerationRef.current) return
            const capture = await window.api.projectPreview.capture(sessionId)
            if (cancelled || generation !== frameGenerationRef.current) return
            setSession(capture.status)
            if (capture.dataUrl) {
              setFrame({ dataUrl: capture.dataUrl, width: capture.width, height: capture.height })
            }
          } catch (reason) {
            if (!cancelled && generation === frameGenerationRef.current) {
              setError(reason instanceof Error ? reason.message : String(reason))
            }
          } finally {
            if (generation === frameGenerationRef.current) viewportBusyRef.current = false
          }
        })()
      }, 100)
    }

    const observer = new ResizeObserver(scheduleResize)
    observer.observe(display)
    scheduleResize()
    return () => {
      cancelled = true
      frameGenerationRef.current += 1
      viewportBusyRef.current = false
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      observer.disconnect()
    }
  }, [active, live, running, session?.id, workspaceVariant])

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

  const interact = async (event: MouseEvent<HTMLDivElement>): Promise<void> => {
    if (!session || !frame) return
    event.currentTarget.focus({ preventScroll: true })
    const bounds = frameImageRef.current?.getBoundingClientRect()
    if (!bounds) return
    const point = mapPreviewPoint(bounds, frame, event.clientX, event.clientY, workspaceVariant ? 'fill' : 'contain')
    if (!point) return
    await window.api.projectPreview.input({ id: session.id, type: 'click', x: point.x, y: point.y })
  }

  const sendPreviewKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!session) return
    const key = previewKeyForInput(event)
    if (!key) return
    event.preventDefault()
    event.stopPropagation()
    void window.api.projectPreview.input({ id: session.id, type: 'key', key }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const scrollPreview = (event: WheelEvent<HTMLDivElement>): void => {
    if (!session || !frame) return
    const bounds = frameImageRef.current?.getBoundingClientRect()
    if (!bounds) return
    const point = mapPreviewPoint(bounds, frame, event.clientX, event.clientY, workspaceVariant ? 'fill' : 'contain')
    if (!point) return
    const deltaX = previewWheelDelta(event.deltaX, event.deltaMode, bounds.width)
    const deltaY = previewWheelDelta(event.deltaY, event.deltaMode, bounds.height)
    if (deltaX === 0 && deltaY === 0) return
    event.preventDefault()
    event.stopPropagation()
    void window.api.projectPreview.input({
      id: session.id,
      type: 'wheel',
      x: point.x,
      y: point.y,
      deltaX,
      deltaY
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const moveCursor = (event: MouseEvent<HTMLDivElement>): void => {
    if (!session || !frame) return
    const bounds = frameImageRef.current?.getBoundingClientRect()
    if (!bounds) return
    const point = mapPreviewPoint(bounds, frame, event.clientX, event.clientY, workspaceVariant ? 'fill' : 'contain')
    if (!point) {
      if (cursorRef.current) cursorRef.current.style.opacity = '0'
      return
    }
    if (cursorRef.current) {
      const containerBounds = event.currentTarget.getBoundingClientRect()
      cursorRef.current.style.transform = `translate(${event.clientX - containerBounds.left}px, ${event.clientY - containerBounds.top}px)`
      cursorRef.current.style.opacity = '1'
    }
    const now = performance.now()
    if (now - lastMoveRef.current < 80) return
    lastMoveRef.current = now
    void window.api.projectPreview.input({ id: session.id, type: 'move', x: point.x, y: point.y })
  }

  const sendText = async (): Promise<void> => {
    if (!session || !typing) return
    await window.api.projectPreview.input({ id: session.id, type: 'text', text: typing })
    setTyping('')
  }

  const statusLabel = session?.state === 'starting' ? 'Starting' : session?.state === 'running' ? 'Live' : session?.state === 'error' ? 'Needs attention' : 'Ready'
  const addressLabel = session?.url ?? inspection?.note ?? `Inspecting ${projectName}…`

  if (hideWhenUnavailable && !session && !inspection?.runnable) return null

  return (
    <section className={`project-preview ${live ? 'is-open' : ''} is-${variant} ${pointerEnabled ? 'is-interactive' : 'is-readonly'}`} aria-label={`${projectName} live project preview`}>
      <div className="project-preview-bar">
        {workspaceVariant
          ? (
            <div className="project-preview-address" role="status" aria-live="polite">
              <span className={`project-preview-dot is-${session?.state ?? 'ready'}`} />
              {title === 'Browser' ? <GlobeIcon size={13} /> : <PanelsIcon size={13} />}
              <span className="project-preview-address-copy">
                <strong title={addressLabel}>{addressLabel}</strong>
                <small>{statusLabel}</small>
              </span>
            </div>
          )
          : <div className="project-preview-title"><span className={`project-preview-dot is-${session?.state ?? 'ready'}`} /><div><strong>{title}</strong><span>{statusLabel}{session?.url ? ` · ${session.url}` : ` · ${inspection?.note ?? 'Inspecting project…'}`}</span></div></div>}
        <div className="project-preview-actions">
          {!workspaceVariant && <button type="button" title="Show project in folder" aria-label="Show project in folder" onClick={() => void window.api.projectPreview.reveal(projectPath)}><FolderOpenIcon size={14} /></button>}
          {session?.url && <button type="button" title="Open project in browser" aria-label="Open project in browser" onClick={() => void window.api.projectPreview.open(session.id)}><GlobeIcon size={14} /></button>}
          {!workspaceVariant && running && <button type="button" className={live ? 'is-active' : ''} title={live ? 'Hide live stream' : 'Show live stream'} aria-label={live ? 'Hide live stream' : 'Show live stream'} onClick={() => setLive((value) => !value)}><PanelsIcon size={14} /></button>}
          {running
            ? <button type="button" className="is-stop" title="Stop project" aria-label="Stop project" onClick={() => void stop()}><StopIcon size={13} /></button>
            : <button type="button" className="is-run" disabled={!inspection?.runnable} title="Run project" aria-label="Run project" onClick={() => void start()}><PlayIcon size={13} /></button>}
        </div>
      </div>
      {!running && !error && !session?.error && (
        <div className="project-preview-empty">
          <span className="project-preview-empty-icon"><GlobeIcon size={20} /></span>
          <strong>{inspection ? `${title} is ready` : `Preparing ${title.toLowerCase()}`}</strong>
          <p>{inspection?.note ?? 'Akorith is inspecting this project for a safe local preview entry point.'}</p>
          <button type="button" disabled={!inspection?.runnable} onClick={() => void start()}>
            <PlayIcon size={13} />
            Run preview
          </button>
        </div>
      )}
      {live && running && <div className="project-preview-stage">
        <div ref={displayRef} className="project-preview-display">
          {frame
          ? pointerEnabled
            ? <div className="project-preview-frame" role="group" tabIndex={0} aria-label={`Interactive ${title} preview. Click to focus, then use the keyboard.`} title="Click to interact with the running project" onMouseMove={moveCursor} onMouseLeave={() => { if (cursorRef.current) cursorRef.current.style.opacity = '0' }} onClick={(event) => void interact(event)} onKeyDown={sendPreviewKey} onWheel={scrollPreview}><img ref={frameImageRef} src={frame.dataUrl} alt={`Live view of ${projectName}`} /><span ref={cursorRef} className="project-preview-cursor" aria-hidden="true" /></div>
            : <div className="project-preview-frame is-readonly"><img src={frame.dataUrl} alt={`Browser preview of ${projectName}`} /></div>
          : <div className="project-preview-loading"><span />Waiting for the first live frame…</div>}
        </div>
        {interactive && frame && <form className="project-preview-type" onSubmit={(event) => { event.preventDefault(); void sendText() }}><input value={typing} onChange={(event) => setTyping(event.target.value)} placeholder="Type into the focused field…" aria-label="Text to type into live project" /><button type="submit" disabled={!typing}>Type</button></form>}
        {!workspaceVariant && <p>{interactive
          ? 'Click the live frame to focus controls, then type below. Interaction stays inside this project’s verified loopback preview.'
          : 'Read-only browser stream from this project’s verified loopback URL. Use Computer Use when you want to click or type.'}</p>}
      </div>}
      {(error || session?.error) && <div className="project-preview-error">{error ?? session?.error}</div>}
    </section>
  )
}
