import { useEffect, useMemo, useState } from 'react'
import type {
  Mission,
  MissionEvent,
  MissionRiskLevel,
  MissionStep,
  MissionStepStatus,
  MissionTemplate
} from '../../../preload/index.d'

function label(value: string): string {
  return value
    .split(/[_-]/)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function shortId(value: string, size = 8): string {
  return value.length <= size + 3 ? value : `${value.slice(0, size)}...`
}

function relativeTime(ts?: number): string {
  if (!ts) return 'not available'
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function riskClass(risk: MissionRiskLevel): string {
  if (risk === 'low') return 'is-ok'
  if (risk === 'medium') return 'is-warning'
  return 'is-error'
}

function statusClass(status: MissionStepStatus | Mission['status']): string {
  if (status === 'completed') return 'is-ok'
  if (status === 'unsupported' || status === 'blocked') return 'is-info'
  if (status === 'failed' || status === 'cancelled') return 'is-error'
  if (status === 'ready' || status === 'draft') return 'is-warning'
  return 'is-muted'
}

function stepSummary(step: MissionStep): string {
  const actor = step.agentRole ? label(step.agentRole) : 'Observer'
  const agent = step.preferredAgentId ? ` via ${label(step.preferredAgentId)}` : ''
  return `${actor}${agent} / ${label(step.permissionMode)}`
}

export default function MissionCenter(): JSX.Element {
  const [templates, setTemplates] = useState<MissionTemplate[]>([])
  const [missions, setMissions] = useState<Mission[]>([])
  const [events, setEvents] = useState<MissionEvent[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    try {
      const [templateRows, missionRows] = await Promise.all([
        window.api.mission.listTemplates(),
        window.api.mission.list()
      ])
      setTemplates(templateRows)
      setMissions(missionRows)
      setSelectedTemplateId((current) => current ?? templateRows[0]?.id ?? null)
      setSelectedMissionId((current) => current ?? missionRows[0]?.id ?? null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!selectedMissionId) {
      setEvents([])
      return
    }
    void window.api.mission
      .listEvents(selectedMissionId)
      .then((rows) => {
        if (!cancelled) setEvents(rows)
      })
      .catch(() => {
        if (!cancelled) setEvents([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedMissionId])

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) ?? templates[0] ?? null,
    [selectedTemplateId, templates]
  )

  const selectedMission = useMemo(
    () => missions.find((mission) => mission.id === selectedMissionId) ?? missions[0] ?? null,
    [selectedMissionId, missions]
  )

  const createPreviewFromTemplate = async (template: MissionTemplate): Promise<void> => {
    setBusy(`template:${template.id}`)
    setError(null)
    try {
      const mission = await window.api.mission.createFromTemplate(template.id, {
        title: template.title,
        description: template.description,
        origin: 'agent_hub',
        metadata: { createdFrom: 'mission-center' }
      })
      if (mission) {
        const rows = await window.api.mission.list()
        setMissions(rows)
        setSelectedMissionId(mission.id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const createBlankPreview = async (): Promise<void> => {
    setBusy('blank')
    setError(null)
    try {
      const mission = await window.api.mission.createDraft({
        title: 'Custom preview mission',
        description: 'A blank in-memory Mission Engine draft for inspecting the Phase 32 skeleton.',
        origin: 'agent_hub',
        metadata: { createdFrom: 'mission-center' }
      })
      setMissions(await window.api.mission.list())
      setSelectedMissionId(mission.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mission-center">
      <div className="mission-hero">
        <div>
          <span>Agent OS foundation</span>
          <h2>Mission Center</h2>
          <p>Preview future multi-agent missions, steps, permissions, and handoffs without executing anything.</p>
        </div>
        <strong>Preview only</strong>
      </div>

      {error && <div className="mission-alert">{error}</div>}

      <div className="mission-safety-note">
        Mission Engine is currently a read-only planning skeleton. It does not call providers, write files, run tests,
        commit, push, or control terminals.
      </div>

      <div className="mission-layout">
        <section className="mission-panel">
          <div className="mission-panel-head">
            <div>
              <strong>Templates</strong>
              <span>{templates.length} preview workflows</span>
            </div>
            <button type="button" disabled={busy !== null} onClick={() => void createBlankPreview()}>
              {busy === 'blank' ? 'Creating...' : 'Blank preview'}
            </button>
          </div>
          <div className="mission-template-list">
            {templates.map((template) => (
              <div className={`mission-template-card ${selectedTemplate?.id === template.id ? 'is-active' : ''}`} key={template.id}>
                <button type="button" className="mission-template-main" onClick={() => setSelectedTemplateId(template.id)}>
                  <span>{template.title}</span>
                  <em>{template.description}</em>
                </button>
                <div className="mission-card-meta">
                  <span className={`settings-chip ${riskClass(template.riskLevel)}`}>{label(template.riskLevel)}</span>
                  <span className="settings-chip is-info">{template.steps.length} steps</span>
                </div>
                <div className="mission-template-actions">
                  <button type="button" onClick={() => setSelectedTemplateId(template.id)}>Inspect template</button>
                  <button
                    type="button"
                    className="is-primary"
                    disabled={busy !== null}
                    onClick={() => void createPreviewFromTemplate(template)}
                  >
                    {busy === `template:${template.id}` ? 'Creating...' : 'Create preview'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mission-panel">
          <div className="mission-panel-head">
            <div>
              <strong>Template detail</strong>
              <span>{selectedTemplate ? label(selectedTemplate.permissionMode) : 'No template selected'}</span>
            </div>
          </div>
          {selectedTemplate ? (
            <div className="mission-template-detail">
              <h3>{selectedTemplate.title}</h3>
              <p>{selectedTemplate.description}</p>
              <div className="mission-step-list">
                {selectedTemplate.steps.map((step, index) => (
                  <div className="mission-step-row" key={`${selectedTemplate.id}-${index}`}>
                    <div className="mission-step-index">{index + 1}</div>
                    <div>
                      <strong>{step.title}</strong>
                      <span>{label(step.kind)} / {label(step.status ?? (step.kind === 'execute' || step.kind === 'test' || step.kind === 'commit' ? 'unsupported' : 'pending'))}</span>
                      <p>{step.safePreview ?? 'Preview-only step. No execution is available in Phase 32.'}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="mission-empty-state">No templates are registered yet.</div>
          )}
        </section>
      </div>

      <div className="mission-layout mission-layout-secondary">
        <section className="mission-panel">
          <div className="mission-panel-head">
            <div>
              <strong>Draft missions</strong>
              <span>{missions.length ? `${missions.length} in memory` : 'No draft missions yet'}</span>
            </div>
          </div>
          {missions.length === 0 ? (
            <div className="mission-empty-state">
              No draft missions yet. Create a preview mission from a template. Phase 32 does not execute missions.
            </div>
          ) : (
            <div className="mission-draft-list">
              {missions.map((mission) => (
                <button
                  type="button"
                  className={`mission-draft-row ${selectedMission?.id === mission.id ? 'is-active' : ''}`}
                  key={mission.id}
                  onClick={() => setSelectedMissionId(mission.id)}
                >
                  <span>{mission.title}</span>
                  <em>{shortId(mission.id)} / {label(mission.status)} / {relativeTime(mission.updatedAt)}</em>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="mission-panel mission-detail-panel">
          <div className="mission-panel-head">
            <div>
              <strong>Mission detail</strong>
              <span>{selectedMission ? `${selectedMission.steps.length} preview steps` : 'Nothing selected'}</span>
            </div>
          </div>
          {selectedMission ? (
            <div className="mission-detail">
              <div className="mission-detail-title">
                <div>
                  <h3>{selectedMission.title}</h3>
                  <p>{selectedMission.description ?? 'No description provided.'}</p>
                </div>
                <div className="mission-status-stack">
                  <span className={`settings-chip ${statusClass(selectedMission.status)}`}>{label(selectedMission.status)}</span>
                  <span className={`settings-chip ${riskClass(selectedMission.riskLevel)}`}>{label(selectedMission.riskLevel)}</span>
                  <span className="settings-chip is-info">{label(selectedMission.permissionMode)}</span>
                </div>
              </div>

              <div className="mission-readonly-grid">
                <div><span>Mission id</span><strong>{shortId(selectedMission.id, 12)}</strong></div>
                <div><span>Origin</span><strong>{label(selectedMission.origin)}</strong></div>
                <div><span>Created</span><strong>{relativeTime(selectedMission.createdAt)}</strong></div>
                <div><span>Updated</span><strong>{relativeTime(selectedMission.updatedAt)}</strong></div>
              </div>

              <div className="mission-timeline">
                {selectedMission.steps.map((step) => (
                  <div className="mission-timeline-row" key={step.id}>
                    <div className="mission-step-index">{step.index + 1}</div>
                    <div>
                      <div className="mission-step-title">
                        <strong>{step.title}</strong>
                        <span className={`settings-chip ${statusClass(step.status)}`}>{label(step.status)}</span>
                      </div>
                      <em>{label(step.kind)} / {stepSummary(step)}</em>
                      <p>{step.safePreview ?? 'Preview-only mission step.'}</p>
                      {step.dependsOn?.length ? <small>Depends on {step.dependsOn.map((id) => shortId(id, 6)).join(', ')}</small> : null}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mission-events">
                <strong>Safe event metadata</strong>
                {events.length === 0 ? (
                  <span>No mission events recorded yet.</span>
                ) : (
                  events.map((event) => (
                    <div className="mission-event-row" key={event.id}>
                      <span>{label(event.type)}</span>
                      <em>{event.message} / {relativeTime(event.timestamp)}</em>
                    </div>
                  ))
                )}
              </div>

              {selectedMission.notes?.length ? (
                <div className="mission-note-list">
                  {selectedMission.notes.map((note) => <span key={note}>{note}</span>)}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mission-empty-state">
              Select a preview mission to inspect the step timeline, risk badges, and in-memory event metadata.
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
