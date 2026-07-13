import { randomUUID } from 'crypto'
import type { Mission, MissionEvent, MissionId, MissionStatus, MissionStep } from './types'

const MAX_EVENTS_PER_MISSION = 200

function cloneMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  try {
    return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>
  } catch {
    return { ...metadata }
  }
}

function cloneStep(step: MissionStep): MissionStep {
  return {
    ...step,
    dependsOn: step.dependsOn ? [...step.dependsOn] : undefined,
    metadata: cloneMetadata(step.metadata)
  }
}

function cloneMission(mission: Mission): Mission {
  return {
    ...mission,
    steps: mission.steps.map(cloneStep),
    metadata: cloneMetadata(mission.metadata),
    notes: mission.notes ? [...mission.notes] : undefined
  }
}

function cloneEvent(event: MissionEvent): MissionEvent {
  return {
    ...event,
    metadata: cloneMetadata(event.metadata)
  }
}

export class MissionStore {
  private readonly missions = new Map<MissionId, Mission>()
  private readonly events = new Map<MissionId, MissionEvent[]>()

  createMission(mission: Mission): Mission {
    this.missions.set(mission.id, cloneMission(mission))
    this.appendEvent({
      missionId: mission.id,
      type: 'created',
      message: 'Draft mission preview created in memory. No execution was started.',
      metadata: { status: mission.status, origin: mission.origin, previewOnly: true }
    })
    return cloneMission(mission)
  }

  listMissions(): Mission[] {
    return [...this.missions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(cloneMission)
  }

  getMission(id: MissionId): Mission | null {
    const mission = this.missions.get(id)
    return mission ? cloneMission(mission) : null
  }

  updateMissionStatus(id: MissionId, status: MissionStatus): Mission | null {
    const current = this.missions.get(id)
    if (!current) return null
    const updated: Mission = {
      ...current,
      status,
      updatedAt: Date.now(),
      steps: current.steps.map(cloneStep),
      metadata: cloneMetadata(current.metadata),
      notes: current.notes ? [...current.notes] : undefined
    }
    this.missions.set(id, updated)
    this.appendEvent({
      missionId: id,
      type: 'status_changed',
      message: `Mission status changed to ${status}.`,
      metadata: { status }
    })
    return cloneMission(updated)
  }

  appendEvent(input: {
    missionId: MissionId
    stepId?: string
    type: string
    message: string
    timestamp?: number
    metadata?: Record<string, unknown>
  }): MissionEvent {
    const event: MissionEvent = {
      id: randomUUID(),
      missionId: input.missionId,
      stepId: input.stepId,
      type: input.type,
      message: input.message,
      timestamp: input.timestamp ?? Date.now(),
      metadata: cloneMetadata(input.metadata)
    }
    const list = this.events.get(input.missionId) ?? []
    list.push(event)
    if (list.length > MAX_EVENTS_PER_MISSION) list.splice(0, list.length - MAX_EVENTS_PER_MISSION)
    this.events.set(input.missionId, list)
    return cloneEvent(event)
  }

  listEvents(missionId: MissionId): MissionEvent[] {
    return (this.events.get(missionId) ?? []).map(cloneEvent)
  }
}

export const missionStore = new MissionStore()
