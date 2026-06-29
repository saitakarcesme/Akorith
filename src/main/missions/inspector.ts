import { ipcMain } from 'electron'
import { missionEngine } from './engine'
import {
  isMissionOrigin,
  isMissionPermissionMode,
  type Mission,
  type MissionCreateInput,
  type MissionEvent,
  type MissionPreviewPlan,
  type MissionTemplate
} from './types'

const VALID_ID = /^[\w-]{1,120}$/

function cleanText(value: unknown, max: number, allowNewline = false): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, max)
  if (!trimmed || /[\0]/.test(trimmed)) return undefined
  if (!allowNewline && /[\r\n]/.test(trimmed)) return undefined
  return trimmed
}

function cleanMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const json = JSON.stringify(value)
    if (json.length > 4000) return undefined
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function parseCreateInput(value: unknown): MissionCreateInput {
  const args = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const origin = isMissionOrigin(args.origin) ? args.origin : undefined
  const permissionMode = isMissionPermissionMode(args.permissionMode) ? args.permissionMode : undefined
  return {
    title: cleanText(args.title, 120),
    description: cleanText(args.description, 2000, true),
    projectPath: cleanText(args.projectPath, 2000),
    origin,
    permissionMode,
    metadata: cleanMetadata(args.metadata)
  }
}

function cleanId(value: unknown): string | null {
  return typeof value === 'string' && VALID_ID.test(value) ? value : null
}

export function registerMissionIpc(): void {
  ipcMain.handle('mission:listTemplates', (): MissionTemplate[] => missionEngine.listTemplates())

  ipcMain.handle('mission:createDraft', (_event, args: unknown): Mission =>
    missionEngine.createDraftMission(parseCreateInput(args))
  )

  ipcMain.handle('mission:createFromTemplate', (_event, args: unknown): Mission | null => {
    const payload = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
    const templateId = cleanId(payload.templateId)
    if (!templateId) throw new Error('invalid mission:createFromTemplate payload')
    return missionEngine.createMissionFromTemplate(templateId, parseCreateInput(payload.input))
  })

  ipcMain.handle('mission:list', (): Mission[] => missionEngine.listMissions())

  ipcMain.handle('mission:get', (_event, args: { id?: unknown }): Mission | null => {
    const id = cleanId(args?.id)
    return id ? missionEngine.getMission(id) : null
  })

  ipcMain.handle('mission:listEvents', (_event, args: { missionId?: unknown }): MissionEvent[] => {
    const id = cleanId(args?.missionId)
    return id ? missionEngine.listMissionEvents(id) : []
  })

  ipcMain.handle('mission:createSafePreviewPlan', (_event, args: unknown): MissionPreviewPlan =>
    missionEngine.createSafePreviewPlan(parseCreateInput(args))
  )
}
