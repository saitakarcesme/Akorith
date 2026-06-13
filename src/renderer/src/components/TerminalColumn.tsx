import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ProjectRow } from '../../../preload/index.d'
import TerminalPane from './TerminalPane'
import { FolderIcon, PlusIcon } from './icons'

interface TerminalColumnProps {
  activeProject: ProjectRow | null
  onProjectSelected: (project: ProjectRow) => void
  onProjectsChange: () => void
}

function storageNumber(key: string, fallback: number): number {
  try {
    const item = localStorage.getItem(key)
    // Guard the empty/missing case: Number(null) is 0 (finite), which would
    // silently override the fallback — that bug opened the split at 0/100.
    if (item === null || item.trim() === '') return fallback
    const raw = Number(item)
    return Number.isFinite(raw) ? raw : fallback
  } catch {
    return fallback
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// Olympus/Atlantis split must stay sane: never tiny-vs-huge. Anything outside
// 30–70 (incl. a stale 0 from the old bug) resets to an even 50/50.
const SPLIT_MIN = 30
const SPLIT_MAX = 70
function sanitizeSplit(value: number): number {
  return value >= SPLIT_MIN && value <= SPLIT_MAX ? value : 50
}

// Stacked executor terminals: Olympus on top (t2), Atlantis on the bottom (t1).
// Each runs an independent interactive PTY keyed by its stable id.
export default function TerminalColumn({
  activeProject,
  onProjectSelected,
  onProjectsChange
}: TerminalColumnProps): JSX.Element {
  const columnRef = useRef<HTMLElement>(null)
  const [split, setSplit] = useState(() => sanitizeSplit(storageNumber('akorith.terminalSplit', 50)))
  const [width, setWidth] = useState(() => storageNumber('akorith.executionWidth', 560))
  const [projectName, setProjectName] = useState(activeProject?.name ?? '')
  const [busy, setBusy] = useState<'open' | 'create' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem('akorith.terminalSplit', String(split))
  }, [split])

  useEffect(() => {
    localStorage.setItem('akorith.executionWidth', String(width))
  }, [width])

  useEffect(() => {
    setProjectName(activeProject?.name ?? '')
  }, [activeProject?.name])

  const startSplitResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startY = event.clientY
    const startSplit = split
    const height = columnRef.current?.clientHeight ?? 1
    const move = (moveEvent: PointerEvent): void => {
      const delta = ((moveEvent.clientY - startY) / height) * 100
      setSplit(clamp(startSplit + delta, SPLIT_MIN, SPLIT_MAX))
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  const startWidthResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const move = (moveEvent: PointerEvent): void => {
      setWidth(clamp(startWidth + (startX - moveEvent.clientX), 420, 820))
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  const openProject = async (): Promise<void> => {
    setBusy('open')
    setError(null)
    try {
      const res = await window.api.projects.openFolder(activeProject?.id ?? null)
      if (res.ok) {
        onProjectSelected(res.project)
        onProjectsChange()
      } else if (!res.cancelled) {
        setError(res.error)
      }
    } finally {
      setBusy(null)
    }
  }

  const createProject = async (): Promise<void> => {
    const name = projectName.trim()
    if (!name) {
      setError('Enter a project name first.')
      return
    }
    setBusy('create')
    setError(null)
    try {
      const res = await window.api.projects.createFolder({ name, projectId: activeProject?.id ?? null })
      if (res.ok) {
        onProjectSelected(res.project)
        onProjectsChange()
      } else if (!res.cancelled) {
        setError(res.error)
      }
    } finally {
      setBusy(null)
    }
  }

  const hasProjectFolder = Boolean(activeProject?.path)

  return (
    <main className="terminal-column execution-column" ref={columnRef} style={{ flexBasis: width, width }}>
      <div className="execution-width-resizer" onPointerDown={startWidthResize} />
      {!hasProjectFolder ? (
        <section className="project-onboarding">
          <div className="project-onboarding-card">
            <div className="project-onboarding-icon">
              <FolderIcon size={22} />
            </div>
            <h2>{activeProject ? 'Connect a project folder' : 'Open a project to start agents'}</h2>
            <p>
              Akorith starts Olympus as Codex and Atlantis as Claude inside the selected project folder.
            </p>
            <div className="project-onboarding-actions">
              <button type="button" onClick={() => void openProject()} disabled={busy !== null}>
                <FolderIcon size={15} />
                {busy === 'open' ? 'Opening...' : 'Open Project'}
              </button>
            </div>
            <div className="project-create-inline">
              <input
                value={projectName}
                placeholder="New project name"
                onChange={(event) => setProjectName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createProject()
                }}
              />
              <button type="button" onClick={() => void createProject()} disabled={busy !== null || !projectName.trim()}>
                <PlusIcon size={15} />
                {busy === 'create' ? 'Creating...' : 'Create Project'}
              </button>
            </div>
            {activeProject && !activeProject.path && (
              <div className="project-onboarding-note">Selected project: {activeProject.name}</div>
            )}
            {error && <div className="project-onboarding-error">{error}</div>}
          </div>
        </section>
      ) : (
        <>
          <div className="execution-project-strip">
            <span>{activeProject!.name}</span>
            <em>{activeProject!.path}</em>
          </div>
          {/* Proportional grow (basis 0) so Olympus/Atlantis always divide the
              available column height by the split ratio — equal (50/50) by
              default, and honoring the user's drag — regardless of the fixed
              project strip + resizer heights. */}
          <div className="terminal-slot" style={{ flexGrow: split, flexBasis: 0 }}>
            <TerminalPane id="t2" title="Olympus" identity="olympus" cwd={activeProject!.path!} commandKind="codex" />
          </div>
          <div
            className="terminal-split-resizer"
            role="separator"
            aria-orientation="horizontal"
            onPointerDown={startSplitResize}
          />
          <div className="terminal-slot" style={{ flexGrow: 100 - split, flexBasis: 0 }}>
            <TerminalPane id="t1" title="Atlantis" identity="atlantis" cwd={activeProject!.path!} commandKind="claude" />
          </div>
        </>
      )}
    </main>
  )
}
