import { dialog, ipcMain } from 'electron'
import { AGENT_TEMPLATES } from './templates'
import { PERMISSION_MODES, describePermission } from './permissions'
import { createAgent, getAgent, listAgents, updateAgent, deleteAgent, type CreateAgentInput } from './store'
import { listRuns, listEvents, listArtifacts, getRun } from './runs'
import { planAgent } from './planner'
import { runAgent } from './executor'

// Phase 52: typed IPC for Agents. Actions are permissioned and logged.

export function registerActionAgentIpc(): void {
  ipcMain.handle('actionAgent:templates', () =>
    AGENT_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      icon: t.icon,
      category: t.category,
      defaultPermission: t.defaultPermission,
      allowCommands: t.allowCommands,
      needsRoot: t.needsRoot,
      note: t.note
    }))
  )
  ipcMain.handle('actionAgent:permissionModes', () =>
    PERMISSION_MODES.map((m) => ({ id: m, description: describePermission(m) }))
  )

  ipcMain.handle('actionAgent:list', () => listAgents())
  ipcMain.handle('actionAgent:get', (_e, id: string) => getAgent(id))
  ipcMain.handle('actionAgent:create', (_e, input: CreateAgentInput) => {
    if (!input || typeof input.name !== 'string') throw new Error('invalid agent input')
    return createAgent(input)
  })
  ipcMain.handle('actionAgent:update', (_e, id: string, patch: Record<string, unknown>) => updateAgent(id, patch))
  ipcMain.handle('actionAgent:delete', (_e, id: string) => {
    deleteAgent(id)
    return true
  })

  ipcMain.handle('actionAgent:plan', async (_e, id: string, input?: string) => {
    const agent = getAgent(id)
    if (!agent) throw new Error('agent not found')
    return planAgent(agent, input)
  })
  ipcMain.handle('actionAgent:run', async (_e, id: string, input?: string) => runAgent(id, input))

  ipcMain.handle('actionAgent:listRuns', (_e, id: string) => listRuns(id))
  ipcMain.handle('actionAgent:getRun', (_e, runId: string) => ({
    run: getRun(runId),
    events: listEvents(runId),
    artifacts: listArtifacts(runId)
  }))

  ipcMain.handle('actionAgent:pickFolder', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })
}
